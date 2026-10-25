export interface GeoPoint {
  lat: number;
  lng: number;
  /** Canonical name returned by the provider. */
  displayName: string;
}

export interface Geocoder {
  readonly name: string;
  /** Returns null when the place is unknown; throws ExternalServiceError when the provider fails. */
  geocode(query: string): Promise<GeoPoint | null>;
}

/** Pulls a place name out of free text. Pluggable so an LLM-backed extractor can replace the rule-based one. */
export interface LocationExtractor {
  extract(text: string): Promise<string | null>;
}
