import type Database from 'better-sqlite3';
import type { BoundingBox } from '../../lib/geo.js';
import type { CreateResourceInput, ResourceType } from './resource.schemas.js';

export interface Resource {
  id: number;
  name: string;
  type: ResourceType;
  location: { name: string | null; lat: number; lng: number };
  created_at: string;
}

interface ResourceRow {
  id: number;
  name: string;
  type: ResourceType;
  location_name: string | null;
  lat: number;
  lng: number;
  created_at: string;
}

const toResource = (r: ResourceRow): Resource => ({
  id: r.id,
  name: r.name,
  type: r.type,
  location: { name: r.location_name, lat: r.lat, lng: r.lng },
  created_at: r.created_at,
});

export class ResourceRepository {
  constructor(private readonly db: Database.Database) {}

  insert(input: CreateResourceInput, createdAt: string): Resource {
    const result = this.db
      .prepare(
        `INSERT INTO resources (name, type, location_name, lat, lng, created_at)
         VALUES (@name, @type, @location_name, @lat, @lng, @created_at)`,
      )
      .run({ ...input, location_name: input.location_name ?? null, created_at: createdAt });
    return this.findById(Number(result.lastInsertRowid))!;
  }

  findById(id: number): Resource | undefined {
    const row = this.db.prepare('SELECT * FROM resources WHERE id = ?').get(id) as ResourceRow | undefined;
    return row ? toResource(row) : undefined;
  }

  list(opts: { type?: ResourceType; limit: number; offset: number }): { items: Resource[]; total: number } {
    const where = opts.type ? 'WHERE type = @type' : '';
    const params = { type: opts.type, limit: opts.limit, offset: opts.offset };
    const items = (
      this.db.prepare(`SELECT * FROM resources ${where} ORDER BY id LIMIT @limit OFFSET @offset`).all(params) as ResourceRow[]
    ).map(toResource);
    const { total } = this.db.prepare(`SELECT COUNT(*) AS total FROM resources ${where}`).get(params) as { total: number };
    return { items, total };
  }

  /**
   * Candidate resources whose point falls inside any of the bounding boxes.
   * The R*Tree join makes this an index range search rather than a full table scan.
   */
  findInBoxes(boxes: BoundingBox[], type?: ResourceType): Resource[] {
    const stmt = this.db.prepare(
      `SELECT r.*
         FROM resources_rtree rt
         JOIN resources r ON r.id = rt.id
        WHERE rt.max_lat >= @minLat AND rt.min_lat <= @maxLat
          AND rt.max_lng >= @minLng AND rt.min_lng <= @maxLng
          ${type ? 'AND r.type = @type' : ''}`,
    );
    const byId = new Map<number, Resource>();
    for (const box of boxes) {
      for (const row of stmt.all({ ...box, type }) as ResourceRow[]) byId.set(row.id, toResource(row));
    }
    return [...byId.values()];
  }
}
