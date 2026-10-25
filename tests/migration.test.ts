import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applySchema, SCHEMA_VERSION } from '../src/db/connection.js';
import { DisasterRepository } from '../src/modules/disasters/disaster.repository.js';

// The v1 disasters/disaster_tags DDL as originally shipped (status CHECK without 'verified', user_version 0).
const V1_SCHEMA = `
CREATE TABLE disasters (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, location_name TEXT,
  lat REAL CHECK (lat BETWEEN -90 AND 90), lng REAL CHECK (lng BETWEEN -180 AND 180),
  location_source TEXT NOT NULL DEFAULT 'unresolved' CHECK (location_source IN ('client', 'geocoded', 'unresolved')),
  status TEXT NOT NULL DEFAULT 'reported' CHECK (status IN ('reported', 'active', 'contained', 'resolved')),
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  CHECK ((lat IS NULL) = (lng IS NULL))
);
CREATE INDEX idx_disasters_live_created ON disasters (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_disasters_status ON disasters (status) WHERE deleted_at IS NULL;
CREATE INDEX idx_disasters_created_by ON disasters (created_by);
CREATE TABLE disaster_tags (
  disaster_id TEXT NOT NULL REFERENCES disasters (id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (disaster_id, tag)
);
CREATE INDEX idx_disaster_tags_tag ON disaster_tags (tag, disaster_id);
`;

function openV1Database() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(V1_SCHEMA);
  db.prepare(
    `INSERT INTO disasters (id, title, description, location_name, lat, lng, location_source, status, created_by, created_at, updated_at)
     VALUES ('d1', 'Old flood', 'Flooding in Mumbai', 'Mumbai', 19.07, 72.87, 'geocoded', 'active', 'admin', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare("INSERT INTO disaster_tags VALUES ('d1', 'flood'), ('d1', 'monsoon')").run();
  return db;
}

describe('schema migration v1 -> v2', () => {
  it('rebuilds the disasters table, keeping rows, tags and indexes', () => {
    const db = openV1Database();
    expect(db.pragma('user_version', { simple: true })).toBe(0);

    applySchema(db);

    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    const repo = new DisasterRepository(db);
    expect(repo.findById('d1')).toMatchObject({ title: 'Old flood', status: 'active', tags: ['flood', 'monsoon'] });

    // New status is accepted now; the audit table exists
    db.prepare("UPDATE disasters SET status = 'verified' WHERE id = 'd1'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'disaster_events'").get()).toEqual({ n: 1 });

    // Indexes were recreated on the new table, and the tag FK still points at "disasters"
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'disasters' AND sql IS NOT NULL").all() as { name: string }[]).map((r) => r.name);
    expect(indexes.sort()).toEqual(['idx_disasters_created_by', 'idx_disasters_live_created', 'idx_disasters_status']);
    expect(db.prepare("SELECT \"table\" FROM pragma_foreign_key_list('disaster_tags')").get()).toEqual({ table: 'disasters' });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('is a no-op on an up-to-date database', () => {
    const db = openV1Database();
    applySchema(db);
    const before = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'disasters'").get();
    applySchema(db);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'disasters'").get()).toEqual(before);
    expect(new DisasterRepository(db).findById('d1')).toBeDefined();
  });
});
