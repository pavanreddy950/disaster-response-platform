import type { LocationSource } from '../../integrations/geocoding/locationResolver.js';

export const DISASTER_STATUSES = ['reported', 'active', 'contained', 'resolved'] as const;
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
