import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

// Bounded charset/length: the id is echoed into headers and logs, so arbitrary client input is not trusted.
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Correlates one request across client, logs and error responses. An upstream id (proxy, client
 * retry) is reused when well-formed so a single operation keeps one id end to end.
 */
export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header('x-request-id');
  const id = incoming && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
