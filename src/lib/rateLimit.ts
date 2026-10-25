import type { NextFunction, Request, Response } from 'express';
import { findUserByToken } from '../auth/users.js';
import { RateLimitError } from './errors.js';

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

interface Window {
  startedAt: number;
  count: number;
}

/**
 * Fixed-window counter: at most `limit` hits per key per `windowMs`.
 *
 * In-memory is enough for a single node: state is tiny and losing it on restart only resets
 * counters. With several instances each node would count separately (effective limit x N), so the
 * counter would move to Redis (INCR + EXPIRE on `rl:<key>:<window>`) behind this same interface.
 */
export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, Window>();
  private lastSweep: number;

  constructor(
    readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {
    this.lastSweep = now();
  }

  /** Counts a hit; returns 0 when allowed, otherwise the seconds until the window resets. */
  hit(key: string): number {
    const now = this.now();
    this.sweep(now);

    let window = this.windows.get(key);
    if (!window || now - window.startedAt >= this.windowMs) {
      window = { startedAt: now, count: 0 };
      this.windows.set(key, window);
    }
    window.count++;
    if (window.count <= this.limit) return 0;
    return Math.max(1, Math.ceil((window.startedAt + this.windowMs - now) / 1000));
  }

  get size(): number {
    return this.windows.size;
  }

  /** Drops expired windows at most once per window, so the map only holds keys seen recently. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= this.windowMs) this.windows.delete(key);
    }
    this.lastSweep = now;
  }
}

/**
 * Limits write requests only; reads stay unthrottled. Runs before authentication, so it keys on the
 * user a valid bearer token belongs to (sharing one budget across that user's devices) and otherwise
 * on the client IP. Auth itself is still enforced later by the routes.
 */
export function rateLimitWrites(limiter: FixedWindowRateLimiter) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!WRITE_METHODS.has(req.method)) return next();

    const [scheme, token] = (req.header('authorization') ?? '').split(' ');
    const user = scheme?.toLowerCase() === 'bearer' && token ? findUserByToken(token) : undefined;
    // req.ip is the socket address unless `trust proxy` is configured behind a load balancer
    const key = user ? `user:${user.id}` : `ip:${req.ip ?? 'unknown'}`;

    const retryAfter = limiter.hit(key);
    if (retryAfter > 0) {
      res.setHeader('Retry-After', String(retryAfter));
      return next(new RateLimitError(retryAfter, limiter.limit));
    }
    next();
  };
}
