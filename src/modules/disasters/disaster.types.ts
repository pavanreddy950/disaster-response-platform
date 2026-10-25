import type { LocationSource } from '../../integrations/geocoding/locationResolver.js';

// Order matters: it is the natural lifecycle order, used by GET /lifecycle and the stats breakdown.
export const DISASTER_STATUSES = ['reported', 'verified', 'active', 'contained', 'resolved'] as const;
export type DisasterStatus = (typeof DISASTER_STATUSES)[number];

export interface DisasterLocation {
  name: string | null;
  lat: number | null;
  lng: number | null;
  source: LocationSource;
}

export interface Disaster {
  id: string;
  title: string;
  description: string;
  location: DisasterLocation;
  tags: string[];
  status: DisasterStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export const AUDIT_ACTIONS = ['created', 'updated', 'status_changed', 'deleted'] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Field-level diff, keyed by dotted path: `{ "status": { from: "reported", to: "verified" } }`. */
export type FieldChanges = Record<string, { from: unknown; to: unknown }>;

/** One row of a disaster's audit trail (`disaster_events`). */
export interface AuditEntry {
  id: number;
  action: AuditAction;
  actor: string;
  changes: FieldChanges;
  at: string;
}

export type NewAuditEntry = Omit<AuditEntry, 'id'>;
