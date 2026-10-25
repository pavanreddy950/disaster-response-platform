import { Router } from 'express';
import type { StatsService } from './stats.service.js';

/** GET /stats: public dashboard counters. */
export function statsRouter(stats: StatsService): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.json(stats.summary());
  });
  return router;
}
