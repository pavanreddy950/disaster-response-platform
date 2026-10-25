import type Database from 'better-sqlite3';

export interface CacheEntry<T> {
  value: T;
  /** Epoch millis after which the entry is stale (but may still be served on upstream failure). */
  expiresAt: number;
}

/** Storage backend. Entries outlive their TTL so they can be served stale when upstream fails. */
export interface CacheStore {
  get<T>(key: string): CacheEntry<T> | undefined;
  set<T>(key: string, entry: CacheEntry<T>): void;
}

/** Bounded in-process store. Map preserves insertion order, so evicting the first key is FIFO/LRU-ish. */
export class MemoryCacheStore implements CacheStore {
  private readonly map = new Map<string, CacheEntry<unknown>>();

  constructor(private readonly maxEntries = 1000) {}

  get<T>(key: string): CacheEntry<T> | undefined {
    const entry = this.map.get(key);
    if (entry) {
      // refresh recency
      this.map.delete(key);
      this.map.set(key, entry);
    }
    return entry as CacheEntry<T> | undefined;
  }

  set<T>(key: string, entry: CacheEntry<T>): void {
    this.map.delete(key);
    this.map.set(key, entry);
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}

/** Persistent store backed by the `external_cache` table; survives restarts (used for geocoding). */
export class SqliteCacheStore implements CacheStore {
  private readonly getStmt;
  private readonly setStmt;

  constructor(db: Database.Database) {
    this.getStmt = db.prepare('SELECT value, expires_at FROM external_cache WHERE key = ?');
    this.setStmt = db.prepare(
      `INSERT INTO external_cache (key, value, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
    );
  }

  get<T>(key: string): CacheEntry<T> | undefined {
    const row = this.getStmt.get(key) as { value: string; expires_at: number } | undefined;
    if (!row) return undefined;
    return { value: JSON.parse(row.value) as T, expiresAt: row.expires_at };
  }

  set<T>(key: string, entry: CacheEntry<T>): void {
    this.setStmt.run(key, JSON.stringify(entry.value), entry.expiresAt);
  }
}

export type CacheStatus = 'HIT' | 'MISS' | 'STALE';

export interface CachedResult<T> {
  value: T;
  status: CacheStatus;
  /** When the value was obtained from upstream (epoch millis). */
  storedAt: number;
}

interface StoredValue<T> {
  data: T;
  storedAt: number;
}

/**
 * Read-through cache:
 *   fresh hit            -> return cached
 *   miss / expired       -> call loader once (concurrent callers share the same in-flight promise), store, return
 *   loader fails + stale -> return stale value (status STALE) instead of failing
 *   loader fails + none  -> rethrow
 */
export class ReadThroughCache {
  private readonly inflight = new Map<string, Promise<StoredValue<unknown>>>();

  constructor(
    private readonly store: CacheStore,
    private readonly now: () => number = Date.now,
  ) {}

  async get<T>(
    key: string,
    ttlSeconds: number | ((value: T) => number),
    loader: () => Promise<T>,
  ): Promise<CachedResult<T>> {
    const entry = this.store.get<StoredValue<T>>(key);
    if (entry && entry.expiresAt > this.now()) {
      return { value: entry.value.data, status: 'HIT', storedAt: entry.value.storedAt };
    }

    try {
      const stored = await this.loadOnce(key, ttlSeconds, loader);
      return { value: stored.data, status: 'MISS', storedAt: stored.storedAt };
    } catch (err) {
      if (entry) {
        return { value: entry.value.data, status: 'STALE', storedAt: entry.value.storedAt };
      }
      throw err;
    }
  }

  private loadOnce<T>(
    key: string,
    ttlSeconds: number | ((value: T) => number),
    loader: () => Promise<T>,
  ): Promise<StoredValue<T>> {
    const pending = this.inflight.get(key) as Promise<StoredValue<T>> | undefined;
    if (pending) return pending;

    const promise = (async () => {
      const data = await loader();
      const storedAt = this.now();
      const ttl = typeof ttlSeconds === 'function' ? ttlSeconds(data) : ttlSeconds;
      const value: StoredValue<T> = { data, storedAt };
      this.store.set(key, { value, expiresAt: storedAt + ttl * 1000 });
      return value;
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, promise);
    return promise;
  }
}
