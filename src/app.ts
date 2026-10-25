import express, { type NextFunction, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import { MemoryCacheStore, ReadThroughCache } from './lib/cache.js';
import { AppError } from './lib/errors.js';
import { FixedWindowRateLimiter, rateLimitWrites } from './lib/rateLimit.js';
import { requestId } from './lib/requestId.js';
import type { Geocoder, LocationExtractor } from './integrations/geocoding/types.js';
import { RuleBasedLocationExtractor } from './integrations/geocoding/extractor.js';
import { LocationResolver } from './integrations/geocoding/locationResolver.js';
import type { SocialMediaClient } from './integrations/social/socialClient.js';
import { mockSocialRouter } from './integrations/social/mockSocialService.js';
import { EventBus } from './realtime/events.js';
import { sseRouter } from './realtime/sse.js';
import { DisasterRepository } from './modules/disasters/disaster.repository.js';
import { DisasterService } from './modules/disasters/disaster.service.js';
import { disasterRouter, lifecycleRouter } from './modules/disasters/disaster.routes.js';
import { ResourceRepository } from './modules/resources/resource.repository.js';
import { ResourceService } from './modules/resources/resource.service.js';
import { nearbyResourcesRouter, resourceRouter } from './modules/resources/resource.routes.js';
import { ReportService } from './modules/reports/report.service.js';
import { reportRouter } from './modules/reports/report.routes.js';
import { StatsService } from './modules/stats/stats.service.js';
import { statsRouter } from './modules/stats/stats.routes.js';

export interface AppDeps {
  db: Database.Database;
  config: Config;
  geocoder: Geocoder;
  socialClient: SocialMediaClient;
  extractor?: LocationExtractor;
  /** Mount the fake social-media API at /mock/social (on by default). */
  mountMockSocial?: boolean;
  logRequests?: boolean;
  /** Override the write limiter (e.g. a fake clock); defaults to RATE_LIMIT_WRITES_PER_MINUTE per minute. */
  rateLimiter?: FixedWindowRateLimiter;
}

/**
 * Composition root: wires repositories -> services -> routers.
 * Every external dependency is injected, so tests swap in fakes without module mocking.
 */
export function createApp(deps: AppDeps) {
  const events = new EventBus();
  const locationResolver = new LocationResolver(deps.extractor ?? new RuleBasedLocationExtractor(), deps.geocoder);

  const disasterRepo = new DisasterRepository(deps.db);
  const resourceRepo = new ResourceRepository(deps.db);
  const disasters = new DisasterService(disasterRepo, locationResolver, events);
  const resources = new ResourceService(resourceRepo);
  const stats = new StatsService(disasterRepo, resourceRepo);
  const rateLimiter = deps.rateLimiter ?? new FixedWindowRateLimiter(deps.config.RATE_LIMIT_WRITES_PER_MINUTE);
  const reports = new ReportService(
    deps.socialClient,
    new ReadThroughCache(new MemoryCacheStore(500)),
    deps.config.REPORTS_CACHE_TTL_SECONDS,
  );

  const app = express();
  app.disable('x-powered-by');
  app.use(requestId); // first, so every log line and error envelope can carry the id
  if (deps.logRequests) app.use(requestLogger);
  app.use(rateLimitWrites(rateLimiter)); // before body parsing: rejected requests cost as little as possible
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => {
    deps.db.prepare('SELECT 1').get();
    res.json({ status: 'ok' });
  });

  app.use('/disasters', disasterRouter(disasters));
  app.use('/disasters/:id/resources', nearbyResourcesRouter(disasters, resources));
  app.use('/disasters/:id/reports', reportRouter(disasters, reports));
  app.use('/resources', resourceRouter(resources));
  app.use('/lifecycle', lifecycleRouter());
  app.use('/stats', statsRouter(stats));
  app.use(sseRouter(events));

  if (deps.mountMockSocial ?? true) {
    app.use(
      '/mock/social',
      mockSocialRouter({
        failureRate: deps.config.SOCIAL_MOCK_FAILURE_RATE,
        latencyMs: deps.config.SOCIAL_MOCK_LATENCY_MS,
      }),
    );
  }

  // Demo client (live event feed) and API docs
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
  app.get('/openapi.yaml', (_req, res) => res.sendFile(fileURLToPath(new URL('../docs/openapi.yaml', import.meta.url))));

  app.use((req, _res, next) => next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`)));
  app.use(errorHandler);

  return { app, events };
}

function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = performance.now();
  res.on('finish', () => {
    console.log(`[${req.requestId}] ${req.method} ${req.originalUrl} ${res.statusCode} ${(performance.now() - start).toFixed(1)}ms`);
  });
  next();
}

/**
 * Single place that turns errors into the `{ error: { code, message, details?, request_id } }` envelope.
 * `request_id` lets a user quote one value that finds the matching server log line.
 */
function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const request_id = req.requestId;
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details, request_id } });
    return;
  }

  // body-parser errors (malformed JSON, payload too large) carry a status and a type
  const bodyErr = err as { type?: string; status?: number };
  if (bodyErr?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON', request_id } });
    return;
  }
  if (bodyErr?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large', request_id } });
    return;
  }

  // Unexpected: log the detail server-side, never leak internals to the client
  console.error('[unhandled]', `request_id=${request_id}`, err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong', request_id } });
}
