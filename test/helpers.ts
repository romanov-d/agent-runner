import { db, closeDb, query } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';

/**
 * Тесты, которым нужна настоящая база.
 *
 * Поведение очереди проверяется только на живом Postgres: FOR UPDATE SKIP LOCKED
 * нельзя подделать мокой, а именно он и есть предмет проверки.
 */
export async function dbAvailable(): Promise<boolean> {
  try {
    await db().query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function resetDb(): Promise<void> {
  await migrate();
  await query('TRUNCATE jobs, job_steps, audit_log, schedules RESTART IDENTITY CASCADE');
}

export { closeDb };
