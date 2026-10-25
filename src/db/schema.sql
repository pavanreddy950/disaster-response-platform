-- Idempotent schema; applied on every startup.

CREATE TABLE IF NOT EXISTS disasters (
  id              TEXT PRIMARY KEY,                -- UUID
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  location_name   TEXT,                            -- human-readable place, e.g. "Manhattan, NYC"
  lat             REAL CHECK (lat BETWEEN -90 AND 90),
  lng             REAL CHECK (lng BETWEEN -180 AND 180),
  location_source TEXT NOT NULL DEFAULT 'unresolved'
                  CHECK (location_source IN ('client', 'geocoded', 'unresolved')),
  status          TEXT NOT NULL DEFAULT 'reported'
                  CHECK (status IN ('reported', 'active', 'contained', 'resolved')),
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,                   -- ISO-8601 UTC
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT,                            -- soft delete: keep an audit trail of incidents
  CHECK ((lat IS NULL) = (lng IS NULL))            -- coordinates are all-or-nothing
);

CREATE INDEX IF NOT EXISTS idx_disasters_live_created
  ON disasters (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_disasters_status ON disasters (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_disasters_created_by ON disasters (created_by);

-- Tags normalised into their own table so "?tag=flood" is an indexed lookup,
-- not a LIKE scan over a JSON/CSV column.
CREATE TABLE IF NOT EXISTS disaster_tags (
  disaster_id TEXT NOT NULL REFERENCES disasters (id) ON DELETE CASCADE,
  tag         TEXT NOT NULL,
  PRIMARY KEY (disaster_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_disaster_tags_tag ON disaster_tags (tag, disaster_id);

CREATE TABLE IF NOT EXISTS resources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,  -- integer id required by the R*Tree index
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('shelter', 'hospital', 'food', 'water', 'rescue', 'medical', 'other')),
  location_name TEXT,
  lat           REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng           REAL NOT NULL CHECK (lng BETWEEN -180 AND 180),
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resources_type ON resources (type);

-- Spatial index: SQLite R*Tree. Each resource is stored as a degenerate box (point).
CREATE VIRTUAL TABLE IF NOT EXISTS resources_rtree USING rtree (
  id, min_lat, max_lat, min_lng, max_lng
);

-- Keep the spatial index in sync with the base table.
CREATE TRIGGER IF NOT EXISTS resources_ai AFTER INSERT ON resources BEGIN
  INSERT INTO resources_rtree (id, min_lat, max_lat, min_lng, max_lng)
  VALUES (new.id, new.lat, new.lat, new.lng, new.lng);
END;
CREATE TRIGGER IF NOT EXISTS resources_au AFTER UPDATE OF lat, lng ON resources BEGIN
  UPDATE resources_rtree
     SET min_lat = new.lat, max_lat = new.lat, min_lng = new.lng, max_lng = new.lng
   WHERE id = new.id;
END;
CREATE TRIGGER IF NOT EXISTS resources_ad AFTER DELETE ON resources BEGIN
  DELETE FROM resources_rtree WHERE id = old.id;
END;

-- Persistent cache for external lookups (geocoding results).
CREATE TABLE IF NOT EXISTS external_cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,      -- JSON
  expires_at INTEGER NOT NULL    -- epoch millis
);
