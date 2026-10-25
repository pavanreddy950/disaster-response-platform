import { Router } from 'express';
import { authenticate, requireRole } from '../../auth/middleware.js';
import { validate } from '../../lib/validate.js';
import type { DisasterService } from '../disasters/disaster.service.js';
import { createResourceSchema, listResourcesQuerySchema, nearbyQuerySchema } from './resource.schemas.js';
import type { ResourceService } from './resource.service.js';

/** GET /disasters/:id/resources */
export function nearbyResourcesRouter(disasters: DisasterService, resources: ResourceService): Router {
  const router = Router({ mergeParams: true });

  router.get('/', (req, res) => {
    const disaster = disasters.get((req.params as { id: string }).id);
    const query = validate(nearbyQuerySchema, req.query);
    res.json(resources.nearbyForDisaster(disaster, query));
  });

  return router;
}

/** /resources: catalogue management (create is admin-only). */
export function resourceRouter(resources: ResourceService): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const query = validate(listResourcesQuerySchema, req.query);
    const { items, total } = resources.list(query);
    res.json({ data: items, pagination: { limit: query.limit, offset: query.offset, total } });
  });

  router.post('/', authenticate, requireRole('admin'), (req, res) => {
    const input = validate(createResourceSchema, req.body);
    res.status(201).json(resources.create(input));
  });

  return router;
}
