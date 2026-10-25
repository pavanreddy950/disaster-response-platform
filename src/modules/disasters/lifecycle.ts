import type { User } from '../../auth/users.js';
import { ConflictError, ForbiddenError } from '../../lib/errors.js';
import { DISASTER_STATUSES, type DisasterStatus } from './disaster.types.js';

/**
 * The incident lifecycle as data: the single source of truth for which status changes are legal.
 * Services enforce it and GET /lifecycle publishes it, so clients render only valid actions
 * instead of duplicating the rules.
 *
 *   reported ──► verified ──► active ◄──► contained
 *       │            │           │            │
 *       └────────────┴───────────┴────────────┴──► resolved ──(admin only)──► active
 *
 * `resolved` is reachable from every open state: from `reported`/`verified` it means
 * "false alarm / duplicate", later it means the incident is over.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<DisasterStatus, readonly DisasterStatus[]>> = {
  reported: ['verified', 'resolved'],
  verified: ['active', 'resolved'],
  active: ['contained', 'resolved'],
  contained: ['active', 'resolved'],
  resolved: ['active'],
};

/** Statuses a new disaster may start in; skipping ahead past `active` on creation would bypass the lifecycle. */
export const INITIAL_STATUSES = ['reported', 'verified', 'active'] as const satisfies readonly DisasterStatus[];

/** Leaving `resolved` (reopening) is restricted to admins: a closed incident should not silently come back. */
export const ADMIN_ONLY_TRANSITIONS = ALLOWED_TRANSITIONS.resolved.map((to) => ({ from: 'resolved' as const, to }));

/**
 * Throws unless `user` may move a disaster from `from` to `to`. Same status is a no-op and always allowed.
 * The reopen rule is checked before the transition table so a contributor trying to reopen gets the
 * more useful 403 ("ask an admin") rather than a 409 listing transitions they could not use anyway.
 */
export function assertTransitionAllowed(from: DisasterStatus, to: DisasterStatus, user: User): void {
  if (from === to) return;
  if (from === 'resolved' && user.role !== 'admin') {
    throw new ForbiddenError('Only admins can reopen a resolved disaster');
  }
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new ConflictError('INVALID_STATUS_TRANSITION', `Cannot change status from ${from} to ${to}`, {
      from,
      to,
      allowed,
    });
  }
}

/** Public description of the lifecycle (GET /lifecycle). */
export function describeLifecycle() {
  return {
    statuses: [...DISASTER_STATUSES],
    initial: [...INITIAL_STATUSES],
    transitions: ALLOWED_TRANSITIONS,
    admin_only: ADMIN_ONLY_TRANSITIONS,
  };
}
