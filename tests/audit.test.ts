import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { DisasterRepository } from '../src/modules/disasters/disaster.repository.js';
import type { Disaster, NewAuditEntry } from '../src/modules/disasters/disaster.types.js';
import { ADMIN, buildTestApp, CONTRIBUTOR } from './helpers.js';

const flood = {
  title: 'Manhattan flooding',
  description: 'Heavy flooding has affected Manhattan, NYC.',
  tags: ['flood'],
};

describe('audit trail', () => {
  let ctx: ReturnType<typeof buildTestApp>;
  beforeEach(() => {
    ctx = buildTestApp();
  });

  const eventCount = (id: string) =>
    (ctx.db.prepare('SELECT COUNT(*) AS n FROM disaster_events WHERE disaster_id = ?').get(id) as { n: number }).n;

  it('records create, edits and status changes newest first, with field diffs and actors', async () => {
    const d = (await request(ctx.app).post('/disasters').set(CONTRIBUTOR).send(flood).expect(201)).body;
    await request(ctx.app)
      .patch(`/disasters/${d.id}`)
      .set(CONTRIBUTOR)
      .send({ title: 'Manhattan flash flooding', tags: ['flood', 'urban'] })
      .expect(200);
    await request(ctx.app).patch(`/disasters/${d.id}`).set(ADMIN).send({ status: 'verified' }).expect(200);

    const res = await request(ctx.app).get(`/disasters/${d.id}/history`).expect(200);
    expect(res.body.data.map((e: { action: string }) => e.action)).toEqual(['status_changed', 'updated', 'created']);

    const [statusChange, edit, created] = res.body.data;
    expect(statusChange).toMatchObject({ actor: 'admin', changes: { status: { from: 'reported', to: 'verified' } } });
    expect(edit).toMatchObject({
      actor: 'contributor1',
      changes: {
        title: { from: 'Manhattan flooding', to: 'Manhattan flash flooding' },
        tags: { from: ['flood'], to: ['flood', 'urban'] },
      },
    });
    expect(Object.keys(edit.changes).sort()).toEqual(['tags', 'title']);
    expect(created).toEqual({ id: expect.any(Number), action: 'created', actor: 'contributor1', changes: {}, at: d.created_at });
    expect(statusChange.id).toBeGreaterThan(edit.id);
  });

  it('records location changes field by field', async () => {
    const d = (await request(ctx.app).post('/disasters').set(ADMIN).send(flood).expect(201)).body;
    await request(ctx.app).patch(`/disasters/${d.id}`).set(ADMIN).send({ lat: 10, lng: 20 }).expect(200);

    const [latest] = (await request(ctx.app).get(`/disasters/${d.id}/history`)).body.data;
    expect(latest.action).toBe('updated');
    expect(latest.changes).toEqual({
      'location.lat': { from: d.location.lat, to: 10 },
      'location.lng': { from: d.location.lng, to: 20 },
      'location.source': { from: 'geocoded', to: 'client' },
    });
  });

  it('a PATCH that changes nothing writes no event, keeps updated_at and publishes nothing', async () => {
    const d = (await request(ctx.app).post('/disasters').set(ADMIN).send(flood).expect(201)).body;
    const published: unknown[] = [];
    ctx.events.subscribe((e) => published.push(e));

    const res = await request(ctx.app)
      .patch(`/disasters/${d.id}`)
      .set(ADMIN)
      .send({ title: d.title, tags: ['flood'], status: 'reported' })
      .expect(200);

    expect(res.body.updated_at).toBe(d.updated_at);
    expect(eventCount(d.id)).toBe(1); // just 'created'
    expect(published).toHaveLength(0);
  });

  it('records deletes; history of a deleted or unknown disaster is 404', async () => {
    const d = (await request(ctx.app).post('/disasters').set(ADMIN).send(flood).expect(201)).body;
    await request(ctx.app).delete(`/disasters/${d.id}`).set(ADMIN).expect(204);

    const rows = ctx.db.prepare('SELECT action, actor FROM disaster_events WHERE disaster_id = ? ORDER BY id').all(d.id);
    expect(rows).toEqual([
      { action: 'created', actor: 'admin' },
      { action: 'deleted', actor: 'admin' },
    ]);

    await request(ctx.app).get(`/disasters/${d.id}/history`).expect(404);
    const res = await request(ctx.app).get('/disasters/nope/history').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('rejected changes leave no audit entry', async () => {
    const d = (await request(ctx.app).post('/disasters').set(CONTRIBUTOR).send(flood).expect(201)).body;
    await request(ctx.app).patch(`/disasters/${d.id}`).set(CONTRIBUTOR).send({ status: 'contained' }).expect(409);
    await request(ctx.app).delete(`/disasters/${d.id}`).set(CONTRIBUTOR).expect(403);
    expect(eventCount(d.id)).toBe(1);
  });

  it('the change and its audit entry commit or roll back together', async () => {
    const d: Disaster = (await request(ctx.app).post('/disasters').set(ADMIN).send(flood).expect(201)).body;
    const repo = new DisasterRepository(ctx.db);
    // An audit row that violates the CHECK constraint makes the transaction fail after the UPDATE ran
    const badAudit = { action: 'bogus', actor: 'admin', changes: {}, at: new Date().toISOString() } as unknown as NewAuditEntry;

    expect(() => repo.update({ ...d, title: 'Should not persist' }, badAudit)).toThrow(/CHECK constraint/);
    expect(repo.findById(d.id)!.title).toBe(flood.title);

    expect(() => repo.softDelete(d.id, badAudit)).toThrow(/CHECK constraint/);
    expect(repo.findById(d.id)).toBeDefined();
    expect(eventCount(d.id)).toBe(1);
  });
});
