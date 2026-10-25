import { Router } from 'express';
import type { EventBus } from './events.js';

const HEARTBEAT_MS = 25_000;

/**
 * Server-Sent Events stream at GET /events.
 * SSE fits this use case: updates flow one way (server -> client), it runs over
 * plain HTTP, and browsers reconnect automatically.
 *
 * Optional filter: /events?disaster_id=<id> to follow a single incident.
 */
export function sseRouter(events: EventBus): Router {
  const router = Router();

  router.get('/events', (req, res) => {
    const filterId = typeof req.query.disaster_id === 'string' ? req.query.disaster_id : undefined;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy buffering (nginx)
    });
    res.write(`retry: 3000\n`);
    res.write(`event: connected\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

    const unsubscribe = events.subscribe((event) => {
      if (filterId && event.disaster.id !== filterId) return;
      res.write(`id: ${Date.now()}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });

    // Comment lines keep idle connections alive through proxies/load balancers.
    const heartbeat = setInterval(() => res.write(`: ping\n\n`), HEARTBEAT_MS);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return router;
}
