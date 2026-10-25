import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url));

/**
 * Schema version stored in `PRAGMA user_version`.
 *   0/1: original schema (status CHECK without 'verified')
 *   2:   'verified' status + disaster_events audit table
 */
export const SCHEMA_VERSION = 2;

/** Opens (or creates) the database and brings its schema up to date. */
export function openDatabase(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma('journal_mode = WAL'); // concurrent readers while writing
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  applySchema(db);
  return db;
}

/** Runs pending migrations, then the idempotent schema (which creates anything new). */
export function applySchema(db: Database.Database): void {
  const schema = readFileSync(schemaPath, 'utf8');
  const version = db.pragma('user_version', { simple: true }) as number;
  const hasDisasters = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'disasters'").get();

  if (hasDisasters && version < 2) rebuildDisastersTable(db, schema);
  db.exec(schema);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

/**
 * v2 widens the `status` CHECK constraint. SQLite cannot alter a constraint in place, so the table is
 * rebuilt (the documented "12-step" procedure), keeping schema.sql as the single source of the new DDL:
 * drop the old indexes, rename the old table aside, let schema.sql create the new one, copy, drop.
 *
 * Foreign keys must be off: dropping the old table would otherwise cascade-delete every disaster_tags row.
 * `legacy_alter_table` stops the rename from rewriting disaster_tags' REFERENCES to point at the old copy.
 */
function rebuildDisastersTable(db: Database.Database, schema: string): void {
  const columns = (db.prepare("SELECT name FROM pragma_table_info('disasters')").all() as { name: string }[])
    .map((c) => `"${c.name}"`)
    .join(', ');
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'disasters' AND sql IS NOT NULL")
    .all() as { name: string }[];

  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = ON');
  try {
    db.transaction(() => {
      for (const { name } of indexes) db.exec(`DROP INDEX "${name}"`);
      db.exec('ALTER TABLE disasters RENAME TO disasters_v1');
      db.exec(schema);
      db.exec(`INSERT INTO disasters (${columns}) SELECT ${columns} FROM disasters_v1`);
      db.exec('DROP TABLE disasters_v1');
      const violations = db.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) throw new Error(`Migration to v2 left ${violations.length} foreign key violations`);
    })();
  } finally {
    db.pragma('legacy_alter_table = OFF');
    db.pragma('foreign_keys = ON');
  }
}
