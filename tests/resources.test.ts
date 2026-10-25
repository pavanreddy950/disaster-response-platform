import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { boundingBoxes, haversineKm } from '../src/lib/geo.js';
import { ADMIN, buildTestApp, CONTRIBUTOR } from './helpers.js';

describe('geo helpers', () => {
  it('haversine matches a known distance (Manhattan -> Brooklyn ~12 km)', () => {
    const d = haversineKm({ lat: 40.7831, lng: -73.9712 }, { lat: 40.6782, lng: -73.9442 });
    expect(d).toBeGreaterThan(11);
    expect(d).toBeLessThan(13);
  });

  it('splits the bounding box at the antimeridian', () => {
    const boxes = boundingBoxes({ lat: -17, lng: 179.9 }, 50);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.maxLng).toBe(180);
    expect(boxes[1]!.minLng).toBe(-180);
  });

  it('searches all longitudes near the poles', () => {
    expect(boundingBoxes({ lat: 89.9, lng: 0 }, 50)).toEqual([
      expect.objectContaining({ minLng: -180, maxLng: 180, maxLat: 90 }),
    ]);
  });
});

describe('GET /disasters/:id/resources', () => {
  let ctx: ReturnType<typeof buildTestApp>;
  let disasterId: string;

  beforeEach(async () => {
    ctx = buildTestApp();
    const resources = [
      { name: 'Midtown Shelter', type: 'shelter', lat: 40.7549, lng: -73.984 }, // ~3.5 km from Manhattan centre
      { name: 'Harlem Hospital', type: 'hospital', lat: 40.8142, lng: -73.9396 }, // ~4.3 km
      { name: 'Newark Camp', type: 'shelter', lat: 40.7357, lng: -74.1724 }, // ~17.8 km
      { name: 'Mumbai Shelter', type: 'shelter', lat: 19.0178, lng: 72.8478 },
    ];
    for (const r of resources) await request(ctx.app).post('/resources').set(ADMIN).send(r).expect(201);

    const res = await request(ctx.app)
      .post('/disasters')
      .set(ADMIN)
      .send({ title: 'Flooding', description: 'Heavy flooding has affected Manhattan, NYC.' })
      .expect(201);
    disasterId = res.body.id;
  });

  it("returns resources within the radius of the disaster's location, nearest first", async () => {
    const res = await request(ctx.app).get(`/disasters/${disasterId}/resources?radius=10`).expect(200);
    expect(res.body.center.source).toBe('disaster');
    expect(res.body.data.map((r: { name: string }) => r.name)).toEqual(['Midtown Shelter', 'Harlem Hospital']);
    expect(res.body.data[0].distance_km).toBeLessThan(res.body.data[1].distance_km);
  });

  it('honours explicit lat/lng, a larger radius and a type filter', async () => {
    const res = await request(ctx.app)
      .get(`/disasters/${disasterId}/resources?lat=40.7831&lng=-73.9712&radius=25&type=shelter`)
      .expect(200);
    expect(res.body.center.source).toBe('query');
    expect(res.body.data.map((r: { name: string }) => r.name)).toEqual(['Midtown Shelter', 'Newark Camp']);
  });

  it('excludes resources inside the bounding box but outside the circle', async () => {
    // Box corner: ~10 km north and ~10 km east of the centre is ~14 km away, outside a 10 km radius
    await request(ctx.app).post('/resources').set(ADMIN).send({ name: 'Corner', type: 'food', lat: 40.8729, lng: -73.8527 }).expect(201);
    const res = await request(ctx.app).get(`/disasters/${disasterId}/resources?radius=10`).expect(200);
    expect(res.body.data.map((r: { name: string }) => r.name)).not.toContain('Corner');
  });

  it('validates query parameters', async () => {
    await request(ctx.app).get(`/disasters/${disasterId}/resources?radius=-1`).expect(400);
    await request(ctx.app).get(`/disasters/${disasterId}/resources?radius=5000`).expect(400);
    await request(ctx.app).get(`/disasters/${disasterId}/resources?lat=40`).expect(400);
    await request(ctx.app).get(`/disasters/${disasterId}/resources?type=spaceship`).expect(400);
  });

  it('returns 422 when the disaster has no coordinates and none are supplied', async () => {
    const res = await request(ctx.app)
      .post('/disasters')
      .set(ADMIN)
      .send({ title: 'Unknown place', description: 'something bad happened somewhere' })
      .expect(201);
    const nearby = await request(ctx.app).get(`/disasters/${res.body.id}/resources`).expect(422);
    expect(nearby.body.error.code).toBe('LOCATION_UNRESOLVED');
  });

  it('returns 404 for an unknown disaster', async () => {
    await request(ctx.app).get('/disasters/nope/resources?lat=1&lng=1').expect(404);
  });

  it('only admins can create resources', async () => {
    await request(ctx.app).post('/resources').set(CONTRIBUTOR).send({ name: 'X', type: 'food', lat: 1, lng: 1 }).expect(403);
  });
});
