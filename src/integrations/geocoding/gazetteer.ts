import type { GeoPoint } from './types.js';

/** Small offline gazetteer for the mock geocoder (keys are lowercase). */
const PLACES: Record<string, GeoPoint> = {
  manhattan: { lat: 40.7831, lng: -73.9712, displayName: 'Manhattan, New York, USA' },
  brooklyn: { lat: 40.6782, lng: -73.9442, displayName: 'Brooklyn, New York, USA' },
  queens: { lat: 40.7282, lng: -73.7949, displayName: 'Queens, New York, USA' },
  'new york': { lat: 40.7128, lng: -74.006, displayName: 'New York City, USA' },
  'new york city': { lat: 40.7128, lng: -74.006, displayName: 'New York City, USA' },
  nyc: { lat: 40.7128, lng: -74.006, displayName: 'New York City, USA' },
  'new orleans': { lat: 29.9511, lng: -90.0715, displayName: 'New Orleans, Louisiana, USA' },
  houston: { lat: 29.7604, lng: -95.3698, displayName: 'Houston, Texas, USA' },
  'los angeles': { lat: 34.0522, lng: -118.2437, displayName: 'Los Angeles, California, USA' },
  'san francisco': { lat: 37.7749, lng: -122.4194, displayName: 'San Francisco, California, USA' },
  london: { lat: 51.5072, lng: -0.1276, displayName: 'London, UK' },
  tokyo: { lat: 35.6762, lng: 139.6503, displayName: 'Tokyo, Japan' },
  mumbai: { lat: 19.076, lng: 72.8777, displayName: 'Mumbai, Maharashtra, India' },
  delhi: { lat: 28.6139, lng: 77.209, displayName: 'Delhi, India' },
  'new delhi': { lat: 28.6139, lng: 77.209, displayName: 'New Delhi, India' },
  chennai: { lat: 13.0827, lng: 80.2707, displayName: 'Chennai, Tamil Nadu, India' },
  kolkata: { lat: 22.5726, lng: 88.3639, displayName: 'Kolkata, West Bengal, India' },
  bengaluru: { lat: 12.9716, lng: 77.5946, displayName: 'Bengaluru, Karnataka, India' },
  bangalore: { lat: 12.9716, lng: 77.5946, displayName: 'Bengaluru, Karnataka, India' },
  hyderabad: { lat: 17.385, lng: 78.4867, displayName: 'Hyderabad, Telangana, India' },
  kochi: { lat: 9.9312, lng: 76.2673, displayName: 'Kochi, Kerala, India' },
  kerala: { lat: 10.8505, lng: 76.2711, displayName: 'Kerala, India' },
  assam: { lat: 26.2006, lng: 92.9376, displayName: 'Assam, India' },
  guwahati: { lat: 26.1445, lng: 91.7362, displayName: 'Guwahati, Assam, India' },
  odisha: { lat: 20.9517, lng: 85.0985, displayName: 'Odisha, India' },
  fiji: { lat: -17.7134, lng: 178.065, displayName: 'Fiji' },
};

export const GAZETTEER_NAMES = Object.keys(PLACES);

/**
 * Resolves a query like "Manhattan, NYC": tries the full string, then each
 * comma-separated part from most to least specific (left to right).
 */
export function lookupPlace(query: string): GeoPoint | null {
  const normalized = query.toLowerCase().replace(/\s+/g, ' ').trim();
  if (Object.hasOwn(PLACES, normalized)) return PLACES[normalized] ?? null;

  for (const part of normalized.split(',').map((p) => p.trim())) {
    if (part && Object.hasOwn(PLACES, part)) return PLACES[part] ?? null;
  }
  return null;
}
