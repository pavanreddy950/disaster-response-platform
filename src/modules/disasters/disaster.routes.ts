import { Router } from 'express';
import { authenticate, currentUser, requireRole } from '../../auth/middleware.js';
import { validate } from '../../lib/validate.js';
import { createDisasterSchema, listDisastersQuerySchema, updateDisasterSchema } from './disaster.schemas.js';
import type { DisasterService } from './disaster.service.js';
import { describeLifecycle } from './lifecycle.js';

/**
 * Authorization matrix:
 *   GET    (read)    -> public
 *   POST   (create)  -> admin, contributor
 *   PATCH  (update)  -> admin (any), contributor (own only; enforced in service)
 *   DELETE           -> admin only
 */
export function disasterRouter(service: DisasterService): Router {
  const router = Router();

  router.post('/', authenticate, requireRole('admin', 'contributor'), async (req, res) => {
    const input = validate(createDisasterSchema, req.body);
    const disaster = await service.create(input, currentUser(req));
    res.status(201).location(`/disasters/${disaster.id}`).json(disaster);
  });

  router.get('/', (req, res) => {
    const query = validate(listDisastersQuerySchema, req.query);
    const { items, total } = service.list(query);
    res.json({ data: items, pagination: { limit: query.limit, offset: query.offset, total } });
  });

  router.get('/:id', (req, res) => {
    res.json(service.get(req.params.id));
  });

  router.get('/:id/history', (req, res) => {
    res.json({ data: service.history(req.params.id) });
  });

  router.patch('/:id', authenticate, requireRole('admin', 'contributor'), async (req, res) => {
    const input = validate(updateDisasterSchema, req.body);
    res.json(await service.update(String(req.params.id), input, currentUser(req)));
  });

  router.delete('/:id', authenticate, requireRole('admin'), (req, res) => {
    service.delete(String(req.params.id), currentUser(req));
    res.status(204).end();
  });

  return router;
}

/** GET /lifecycle: the status state machine, so clients only offer valid status changes. */
export function lifecycleRouter(): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.json(describeLifecycle());
  });
  return router;
}
