import { Router } from 'express';

/**
 * Stand-in for an external social-media API (think Twitter/X search), mounted at
 * /mock/social so the app calls it over real HTTP. It:
 *   - returns a raw, non-normalised payload
 *   - adds latency and fails randomly (503) at a configurable rate
 *   - occasionally includes a malformed post, to exercise normalisation
 * Results are deterministic per query so caching behaviour is observable.
 */
export function mockSocialRouter(opts: { failureRate: number; latencyMs: number }): Router {
  const router = Router();
  let requestCount = 0;

  router.get('/posts', async (req, res) => {
    requestCount++;
    res.setHeader('X-Mock-Request-Count', String(requestCount));
    if (opts.latencyMs > 0) await new Promise((r) => setTimeout(r, opts.latencyMs));

    if (Math.random() < opts.failureRate) {
      res.status(503).json({ error: 'upstream temporarily unavailable' });
      return;
    }

    const q = String(req.query.q ?? '').slice(0, 100) || 'the area';
    res.json({ statuses: generatePosts(q) });
  });

  return router;
}

const TEMPLATES = [
  'Need drinking water near {q}',
  'URGENT: family trapped on rooftop in {q}, please send rescue',
  'Shelter at the community school in {q} is open and has space',
  'Roads blocked around {q}, avoid travel',
  'Volunteers distributing food in {q} this evening',
  'Elderly neighbour needs medical help in {q}, injured and cannot move',
  'Power is out across {q} since morning',
];
const USERS = ['citizen123', 'reliefwatch', 'localnews_live', 'priya_k', 'rescue_vol', 'jdoe', 'cityalerts'];

function generatePosts(q: string) {
  const seed = [...q].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const now = Date.now();
  const posts: unknown[] = TEMPLATES.map((template, i) => ({
    id_str: `${seed}-${i}`,
    text: template.replace('{q}', q),
    author: { handle: USERS[(seed + i) % USERS.length] },
    timestamp_ms: String(now - ((seed >> i) % 120 + i * 7) * 60_000),
    lang: 'en',
  }));
  // A malformed item, as real APIs sometimes return (missing text)
  posts.push({ id_str: `${seed}-x`, author: null, timestamp_ms: 'not-a-number' });
  return posts;
}
