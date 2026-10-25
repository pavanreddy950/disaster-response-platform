import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/connection.js';
import { ReadThroughCache, SqliteCacheStore } from '../src/lib/cache.js';
import { ExternalServiceError } from '../src/lib/errors.js';
import { fetchJson } from '../src/lib/http.js';
import { RuleBasedLocationExtractor } from '../src/integrations/geocoding/extractor.js';
import { CachedGeocoder, FallbackGeocoder, MockGeocoder } from '../src/integrations/geocoding/geocoders.js';
import type { Geocoder } from '../src/integrations/geocoding/types.js';

describe('location extraction', () => {
  const extractor = new RuleBasedLocationExtractor();
  it.each([
    ['Heavy flooding has affected Manhattan, NYC.', 'Manhattan, NYC'],
    ['Earthquake near Tokyo. Residents evacuated.', 'Tokyo'],
    ['Wildfire spreading in the San Francisco bay area', 'San Francisco'],
    ['severe waterlogging reported across mumbai today', 'Mumbai'], // lowercase: gazetteer fallback
    ['something bad happened somewhere', null],
  ])('%s -> %s', async (text, expected) => {
    expect(await extractor.extract(text)).toBe(expected);
  });
});

describe('geocoder resilience', () => {
  const failing: Geocoder = {
    name: 'failing',
    geocode: async () => {
      throw new ExternalServiceError('failing', 'down', true);
    },
  };

  it('falls back to the secondary geocoder when the primary fails', async () => {
    const geocoder = new FallbackGeocoder(failing, new MockGeocoder(), () => {});
    expect(await geocoder.geocode('Mumbai')).toMatchObject({ lat: 19.076 });
  });

  it('caches results persistently so repeated lookups skip the provider', async () => {
    let calls = 0;
    const counting: Geocoder = {
      name: 'counting',
      geocode: async (q) => {
        calls++;
        return new MockGeocoder().geocode(q);
      },
    };
    const geocoder = new CachedGeocoder(counting, new ReadThroughCache(new SqliteCacheStore(openDatabase(':memory:'))), 3600);
    await geocoder.geocode('Chennai');
    await geocoder.geocode('  chennai ');
    expect(calls).toBe(1);
  });
});

describe('fetchJson retry policy', () => {
  let server: Server;
  afterEach(() => server?.close());

  function serve(statuses: number[]) {
    let i = 0;
    server = createServer((_req, res) => {
      const status = statuses[Math.min(i++, statuses.length - 1)]!;
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: status === 200 }));
    });
    return new Promise<{ url: string; count: () => number }>((resolve) =>
      server.listen(0, () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, count: () => i })),
    );
  }

  it('retries 5xx responses and succeeds', async () => {
    const { url, count } = await serve([503, 503, 200]);
    await expect(fetchJson(url, { service: 't', timeoutMs: 1000, retries: 2, baseDelayMs: 1 })).resolves.toEqual({ ok: true });
    expect(count()).toBe(3);
  });

  it('does not retry 4xx responses', async () => {
    const { url, count } = await serve([404, 200]);
    await expect(fetchJson(url, { service: 't', timeoutMs: 1000, retries: 2, baseDelayMs: 1 })).rejects.toMatchObject({
      httpStatus: 404,
      retryable: false,
    });
    expect(count()).toBe(1);
  });
});
