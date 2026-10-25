import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from '../src/lib/rateLimit.js';
import { ADMIN, buildTestApp, CONTRIBUTOR, CONTRIBUTOR_2 } from './helpers.js';

const flood = { title: 'Manhattan flooding', description: 'Heavy flooding has affected Manhattan, NYC.' };

describe('request ids', () => {
  const { app } = buildTestApp();

  it('echoes a well-formed incoming X-Request-Id', async () => {
    const res = await request(app).get('/health').set('X-Request-Id', 'abc-123.retry_1').expect(200);
    expect(res.headers['x-request-id']).toBe('abc-123.retry_1');
  });

  it('generates one when missing or malformed', async () => {
    const missing = await request(app).get('/health');
    expect(missing.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const malformed = await request(app).get('/health').set('X-Request-Id', 'bad id\twith spaces');
    expect(malformed.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const tooLong = await request(app).get('/health').set('X-Request-Id', 'a'.repeat(65));
    expect(tooLong.headers['x-request-id']).not.toBe('a'.repeat(65));
  });

  it('includes request_id in every error envelope', async () => {
    const notFound = await request(app).get('/disasters/missing').set('X-Request-Id', 'trace-1').expect(404);
    expect(notFound.body.error.request_id).toBe('trace-1');

    const badJson = await request(app)
      .post('/disasters')
      .set(ADMIN)
      .set('Content-Type', 'application/json')
      .send('{"title": ')
      .expect(400);
    expect(badJson.body.error).toMatchObject({ code: 'INVALID_JSON', request_id: badJson.headers['x-request-id'] });
  });
});

describe('write rate limiting', () => {
  it('returns 429 with Retry-After once the per-user limit is exceeded; reads are unaffected', async () => {
    const { app } = buildTestApp({ env: { RATE_LIMIT_WRITES_PER_MINUTE: '2' } });
    await request(app).post('/disasters').set(CONTRIBUTOR).send(flood).expect(201);
    await request(app).post('/disasters').set(CONTRIBUTOR).send(flood).expect(201);

    const limited = await request(app).post('/disasters').set(CONTRIBUTOR).send(flood).expect(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.body.error.request_id).toBeTruthy();
    const retryAfter = Number(limited.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);

    // Reads are not limited; other users have their own budget
    for (let i = 0; i < 5; i++) await request(app).get('/disasters').expect(200);
    await request(app).post('/disasters').set(CONTRIBUTOR_2).send(flood).expect(201);
  });

  it('limits anonymous writes by IP before authentication runs', async () => {
    const { app } = buildTestApp({ env: { RATE_LIMIT_WRITES_PER_MINUTE: '1' } });
    await request(app).post('/disasters').send(flood).expect(401);
    await request(app).post('/disasters').send(flood).expect(429);
  });

  it('resets after the window and prunes expired windows', () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter(1, 60_000, () => now);
    expect(limiter.hit('a')).toBe(0);
    expect(limiter.hit('a')).toBe(60);
    now = 30_000;
    expect(limiter.hit('a')).toBe(30);
    expect(limiter.hit('b')).toBe(0);

    now = 60_000;
    expect(limiter.hit('a')).toBe(0); // new window
    now = 125_000;
    limiter.hit('c'); // sweep drops 'a' and 'b'
    expect(limiter.size).toBe(1);
  });
});

describe('GET /stats', () => {
  it('counts live disasters per status and resources per type, zero-filled', async () => {
    const { app, db } = buildTestApp({
      geocoder: { name: 'none', geocode: async () => null },
    });
    const ids: string[] = [];
    for (const status of ['reported', 'reported', 'active']) {
      ids.push((await request(app).post('/disasters').set(ADMIN).send({ ...flood, status, lat: 1, lng: 2 })).body.id);
    }
    // Unresolved location (geocoder finds nothing)
    await request(app).post('/disasters').set(ADMIN).send(flood).expect(201);
    // Deleted disasters are not counted
    await request(app).delete(`/disasters/${ids[0]}`).set(ADMIN).expect(204);

    await request(app).post('/resources').set(ADMIN).send({ name: 'Shelter A', type: 'shelter', lat: 1, lng: 2 }).expect(201);
    await request(app).post('/resources').set(ADMIN).send({ name: 'Shelter B', type: 'shelter', lat: 1, lng: 2 }).expect(201);
    await request(app).post('/resources').set(ADMIN).send({ name: 'Clinic', type: 'medical', lat: 1, lng: 2 }).expect(201);
    expect(db.prepare('SELECT COUNT(*) AS n FROM resources').get()).toEqual({ n: 3 });

    const res = await request(app).get('/stats').expect(200);
    expect(res.body).toEqual({
      disasters: {
        total: 3,
        by_status: { reported: 2, verified: 0, active: 1, contained: 0, resolved: 0 },
        unresolved_locations: 1,
      },
      resources: {
        total: 3,
        by_type: { shelter: 2, hospital: 0, food: 0, water: 0, rescue: 0, medical: 1, other: 0 },
      },
    });
  });
});
