import type { Geocoder, LocationExtractor } from './types.js';

export type LocationSource = 'client' | 'geocoded' | 'unresolved';

export interface ResolvedLocation {
  name: string | null;
  lat: number | null;
  lng: number | null;
  source: LocationSource;
}

export interface LocationInput {
  description: string;
  location_name?: string | undefined;
  lat?: number | undefined;
  lng?: number | undefined;
}

/**
 * Decides where a disaster is, in priority order:
 *   1. explicit coordinates from the client       -> source "client"
 *   2. explicit location_name, else a place name extracted from the description,
 *      geocoded to coordinates                      -> source "geocoded"
 *   3. nothing found or the geocoder is down        -> source "unresolved"
 *
 * Geocoding failure never fails the request: recording an incident matters more
 * than having its coordinates immediately. Unresolved incidents are visible as such.
 */
export class LocationResolver {
  constructor(
    private readonly extractor: LocationExtractor,
    private readonly geocoder: Geocoder,
    private readonly log: (msg: string) => void = console.warn,
  ) {}

  async resolve(input: LocationInput): Promise<ResolvedLocation> {
    if (input.lat !== undefined && input.lng !== undefined) {
      return { name: input.location_name ?? null, lat: input.lat, lng: input.lng, source: 'client' };
    }

    const name = input.location_name ?? (await this.extractor.extract(input.description));
    if (!name) return { name: null, lat: null, lng: null, source: 'unresolved' };

    try {
      const point = await this.geocoder.geocode(name);
      if (point) return { name, lat: point.lat, lng: point.lng, source: 'geocoded' };
    } catch (err) {
      this.log(`[location] geocoding "${name}" failed: ${(err as Error).message}`);
    }
    return { name, lat: null, lng: null, source: 'unresolved' };
  }
}
