/**
 * Application errors carry an HTTP status and a stable machine-readable code.
 * Anything that is not an AppError is treated as an unexpected 500.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(details: unknown, message = 'Request validation failed') {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string | number) {
    super(404, 'NOT_FOUND', `${resource} '${id}' not found`);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Missing or invalid credentials') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string) {
    super(403, 'FORBIDDEN', message);
  }
}

/** The request is valid on its own but conflicts with the resource's current state. */
export class ConflictError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(409, code, message, details);
  }
}

/** Carries the wait time so the limiter middleware can set `Retry-After`. */
export class RateLimitError extends AppError {
  constructor(public readonly retryAfterSeconds: number, limit: number) {
    super(429, 'RATE_LIMITED', `Too many write requests; retry in ${retryAfterSeconds}s`, {
      limit_per_minute: limit,
      retry_after_seconds: retryAfterSeconds,
    });
  }
}

export class UnprocessableError extends AppError {
  constructor(code: string, message: string) {
    super(422, code, message);
  }
}

/** Raised by integration clients; `retryable` drives the retry policy in fetchJson. */
export class ExternalServiceError extends Error {
  constructor(
    public readonly service: string,
    message: string,
    public readonly retryable: boolean,
    public readonly httpStatus?: number,
  ) {
    super(`${service}: ${message}`);
    this.name = 'ExternalServiceError';
  }
}
