import { UnprocessableError } from '../../lib/errors.js';
import { boundingBoxes, haversineKm, type LatLng } from '../../lib/geo.js';
import type { Disaster } from '../disasters/disaster.types.js';
import type { Resource, ResourceRepository } from './resource.repository.js';
import type { CreateResourceInput, ResourceType } from './resource.schemas.js';

export interface NearbyResource extends Resource {
  distance_km: number;
}

export interface NearbyQuery {
  lat?: number | undefined;
  lng?: number | undefined;
  radius: number;
  type?: ResourceType | undefined;
  limit: number;
}

export class ResourceService {
  constructor(
    private readonly repo: ResourceRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(input: CreateResourceInput): Resource {
    return this.repo.insert(input, this.now().toISOString());
  }

  list(opts: { type?: ResourceType | undefined; limit: number; offset: number }) {
    return this.repo.list({ ...opts, type: opts.type });
  }

  /**
   * Resources within `radius` km of the search centre, nearest first.
   * Centre = explicit lat/lng from the query, otherwise the disaster's resolved location.
   *
   * Two-phase search:
   *   1. R*Tree bounding-box lookup (indexed, coarse: a square around the circle)
   *   2. exact haversine distance filter + sort (only over the small candidate set)
   */
  nearbyForDisaster(disaster: Disaster, q: NearbyQuery) {
    const center = this.searchCenter(disaster, q);
    const candidates = this.repo.findInBoxes(boundingBoxes(center.point, q.radius), q.type);

    const data: NearbyResource[] = candidates
      .map((r) => ({ ...r, distance_km: round(haversineKm(center.point, r.location), 3) }))
      .filter((r) => r.distance_km <= q.radius)
      .sort((a, b) => a.distance_km - b.distance_km || a.id - b.id)
      .slice(0, q.limit);

    return {
      center: { ...center.point, source: center.source },
      radius_km: q.radius,
      count: data.length,
      data,
    };
  }

  private searchCenter(disaster: Disaster, q: NearbyQuery): { point: LatLng; source: 'query' | 'disaster' } {
    if (q.lat !== undefined && q.lng !== undefined) return { point: { lat: q.lat, lng: q.lng }, source: 'query' };
    const { lat, lng } = disaster.location;
    if (lat === null || lng === null) {
      throw new UnprocessableError(
        'LOCATION_UNRESOLVED',
        'Disaster has no resolved coordinates; pass lat and lng query parameters',
      );
    }
    return { point: { lat, lng }, source: 'disaster' };
  }
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;
