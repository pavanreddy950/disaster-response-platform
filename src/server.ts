import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/connection.js';
import { ReadThroughCache, SqliteCacheStore } from './lib/cache.js';
import { CachedGeocoder, FallbackGeocoder, MockGeocoder, NominatimGeocoder } from './integrations/geocoding/geocoders.js';
import type { Geocoder } from './integrations/geocoding/types.js';
import { HttpSocialMediaClient } from './integrations/social/socialClient.js';

const config = loadConfig();
const db = openDatabase(config.DATABASE_PATH);

// Geocoding: optional real provider with the offline gazetteer as fallback, cached persistently in SQLite.
const baseGeocoder: Geocoder =
  config.GEOCODER === 'nominatim'
    ? new FallbackGeocoder(
        new NominatimGeocoder({
          baseUrl: config.NOMINATIM_URL,
          userAgent: config.GEOCODER_USER_AGENT,
          timeoutMs: config.EXTERNAL_TIMEOUT_MS,
          retries: config.EXTERNAL_RETRIES,
        }),
        new MockGeocoder(),
      )
    : new MockGeocoder();
const geocoder = new CachedGeocoder(
  baseGeocoder,
  new ReadThroughCache(new SqliteCacheStore(db)),
  config.GEOCODE_CACHE_TTL_SECONDS,
);

const socialClient = new HttpSocialMediaClient({
  baseUrl: config.SOCIAL_API_URL || `http://localhost:${config.PORT}/mock/social`,
  timeoutMs: config.EXTERNAL_TIMEOUT_MS,
  retries: config.EXTERNAL_RETRIES,
});

const { app } = createApp({ db, config, geocoder, socialClient, logRequests: true });

const server = app.listen(config.PORT, () => {
  console.log(`Disaster Response API listening on http://localhost:${config.PORT}`);
  console.log(`  API docs:        http://localhost:${config.PORT}/docs.html`);
  console.log(`  Live event feed: http://localhost:${config.PORT}/`);
  console.log(`  Geocoder: ${geocoder.name}`);
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  server.closeAllConnections(); // SSE streams would otherwise keep the server open
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
