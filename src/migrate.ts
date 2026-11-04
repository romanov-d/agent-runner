import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db, closeDb } from './db.ts';

/**
 * Накат схемы. Миграции здесь одна, и файл идемпотентен (IF NOT EXISTS),
 * поэтому отдельная таблица версий пока не нужна. Появится вторая - заведём.
 */
const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(): Promise<void> {
  const sql = await readFile(join(here, '..', 'sql', '001_schema.sql'), 'utf8');
  await db().query(sql);
}

if (import.meta.filename === process.argv[1]) {
  await migrate();
  console.log('схема накачена');
  await closeDb();
}
