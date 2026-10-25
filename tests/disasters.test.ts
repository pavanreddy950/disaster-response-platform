import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { ExternalServiceError } from '../src/lib/errors.js';
import { ADMIN, buildTestApp, CONTRIBUTOR, CONTRIBUTOR_2 } from './helpers.js';

const flood = {
  title: 'Manhattan flooding',
  description: 'Heavy flooding has affected Manhattan, NYC.',
  tags: ['Flood', 'urban', 'flood'],
};

describe('Disasters API', () => {
  let ctx: ReturnType<typeof buildTestApp>;
  beforeEach(() => {
    ctx = buildTestApp();
  });

  describe('POST /disasters', () => {
    it('creates a disaster, extracts + geocodes its location and normalises tags', async () => {
      const res = await request(ctx.app).post('/disasters').set(CONTRIBUTOR).send(flood).expect(201);

      expect(res.headers.location).toBe(`/disasters/${res.body.id}`);
      expect(res.body).toMatchObject({
        title: 'Manhattan flooding',
        status: 'reported',
        created_by: 'contributor1',
        tags: ['flood', 'urban'],
        location: { name: 'Manhattan, NYC', source: 'geocoded' },
      });
      expect(res.body.location.lat).toBeCloseTo(40.78, 1);
      expect(res.body.location.lng).toBeCloseTo(-73.97, 1);
    });

    it('uses client-supplied coordinates without geocoding', async () => {
      const res = await request(ctx.app)
        .post('/disasters')
        .set(ADMIN)
        .send({ ...flood, lat: 10, lng: 20 })
        .expect(201);
      expect(res.body.location).toMatchObject({ lat: 10, lng: 20, source: 'client' });
    });

    it('still creates the disaster (unresolved) when the geocoder is down', async () => {
      ctx = buildTestApp({
        geocoder: {
          name: 'broken',
          geocode: async () => {
            throw new ExternalServiceError('geo', 'timeout', true);
          },
        },
      });
      const res = await request(ctx.app).post('/disasters').set(ADMIN).send(flood).expect(201);
      expect(res.body.location).toEqual({ name: 'Manhattan, NYC', lat: null, lng: null, source: 'unresolved' });
    });

    it('rejects invalid input with field-level details', async () => {
      const res = await request(ctx.app)
        .post('/disasters')
        .set(ADMIN)
        .send({ title: 'x', description: 'short', lat: 95, tags: ['bad tag!'] })
        .expect(400);

      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      const fields = res.body.error.details.map((d: { field: string }) => d.field);
      expect(fields).toEqual(expect.arrayContaining(['title', 'description', 'lat', 'tags.0']));
    });

    it('rejects unknown fields and lone coordinates', async () => {
      await request(ctx.app).post('/disasters').set(ADMIN).send({ ...flood, created_by: 'someone-else' }).expect(400);
      await request(ctx.app).post('/disasters').set(ADMIN).send({ ...flood, lat: 40 }).expect(400);
    });

    it('returns 400 for malformed JSON', async () => {
      const res = await request(ctx.app)
        .post('/disasters')
        .set(ADMIN)
        .set('Content-Type', 'application/json')
        .send('{"title": ')
        .expect(400);
      expect(res.body.error.code).toBe('INVALID_JSON');
    });

    it('requires authentication', async () => {
      await request(ctx.app).post('/disasters').send(flood).expect(401);
      await request(ctx.app).post('/disasters').set({ Authorization: 'Bearer nope' }).send(flood).expect(401);
    });
  });

  describe('GET /disasters', () => {
    it('filters by tag and status and paginates', async () => {
      await request(ctx.app).post('/disasters').set(ADMIN).send(flood).expect(201);
      await request(ctx.app)
        .post('/disasters')
        .set(ADMIN)
        .send({ title: 'Chennai cyclone', description: 'Cyclone landfall near Chennai coast', tags: ['cyclone'], status: 'active' })
        .expect(201);

      const byTag = await request(ctx.app).get('/disasters?tag=FLOOD').expect(200);
      expect(byTag.body.data.map((d: { title: string }) => d.title)).toEqual(['Manhattan flooding']);
      expect(byTag.body.pagination.total).toBe(1);

      const byStatus = await request(ctx.app).get('/disasters?status=active').expect(200);
      expect(byStatus.body.data).toHaveLength(1);

      const page = await request(ctx.app).get('/disasters?limit=1').expect(200);
      expect(page.body.data).toHaveLength(1);
      expect(page.body.pagination).toEqual({ limit: 1, offset: 0, total: 2 });

      await request(ctx.app).get('/disasters?status=unknown').expect(400);
    });

    it('returns 404 for unknown ids', async () => {
      const res = await request(ctx.app).get('/disasters/does-not-exist').expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('authorization & business rules', () => {
    async function createAs(headers: Record<string, string>) {
      return (await request(ctx.app).post('/disasters').set(headers).send(flood).expect(201)).body;
    }

    it('only admins can delete; deleted disasters disappear (soft delete)', async () => {
      const d = await createAs(CONTRIBUTOR);
      const forbidden = await request(ctx.app).delete(`/disasters/${d.id}`).set(CONTRIBUTOR).expect(403);
      expect(forbidden.body.error.code).toBe('FORBIDDEN');

      await request(ctx.app).delete(`/disasters/${d.id}`).set(ADMIN).expect(204);
      await request(ctx.app).get(`/disasters/${d.id}`).expect(404);
      await request(ctx.app).delete(`/disasters/${d.id}`).set(ADMIN).expect(404);

      const row = ctx.db.prepare('SELECT deleted_at FROM disasters WHERE id = ?').get(d.id) as { deleted_at: string };
      expect(row.deleted_at).toBeTruthy();
    });

    it('contributors can update only their own disasters; admins any', async () => {
      const d = await createAs(CONTRIBUTOR);
      await request(ctx.app).patch(`/disasters/${d.id}`).set(CONTRIBUTOR_2).send({ status: 'active' }).expect(403);
      await request(ctx.app).patch(`/disasters/${d.id}`).set(CONTRIBUTOR).send({ status: 'active' }).expect(200);
      await request(ctx.app).patch(`/disasters/${d.id}`).set(ADMIN).send({ status: 'contained' }).expect(200);
    });

    it('a resolved disaster can only be reopened by an admin', async () => {
      const d = await createAs(CONTRIBUTOR);
      await request(ctx.app).patch(`/disasters/${d.id}`).set(CONTRIBUTOR).send({ status: 'resolved' }).expect(200);

      const res = await request(ctx.app).patch(`/disasters/${d.id}`).set(CONTRIBUTOR).send({ status: 'active' }).expect(403);
      expect(res.body.error.message).toMatch(/reopen/);

      const reopened = await request(ctx.app).patch(`/disasters/${d.id}`).set(ADMIN).send({ status: 'active' }).expect(200);
      expect(reopened.body.status).toBe('active');
    });

    it('PATCH re-resolves location when the description changes', async () => {
      const d = await createAs(ADMIN);
      const res = await request(ctx.app)
        .patch(`/disasters/${d.id}`)
        .set(ADMIN)
        .send({ description: 'Flood waters have now moved into Brooklyn as well.' })
        .expect(200);
      expect(res.body.location).toMatchObject({ name: 'Brooklyn', source: 'geocoded' });
      expect(res.body.updated_at >= d.updated_at).toBe(true);
    });

    it('rejects an empty PATCH body', async () => {
      const d = await createAs(ADMIN);
      await request(ctx.app).patch(`/disasters/${d.id}`).set(ADMIN).send({}).expect(400);
    });
  });
});
