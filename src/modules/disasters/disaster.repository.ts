import type Database from 'better-sqlite3';
import type { LocationSource } from '../../integrations/geocoding/locationResolver.js';
import {
  DISASTER_STATUSES,
  type AuditAction,
  type AuditEntry,
  type Disaster,
  type DisasterStatus,
  type FieldChanges,
  type NewAuditEntry,
} from './disaster.types.js';
import type { ListDisastersQuery } from './disaster.schemas.js';

interface DisasterRow {
  id: string;
  title: string;
  description: string;
  location_name: string | null;
  lat: number | null;
  lng: number | null;
  location_source: LocationSource;
  status: DisasterStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
  tags_json: string;
}

// Tags are aggregated in the same query to avoid N+1 lookups when listing.
const SELECT_DISASTER = `
  SELECT d.*,
         (SELECT COALESCE(json_group_array(t.tag), '[]')
            FROM (SELECT tag FROM disaster_tags WHERE disaster_id = d.id ORDER BY tag) t) AS tags_json
    FROM disasters d`;

interface AuditRow {
  id: number;
  action: AuditAction;
  actor: string;
  changes: string;
  at: string;
}

function toDisaster(row: DisasterRow): Disaster {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    location: { name: row.location_name, lat: row.lat, lng: row.lng, source: row.location_source },
    tags: JSON.parse(row.tags_json) as string[],
    status: row.status,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Every write takes the audit entry describing it and records both in ONE transaction.
 * That is the point of keeping them together: the trail can never claim a change that was rolled back,
 * and a committed change can never be missing from the trail (no "write, then log, then crash" gap).
 */
export class DisasterRepository {
  constructor(private readonly db: Database.Database) {}

  insert(d: Disaster, audit: NewAuditEntry): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO disasters (id, title, description, location_name, lat, lng, location_source,
                                  status, created_by, created_at, updated_at)
           VALUES (@id, @title, @description, @location_name, @lat, @lng, @location_source,
                   @status, @created_by, @created_at, @updated_at)`,
        )
        .run({
          id: d.id,
          title: d.title,
          description: d.description,
          location_name: d.location.name,
          lat: d.location.lat,
          lng: d.location.lng,
          location_source: d.location.source,
          status: d.status,
          created_by: d.created_by,
          created_at: d.created_at,
          updated_at: d.updated_at,
        });
      this.replaceTags(d.id, d.tags);
      this.recordAudit(d.id, audit);
    })();
  }

  findById(id: string): Disaster | undefined {
    const row = this.db.prepare(`${SELECT_DISASTER} WHERE d.id = ? AND d.deleted_at IS NULL`).get(id) as
      | DisasterRow
      | undefined;
    return row ? toDisaster(row) : undefined;
  }

  list(q: ListDisastersQuery): { items: Disaster[]; total: number } {
    const where = ['d.deleted_at IS NULL'];
    const params: Record<string, unknown> = { limit: q.limit, offset: q.offset };

    if (q.tag) {
      where.push('EXISTS (SELECT 1 FROM disaster_tags dt WHERE dt.disaster_id = d.id AND dt.tag = @tag)');
      params.tag = q.tag;
    }
    if (q.status) {
      where.push('d.status = @status');
      params.status = q.status;
    }
    if (q.created_by) {
      where.push('d.created_by = @created_by');
      params.created_by = q.created_by;
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const items = (
      this.db
        .prepare(`${SELECT_DISASTER} ${whereSql} ORDER BY d.created_at DESC, d.id LIMIT @limit OFFSET @offset`)
        .all(params) as DisasterRow[]
    ).map(toDisaster);
    const { total } = this.db.prepare(`SELECT COUNT(*) AS total FROM disasters d ${whereSql}`).get(params) as {
      total: number;
    };
    return { items, total };
  }

  /** Persists the full updated entity (the service computes it). */
  update(d: Disaster, audit: NewAuditEntry): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE disasters
              SET title = @title, description = @description, location_name = @location_name,
                  lat = @lat, lng = @lng, location_source = @location_source,
                  status = @status, updated_at = @updated_at
            WHERE id = @id AND deleted_at IS NULL`,
        )
        .run({
          id: d.id,
          title: d.title,
          description: d.description,
          location_name: d.location.name,
          lat: d.location.lat,
          lng: d.location.lng,
          location_source: d.location.source,
          status: d.status,
          updated_at: d.updated_at,
        });
      this.replaceTags(d.id, d.tags);
      this.recordAudit(d.id, audit);
    })();
  }

  /** Returns false (and records nothing) when the disaster does not exist or is already deleted. */
  softDelete(id: string, audit: NewAuditEntry): boolean {
    return this.db.transaction(() => {
      const result = this.db
        .prepare('UPDATE disasters SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
        .run(audit.at, audit.at, id);
      if (result.changes === 0) return false;
      this.recordAudit(id, audit);
      return true;
    })();
  }

  /** Audit trail, newest first (id order, not timestamp order: ids are strictly monotonic). */
  history(id: string): AuditEntry[] {
    const rows = this.db
      .prepare('SELECT id, action, actor, changes, at FROM disaster_events WHERE disaster_id = ? ORDER BY id DESC')
      .all(id) as AuditRow[];
    return rows.map((r) => ({ ...r, changes: JSON.parse(r.changes) as FieldChanges }));
  }

  /** Live (non-deleted) disasters per status; every status is present, zero-filled. */
  countByStatus(): Record<DisasterStatus, number> {
    const counts = Object.fromEntries(DISASTER_STATUSES.map((s) => [s, 0])) as Record<DisasterStatus, number>;
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM disasters WHERE deleted_at IS NULL GROUP BY status')
      .all() as { status: DisasterStatus; n: number }[];
    for (const r of rows) counts[r.status] = r.n;
    return counts;
  }

  countUnresolvedLocations(): number {
    const { n } = this.db
      .prepare("SELECT COUNT(*) AS n FROM disasters WHERE deleted_at IS NULL AND location_source = 'unresolved'")
      .get() as { n: number };
    return n;
  }

  private recordAudit(disasterId: string, audit: NewAuditEntry): void {
    this.db
      .prepare('INSERT INTO disaster_events (disaster_id, action, actor, changes, at) VALUES (?, ?, ?, ?, ?)')
      .run(disasterId, audit.action, audit.actor, JSON.stringify(audit.changes), audit.at);
  }

  private replaceTags(id: string, tags: string[]): void {
    this.db.prepare('DELETE FROM disaster_tags WHERE disaster_id = ?').run(id);
    const insert = this.db.prepare('INSERT INTO disaster_tags (disaster_id, tag) VALUES (?, ?)');
    for (const tag of tags) insert.run(id, tag);
  }
}
