import type { CommunityReport, SocialMediaClient } from '../../integrations/social/socialClient.js';
import { AppError, ExternalServiceError } from '../../lib/errors.js';
import type { CacheStatus, ReadThroughCache } from '../../lib/cache.js';
import type { Disaster } from '../disasters/disaster.types.js';
import { classifyPriority, comparePriority, type Priority } from './priority.js';

export interface PrioritizedReport extends CommunityReport {
  priority: Priority;
}

export interface ReportsResult {
  data: PrioritizedReport[];
  meta: { query: string; cache: CacheStatus; fetched_at: string; count: number };
}

export class ReportService {
  constructor(
    private readonly client: SocialMediaClient,
    private readonly cache: ReadThroughCache,
    private readonly ttlSeconds: number,
  ) {}

  async forDisaster(disaster: Disaster, filter: { priority?: Priority | undefined }): Promise<ReportsResult> {
    const query = searchQueryFor(disaster);
    // Keyed by the upstream query (not disaster id): incidents in the same place share one upstream call.
    const key = `reports:${query.toLowerCase()}`;

    let result;
    try {
      result = await this.cache.get(key, this.ttlSeconds, () => this.client.search(query));
    } catch (err) {
      if (err instanceof ExternalServiceError) {
        throw new AppError(503, 'UPSTREAM_UNAVAILABLE', 'Community reports are temporarily unavailable, please retry shortly');
      }
      throw err;
    }

    // Classification is cheap and done per request so rule changes apply without waiting for cache expiry.
    let data = result.value
      .map((r) => ({ ...r, priority: classifyPriority(r.content) }))
      .sort((a, b) => comparePriority(a.priority, b.priority) || b.created_at.localeCompare(a.created_at));
    if (filter.priority) data = data.filter((r) => r.priority === filter.priority);

    return {
      data,
      meta: {
        query,
        cache: result.status,
        fetched_at: new Date(result.storedAt).toISOString(),
        count: data.length,
      },
    };
  }
}

/** The place name is the most useful search term; fall back to the title if location is unknown. */
function searchQueryFor(disaster: Disaster): string {
  return (disaster.location.name ?? disaster.title).trim();
}
