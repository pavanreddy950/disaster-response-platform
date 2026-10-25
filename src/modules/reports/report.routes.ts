import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../lib/validate.js';
import type { DisasterService } from '../disasters/disaster.service.js';
import type { ReportService } from './report.service.js';

const querySchema = z.object({ priority: z.enum(['high', 'medium', 'low']).optional() });

/** GET /disasters/:id/reports */
export function reportRouter(disasters: DisasterService, reports: ReportService): Router {
  const router = Router({ mergeParams: true });

  router.get('/', async (req, res) => {
    const disaster = disasters.get((req.params as { id: string }).id);
    const query = validate(querySchema, req.query);
    const result = await reports.forDisaster(disaster, query);
    res.setHeader('X-Cache', result.meta.cache);
    res.json(result);
  });

  return router;
}
