interface Entry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Small in-process TTL cache. Upstream providers either rate-limit us
 * (Tankerkönig, Overpass) or charge per call, and a corridor search fires many
 * overlapping circle queries, so caching by request key matters.
 *
 * In-process is deliberate: a single Fly machine is the deployment target, and
 * losing the cache on restart costs nothing but a few extra upstream calls.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh insertion order so the LRU eviction below keeps hot keys.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /**
   * Returns the cached value, or runs `load` and caches it. Concurrent callers
   * for the same key share one in-flight request rather than each firing their
   * own — the corridor searches hit this constantly.
   */
  async wrap(key: string, load: () => Promise<T>): Promise<{ value: T; cached: boolean }> {
    const hit = this.get(key);
    if (hit !== undefined) return { value: hit, cached: true };

    const existing = this.inflight.get(key);
    if (existing) return { value: await existing, cached: true };

    const promise = load()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return { value: await promise, cached: false };
  }

  clear(): void {
    this.entries.clear();
  }
}
