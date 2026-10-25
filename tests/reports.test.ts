import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryCacheStore, ReadThroughCache } from '../src/lib/cache.js';
import { normalizePosts } from '../src/integrations/social/socialClient.js';
import { classifyPriority } from '../src/modules/reports/priority.js';
import { ADMIN, buildTestApp } from './helpers.js';

describe('GET /disasters/:id/reports', () => {
  let ctx: ReturnType<typeof buildTestApp>;
  let id: string;

  beforeEach(async () => {
    ctx = buildTestApp();
    const res = await request(ctx.app)
      .post('/disasters')
      .set(ADMIN)
      .send({ title: 'Flooding', description: 'Heavy flooding has affected Manhattan, NYC.' })
      .expect(201);
    id = res.body.id;
  });

  it('returns prioritised reports and caches the upstream response', async () => {
    const first = await request(ctx.app).get(`/disasters/${id}/reports`).expect(200);
    expect(first.headers['x-cache']).toBe('MISS');
    expect(first.body.meta.query).toBe('Manhattan, NYC');
    expect(first.body.data.map((r: { priority: string }) => r.priority)).toEqual(['high', 'medium', 'low']);

    const second = await request(ctx.app).get(`/disasters/${id}/reports`).expect(200);
    expect(second.headers['x-cache']).toBe('HIT');
    expect(ctx.social.calls).toBe(1);
  });

  it('filters by priority', async () => {
    const res = await request(ctx.app).get(`/disasters/${id}/reports?priority=high`).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].user).toBe('rescue_vol');
  });

  it('returns 503 when upstream fails and nothing is cached', async () => {
    ctx.social.fail = true;
    const res = await request(ctx.app).get(`/disasters/${id}/reports`).expect(503);
    expect(res.body.error.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('returns 404 for an unknown disaster without calling upstream', async () => {
    await request(ctx.app).get('/disasters/nope/reports').expect(404);
    expect(ctx.social.calls).toBe(0);
  });
});

describe('ReadThroughCache', () => {
  let now: number;
  let cache: ReadThroughCache;
  beforeEach(() => {
    now = 1_000_000;
    cache = new ReadThroughCache(new MemoryCacheStore(), () => now);
  });

  it('serves stale data when the upstream fails after expiry', async () => {
    await cache.get('k', 60, async () => 'fresh');
    now += 61_000; // past TTL

    const result = await cache.get('k', 60, async () => {
      throw new Error('upstream down');
    });
    expect(result).toMatchObject({ value: 'fresh', status: 'STALE' });
  });

  it('refreshes after TTL expiry', async () => {
    await cache.get('k', 60, async () => 'v1');
    now += 61_000;
    expect((await cache.get('k', 60, async () => 'v2')).value).toBe('v2');
  });

  it('coalesces concurrent misses into a single upstream call', async () => {
    let calls = 0;
    const loader = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return 'value';
    };
    const results = await Promise.all([cache.get('k', 60, loader), cache.get('k', 60, loader), cache.get('k', 60, loader)]);
    expect(calls).toBe(1);
    expect(results.every((r) => r.value === 'value')).toBe(true);
  });
});

describe('social media normalisation', () => {
  it('maps the upstream shape and drops malformed posts', () => {
    const reports = normalizePosts({
      statuses: [
        { id_str: 'a', text: ' Need water ', author: { handle: 'citizen123' }, timestamp_ms: '1761400000000' },
        { id_str: 'b', author: null, timestamp_ms: 'nope' },
        { id_str: 'c', text: 'No author', author: null, timestamp_ms: 1761400000000 },
      ],
    });
    expect(reports).toEqual([
      { id: 'a', content: 'Need water', user: 'citizen123', created_at: '2025-10-25T13:46:40.000Z', source: 'mock-social' },
      { id: 'c', content: 'No author', user: 'anonymous', created_at: '2025-10-25T13:46:40.000Z', source: 'mock-social' },
    ]);
  });

  it('tolerates a completely unexpected payload', () => {
    expect(normalizePosts({} as never)).toEqual([]);
    expect(normalizePosts(null as never)).toEqual([]);
  });
});

describe('priority classification', () => {
  it.each([
    ['SOS family trapped on roof', 'high'],
    ['Need drinking water near Manhattan', 'medium'],
    ['Power restored downtown', 'low'],
    ['That was a helpful update', 'low'],
  ])('%s -> %s', (text, expected) => {
    expect(classifyPriority(text)).toBe(expected);
  });
});
