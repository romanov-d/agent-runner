-- Схема очереди запусков агентов.
--
-- Одна таблица задач, одна таблица шагов, одна таблица аудита.
-- Больше ничего не нужно: состояние задачи целиком лежит в строке,
-- поэтому захват, пульс и завершение делаются одним UPDATE без транзакций.
-- Почему без транзакций - docs/adr/0002-one-statement-per-operation.md

CREATE TABLE IF NOT EXISTS jobs (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind            TEXT        NOT NULL,              -- что исполнять: имя обработчика
  payload         JSONB       NOT NULL DEFAULT '{}', -- постановка задачи
  agent           TEXT        NOT NULL DEFAULT 'default', -- какой агент её возьмёт

  status          TEXT        NOT NULL DEFAULT 'queued',  -- queued|running|done|failed|cancelled
  priority        INT         NOT NULL DEFAULT 100,       -- меньше число - раньше очередь
  run_after       TIMESTAMPTZ NOT NULL DEFAULT now(),     -- не брать раньше этого времени
  deadline        TIMESTAMPTZ,                            -- после него задача бессмысленна

  attempts        INT         NOT NULL DEFAULT 0,
  max_attempts    INT         NOT NULL DEFAULT 3,

  locked_by       TEXT,                                   -- кто сейчас держит
  locked_at       TIMESTAMPTZ,                            -- последний пульс
  idempotency_key TEXT,                                   -- повторная постановка не создаёт дубль

  result          JSONB,
  error           TEXT,
  cost            JSONB       NOT NULL DEFAULT '{}',      -- накапливается по попыткам
  progress        INT         NOT NULL DEFAULT 0,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Повторная постановка с тем же ключом не создаёт вторую задачу.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency_key_uniq
  ON jobs (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Индекс ровно под запрос захвата: только готовые к запуску, в порядке выдачи.
CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON jobs (priority, run_after, id) WHERE status = 'queued';

-- Индекс под поиск зависших.
CREATE INDEX IF NOT EXISTS jobs_running_idx
  ON jobs (locked_at) WHERE status = 'running';

-- Журнал шагов агента. Отдельной таблицей, а не текстовым полем в задаче:
-- шагов на задачу бывают сотни, и их читают выборочно.
CREATE TABLE IF NOT EXISTS job_steps (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id     BIGINT      NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt    INT         NOT NULL,
  seq        INT         NOT NULL,                  -- номер шага внутри попытки
  kind       TEXT        NOT NULL,                  -- model|tool|note|error
  name       TEXT,                                  -- имя инструмента или модели
  detail     JSONB       NOT NULL DEFAULT '{}',     -- секреты сюда не попадают, см. redact()
  cost       JSONB       NOT NULL DEFAULT '{}',
  ms         INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_steps_job_idx ON job_steps (job_id, attempt, seq);

-- Аудит необратимых действий: кто разрешил, что именно и когда.
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id     BIGINT      REFERENCES jobs(id) ON DELETE SET NULL,
  actor      TEXT        NOT NULL,                  -- agent:<имя> или human:<id>
  action     TEXT        NOT NULL,
  target     TEXT,
  decision   TEXT        NOT NULL,                  -- allowed|denied|approved
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);

-- Расписания. Два вида: script - запуск обработчика без модели, agent - запуск агента.
CREATE TABLE IF NOT EXISTS schedules (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          TEXT        NOT NULL UNIQUE,
  kind          TEXT        NOT NULL,               -- имя обработчика
  agent         TEXT        NOT NULL DEFAULT 'default',
  mode          TEXT        NOT NULL DEFAULT 'script', -- script|agent
  payload       JSONB       NOT NULL DEFAULT '{}',
  every_ms      BIGINT      NOT NULL,               -- период
  jitter_ratio  REAL        NOT NULL DEFAULT 0.1,   -- разброс, чтобы прогоны не слипались
  enabled       BOOLEAN     NOT NULL DEFAULT true,
  fails_in_row  INT         NOT NULL DEFAULT 0,
  pause_after   INT         NOT NULL DEFAULT 5,     -- автопауза после стольких сбоев подряд
  last_run_at   TIMESTAMPTZ,
  next_run_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
