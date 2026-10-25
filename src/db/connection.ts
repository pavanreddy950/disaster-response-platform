import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url));

/** Opens (or creates) the database and applies the idempotent schema. */
export function openDatabase(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma('journal_mode = WAL'); // concurrent readers while writing
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(readFileSync(schemaPath, 'utf8'));
  return db;
}
