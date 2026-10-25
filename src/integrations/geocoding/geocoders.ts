import { fetchJson } from '../../lib/http.js';
import { ReadThroughCache } from '../../lib/cache.js';
import { lookupPlace } from './gazetteer.js';
import type { GeoPoint, Geocoder } from './types.js';

/** Offline geocoder backed by a static gazetteer. Default, so the project runs with no API keys. */
export class MockGeocoder implements Geocoder {
  readonly name = 'mock';
  async geocode(query: string): Promise<GeoPoint | null> {
    return lookupPlace(query);
  }
}

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
}

/** OpenStreetMap Nominatim (free, keyless; requires an identifying User-Agent, ~1 req/s). */
export class NominatimGeocoder implements Geocoder {
  readonly name = 'nominatim';

  constructor(
    private readonly opts: { baseUrl: string; userAgent: string; timeoutMs: number; retries: number },
  ) {}

  async geocode(query: string): Promise<GeoPoint | null> {
    const url = `${this.opts.baseUrl}/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
    const results = await fetchJson<NominatimResult[]>(url, {
      service: 'nominatim',
      timeoutMs: this.opts.timeoutMs,
      retries: this.opts.retries,
      headers: { 'User-Agent': this.opts.userAgent },
    });

    const first = Array.isArray(results) ? results[0] : undefined;
    if (!first) return null;
    const lat = Number(first.lat);
    const lng = Number(first.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng, displayName: first.display_name };
  }
}

/** Tries `primary`; on error *or* no result, falls back to `secondary`. */
export class FallbackGeocoder implements Geocoder {
  readonly name: string;

  constructor(
    private readonly primary: Geocoder,
    private readonly secondary: Geocoder,
    private readonly log: (msg: string) => void = console.warn,
  ) {
    this.name = `${primary.name}->${secondary.name}`;
  }

  async geocode(query: string): Promise<GeoPoint | null> {
    try {
      const result = await this.primary.geocode(query);
      if (result) return result;
    } catch (err) {
      this.log(`[geocoder] ${this.primary.name} failed, falling back to ${this.secondary.name}: ${(err as Error).message}`);
    }
    return this.secondary.geocode(query);
  }
}

/**
 * Caches geocoding results (place names do not move). Negative results are cached
 * for a shorter time so a typo does not hit the provider on every request, but a
 * provider that was briefly missing data recovers within the hour.
 */
export class CachedGeocoder implements Geocoder {
  readonly name: string;
  private static readonly NEGATIVE_TTL_SECONDS = 3600;

  constructor(
    private readonly inner: Geocoder,
    private readonly cache: ReadThroughCache,
    private readonly ttlSeconds: number,
  ) {
    this.name = `cached(${inner.name})`;
  }

  async geocode(query: string): Promise<GeoPoint | null> {
    const key = `geo:${this.inner.name}:${query.toLowerCase().replace(/\s+/g, ' ').trim()}`;
    const result = await this.cache.get<GeoPoint | null>(
      key,
      (value) => (value ? this.ttlSeconds : CachedGeocoder.NEGATIVE_TTL_SECONDS),
      () => this.inner.geocode(query),
    );
    return result.value;
  }
}
