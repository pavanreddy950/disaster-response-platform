const EARTH_RADIUS_KM = 6371.0088;
const KM_PER_DEGREE_LAT = 111.32;

export interface LatLng {
  lat: number;
  lng: number;
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres (haversine formula). */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Bounding boxes that fully contain the circle of `radiusKm` around `center`.
 * Used as a cheap index pre-filter; callers must still apply the exact haversine check.
 *
 * Edge cases:
 *  - near the poles the longitude span degenerates, so we search all longitudes
 *  - a circle crossing the antimeridian (±180°) is split into two boxes
 */
export function boundingBoxes(center: LatLng, radiusKm: number): BoundingBox[] {
  const dLat = radiusKm / KM_PER_DEGREE_LAT;
  const minLat = Math.max(-90, center.lat - dLat);
  const maxLat = Math.min(90, center.lat + dLat);

  const cosLat = Math.cos(toRad(center.lat));
  // Within ~1km of a pole, or circle reaching over it: every longitude is in range.
  if (minLat <= -90 || maxLat >= 90 || cosLat < 1e-6) {
    return [{ minLat, maxLat, minLng: -180, maxLng: 180 }];
  }

  const dLng = radiusKm / (KM_PER_DEGREE_LAT * cosLat);
  if (dLng >= 180) return [{ minLat, maxLat, minLng: -180, maxLng: 180 }];

  const minLng = center.lng - dLng;
  const maxLng = center.lng + dLng;

  if (minLng < -180) {
    return [
      { minLat, maxLat, minLng: minLng + 360, maxLng: 180 },
      { minLat, maxLat, minLng: -180, maxLng },
    ];
  }
  if (maxLng > 180) {
    return [
      { minLat, maxLat, minLng, maxLng: 180 },
      { minLat, maxLat, minLng: -180, maxLng: maxLng - 360 },
    ];
  }
  return [{ minLat, maxLat, minLng, maxLng }];
}
