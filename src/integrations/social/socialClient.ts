import { fetchJson } from '../../lib/http.js';

/** Normalised community report: the only shape the rest of the app sees. */
export interface CommunityReport {
  id: string;
  content: string;
  user: string;
  created_at: string;
  source: string;
}

export interface SocialMediaClient {
  search(query: string): Promise<CommunityReport[]>;
}

/** Raw upstream shape (deliberately different from ours, like a real third-party API). */
interface RawPost {
  id_str?: unknown;
  text?: unknown;
  author?: { handle?: unknown } | null;
  timestamp_ms?: unknown;
}

interface RawSearchResponse {
  statuses?: RawPost[];
}

export class HttpSocialMediaClient implements SocialMediaClient {
  constructor(
    private readonly opts: { baseUrl: string; timeoutMs: number; retries: number },
    private readonly log: (msg: string) => void = console.warn,
  ) {}

  async search(query: string): Promise<CommunityReport[]> {
    const url = `${this.opts.baseUrl}/posts?q=${encodeURIComponent(query)}`;
    const body = await fetchJson<RawSearchResponse>(url, {
      service: 'social-media',
      timeoutMs: this.opts.timeoutMs,
      retries: this.opts.retries,
    });
    return normalizePosts(body, this.log);
  }
}

/**
 * Maps the upstream payload to CommunityReport. Malformed items are dropped
 * individually (and logged) instead of failing the whole response.
 */
export function normalizePosts(body: RawSearchResponse, log: (msg: string) => void = () => {}): CommunityReport[] {
  const posts = Array.isArray(body?.statuses) ? body.statuses : [];
  const reports: CommunityReport[] = [];
  let dropped = 0;

  for (const post of posts) {
    const content = typeof post?.text === 'string' ? post.text.trim() : '';
    const id = typeof post?.id_str === 'string' ? post.id_str : null;
    const ts = Number(post?.timestamp_ms);
    if (!content || !id || !Number.isFinite(ts)) {
      dropped++;
      continue;
    }
    const handle = typeof post.author?.handle === 'string' && post.author.handle ? post.author.handle : 'anonymous';
    reports.push({
      id,
      content,
      user: handle,
      created_at: new Date(ts).toISOString(),
      source: 'mock-social',
    });
  }

  if (dropped > 0) log(`[social] dropped ${dropped} malformed post(s)`);
  return reports;
}
