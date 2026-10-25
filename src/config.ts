import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_PATH: z.string().default('./data/app.db'),
  GEOCODER: z.enum(['mock', 'nominatim']).default('mock'),
  NOMINATIM_URL: z.string().default('https://nominatim.openstreetmap.org'),
  GEOCODER_USER_AGENT: z.string().default('disaster-response-assignment/1.0'),
  SOCIAL_API_URL: z.string().default(''),
  SOCIAL_MOCK_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0.2),
  SOCIAL_MOCK_LATENCY_MS: z.coerce.number().int().min(0).default(300),
  EXTERNAL_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  EXTERNAL_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  REPORTS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  GEOCODE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(7 * 24 * 3600),
  RATE_LIMIT_WRITES_PER_MINUTE: z.coerce.number().int().positive().default(60),
});

export type Config = z.infer<typeof schema>;

/** Parses environment variables once at startup; fails fast on invalid config. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return parsed.data;
}
