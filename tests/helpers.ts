import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db/connection.js';
import { MockGeocoder } from '../src/integrations/geocoding/geocoders.js';
import type { Geocoder } from '../src/integrations/geocoding/types.js';
import type { CommunityReport, SocialMediaClient } from '../src/integrations/social/socialClient.js';

export const ADMIN = { Authorization: 'Bearer admin-token' };
export const CONTRIBUTOR = { Authorization: 'Bearer contributor-token' };
export const CONTRIBUTOR_2 = { Authorization: 'Bearer contributor2-token' };

/** Controllable fake for the social-media integration; counts upstream calls. */
export class FakeSocialClient implements SocialMediaClient {
  calls = 0;
  fail = false;
  reports: CommunityReport[] = [
    { id: '1', content: 'Need drinking water near Manhattan', user: 'citizen123', created_at: '2026-10-25T10:00:00.000Z', source: 'fake' },
    { id: '2', content: 'URGENT: people trapped in a basement', user: 'rescue_vol', created_at: '2026-10-25T09:00:00.000Z', source: 'fake' },
    { id: '3', content: 'Power restored on 5th avenue', user: 'cityalerts', created_at: '2026-10-25T11:00:00.000Z', source: 'fake' },
  ];

  async search(_query: string): Promise<CommunityReport[]> {
    this.calls++;
    if (this.fail) {
      const { ExternalServiceError } = await import('../src/lib/errors.js');
      throw new ExternalServiceError('social-media', 'HTTP 503', true, 503);
    }
    return this.reports;
  }
}

export function buildTestApp(overrides: { geocoder?: Geocoder; env?: Record<string, string> } = {}) {
  const db = openDatabase(':memory:');
  const config = loadConfig({ REPORTS_CACHE_TTL_SECONDS: '60', ...overrides.env } as NodeJS.ProcessEnv);
  const social = new FakeSocialClient();
  const { app, events } = createApp({
    db,
    config,
    geocoder: overrides.geocoder ?? new MockGeocoder(),
    socialClient: social,
    mountMockSocial: false,
  });
  return { app, db, events, social };
}
