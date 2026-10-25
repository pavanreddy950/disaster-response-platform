import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, buildTestApp, CONTRIBUTOR } from './helpers.js';

const quake = { title: 'Tokyo earthquake', description: 'Strong earthquake near Tokyo, buildings damaged.' };

describe('incident lifecycle', () => {
  let ctx: ReturnType<typeof buildTestApp>;
  beforeEach(() => {
    ctx = buildTestApp();
  });

  const create = async (headers = CONTRIBUTOR, body: object = quake) =>
    (await request(ctx.app).post('/disasters').set(headers).send(body).expect(201)).body as { id: string };
  const setStatus = (id: string, status: string, headers = CONTRIBUTOR) =>
    request(ctx.app).patch(`/disasters/${id}`).set(headers).send({ status });

  it('walks the happy path reported -> verified -> active -> contained -> resolved', async () => {
    const d = await create();
    for (const status of ['verified', 'active', 'contained', 'resolved']) {
      const res = await setStatus(d.id, status).expect(200);
      expect(res.body.status).toBe(status);
    }
  });

  it('allows contained -> active (flare-up) and reported -> resolved (false alarm)', async () => {
    const d = await create(CONTRIBUTOR, { ...quake, status: 'active' });
    await setStatus(d.id, 'contained').expect(200);
    await setStatus(d.id, 'active').expect(200);

    const falseAlarm = await create();
    await setStatus(falseAlarm.id, 'resolved').expect(200);
  });

  it('rejects an illegal jump with 409 and the allowed transitions', async () => {
    const d = await create();
    const res = await setStatus(d.id, 'contained').expect(409);
    expect(res.body.error).toMatchObject({
      code: 'INVALID_STATUS_TRANSITION',
      message: 'Cannot change status from reported to contained',
      details: { from: 'reported', to: 'contained', allowed: ['verified', 'resolved'] },
    });
    // Nothing was written
    expect((await request(ctx.app).get(`/disasters/${d.id}`)).body.status).toBe('reported');
  });

  it('treats setting the current status as a no-op, not a transition', async () => {
    const d = await create();
    await setStatus(d.id, 'reported').expect(200);
  });

  it('only admins can reopen a resolved disaster, and only to active', async () => {
    const d = await create();
    await setStatus(d.id, 'resolved').expect(200);

    const forbidden = await setStatus(d.id, 'active').expect(403);
    expect(forbidden.body.error.message).toBe('Only admins can reopen a resolved disaster');

    const conflict = await setStatus(d.id, 'verified', ADMIN).expect(409);
    expect(conflict.body.error.details.allowed).toEqual(['active']);

    expect((await setStatus(d.id, 'active', ADMIN).expect(200)).body.status).toBe('active');
  });

  it('checks ownership before the lifecycle', async () => {
    const d = await create(ADMIN);
    const res = await setStatus(d.id, 'contained', CONTRIBUTOR).expect(403);
    expect(res.body.error.message).toMatch(/only modify disasters they created/);
  });

  it('restricts the initial status to reported, verified or active', async () => {
    expect((await create(CONTRIBUTOR, { ...quake, status: 'verified' }) as { status?: string }).status).toBe('verified');
    await request(ctx.app).post('/disasters').set(CONTRIBUTOR).send({ ...quake, status: 'contained' }).expect(400);
    await request(ctx.app).post('/disasters').set(CONTRIBUTOR).send({ ...quake, status: 'resolved' }).expect(400);
  });

  it('GET /lifecycle publishes the state machine', async () => {
    const res = await request(ctx.app).get('/lifecycle').expect(200);
    expect(res.body).toEqual({
      statuses: ['reported', 'verified', 'active', 'contained', 'resolved'],
      initial: ['reported', 'verified', 'active'],
      transitions: {
        reported: ['verified', 'resolved'],
        verified: ['active', 'resolved'],
        active: ['contained', 'resolved'],
        contained: ['active', 'resolved'],
        resolved: ['active'],
      },
      admin_only: [{ from: 'resolved', to: 'active' }],
    });
  });
});
