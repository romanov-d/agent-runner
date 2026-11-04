# Что делать, когда сломалось

Короткие инструкции под конкретные симптомы. Каждая начинается с того, как
отличить этот случай от похожего.

## Задачи копятся, воркеры простаивают

Проверить, видит ли воркер готовые задачи:

```sql
SELECT status, count(*) FROM jobs GROUP BY status;
SELECT min(run_after), now() FROM jobs WHERE status = 'queued';
```

Если `run_after` в будущем - это не сбой, а отложенные повторы. Посмотреть,
почему они отложены:

```sql
SELECT id, kind, attempts, error, run_after FROM jobs
WHERE status = 'queued' AND run_after > now() ORDER BY run_after LIMIT 20;
```

Если `run_after` в прошлом, а задачи стоят - воркер не работает. Смотреть его
лог: либо упал на старте, либо не смог подключиться к базе.

## Задача висит в работе и не двигается

```sql
SELECT id, kind, locked_by, locked_at, now() - locked_at AS без_пульса
FROM jobs WHERE status = 'running' ORDER BY locked_at;
```

Пульса нет дольше десяти минут - воркер мёртв, сторож вернёт её сам в течение
полуминуты. Ускорить:

```sql
UPDATE jobs SET status='queued', locked_by=NULL, locked_at=NULL, run_after=now()
WHERE id = $1 AND status = 'running';
```

Пульс идёт, а прогресса нет - воркер жив, но завис внутри обработчика. Смотреть
журнал шагов задачи: на каком шаге остановились.

```sql
SELECT seq, kind, name, ms, created_at FROM job_steps
WHERE job_id = $1 ORDER BY attempt, seq;
```

## Расход скакнул

Куда ушли деньги за сутки:

```sql
SELECT kind, count(*), round(sum((cost->>'usd')::numeric), 2) AS usd
FROM jobs WHERE created_at > now() - interval '1 day'
GROUP BY kind ORDER BY usd DESC;
```

Самые дорогие задачи:

```sql
SELECT id, kind, attempts, cost FROM jobs
WHERE created_at > now() - interval '1 day'
ORDER BY (cost->>'usd')::numeric DESC NULLS LAST LIMIT 20;
```

Частый случай: задача падает после ответа модели и повторяется три раза,
оплачивая каждую попытку. Видно по `attempts > 1` при большом расходе. Лечится
не лимитом, а разбором причины падения.

Срочно остановить конкретный вид задач:

```sql
UPDATE jobs SET status='cancelled', finished_at=now()
WHERE kind = $1 AND status IN ('queued','running');
```

## Провайдер моделей лёг

Задачи падают пачкой с одинаковой ошибкой. Проверить:

```sql
SELECT error, count(*) FROM jobs
WHERE status IN ('queued','failed') AND updated_at > now() - interval '15 min'
GROUP BY error ORDER BY count DESC LIMIT 5;
```

Повторы разведены джиттером, поэтому они не придут к провайдеру одной волной.
Если он лежит дольше, чем хватает попыток, задачи дойдут до `failed`. После
восстановления вернуть их:

```sql
UPDATE jobs SET status='queued', attempts=0, run_after=now(), error=NULL
WHERE status='failed' AND error LIKE '%timeout%' AND finished_at > now() - interval '1 hour';
```

## Агент просит подтверждения и стоит

Необратимое действие без подтверждения останавливает задачу намеренно. Что
именно просят:

```sql
SELECT job_id, actor, action, target, decision, created_at
FROM audit_log ORDER BY created_at DESC LIMIT 20;
```

Решение принимает человек. Разрешить - запустить задачу повторно с флагом
подтверждения в постановке.

## Выкатка новой версии

Остановка по `SIGTERM` корректна: воркер доделывает текущие задачи до крайнего
срока и возвращает остаток в очередь без траты попытки. Выкатывать можно под
нагрузкой.

Проверить, что никто не завис после выкатки:

```sql
SELECT locked_by, count(*) FROM jobs WHERE status='running' GROUP BY locked_by;
```

Имена воркеров, которых уже нет, - значит остановка прошла не до конца, задачи
подберёт сторож.

## Откат схемы

Миграция одна и идемпотентна. Если понадобится вторая, правило такое: сначала
выкатывается схема, совместимая со старым кодом, потом код, потом удаление
старых колонок отдельной миграцией. Между шагами - рабочий прод.
