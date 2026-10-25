import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';
import { findUserByToken, type Role, type User } from './users.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

/** Authenticates `Authorization: Bearer <token>` against the mock user store. */
export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.header('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) throw new UnauthorizedError();

  const user = findUserByToken(token);
  if (!user) throw new UnauthorizedError('Invalid token');
  req.user = user;
  next();
}

/** Role-based gate. Resource-level rules (ownership etc.) live in the services. */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw new UnauthorizedError();
    if (!roles.includes(req.user.role)) {
      throw new ForbiddenError(`Requires role: ${roles.join(' or ')}`);
    }
    next();
  };
}

/** Narrowing helper for handlers that run after `authenticate`. */
export function currentUser(req: Request): User {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}
