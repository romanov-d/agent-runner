import { Pool, type PoolClient, type QueryResultRow } from 'pg';

/**
 * Подключение к базе. Один пул на процесс.
 *
 * Отдельного слоя абстракции над SQL нет намеренно: запросы очереди - это
 * и есть суть проекта, прятать их за ORM значит прятать главное.
 */

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://runner:runner@localhost:5433/runner';

let pool: Pool | null = null;

export function db(): Pool {
  if (!pool) pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function query<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  client?: PoolClient,
): Promise<T[]> {
  const runner = client ?? db();
  const res = await runner.query<T>(sql, params as never[]);
  return res.rows;
}

export async function one<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  client?: PoolClient,
): Promise<T | null> {
  const rows = await query<T>(sql, params, client);
  return rows[0] ?? null;
}
