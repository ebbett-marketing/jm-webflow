// Small memory in Webflow Cloud's Key Value Store (binding SYNC_STATE):
//   hash:<item id>     hash of the item's fields at its last crawl, to skip re-publishes with nothing new
//   budget:<YYYY-MM-DD> crawl requests made that UTC day
//   event:<newest-first time>:<rand>  what each webhook did, kept 7 days, read by GET /api/recent
// KV is eventually consistent and allows one write per key per second, so all of these are soft: if the
// store is missing or a call fails, the sync still runs (it just can't skip duplicates).

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  list?(options: { prefix?: string; limit?: number }): Promise<{ keys: { name: string }[] }>;
}

const DAY = 24 * 60 * 60;
// Keys sort ascending, so count down from a far-future time to list the newest events first.
const EVENT_CLOCK = 10_000_000_000_000;

export class SyncState {
  private kv?: KVLike;

  constructor(kv?: KVLike) {
    this.kv = kv;
  }

  get available(): boolean {
    return !!this.kv;
  }

  async lastHash(itemId: string): Promise<string | null> {
    if (!this.kv || !itemId) return null;
    try {
      return await this.kv.get(`hash:${itemId}`);
    } catch {
      return null;
    }
  }

  async saveHash(itemId: string, hash: string): Promise<void> {
    if (!this.kv || !itemId) return;
    try {
      await this.kv.put(`hash:${itemId}`, hash, { expirationTtl: 90 * DAY });
    } catch {
      /* best effort */
    }
  }

  /** Keep a short record of what a webhook did, for GET /api/recent. */
  async record(entry: Record<string, unknown>, now = Date.now()): Promise<void> {
    if (!this.kv) return;
    const key = `event:${String(EVENT_CLOCK - now).padStart(13, '0')}:${Math.random().toString(36).slice(2, 7)}`;
    try {
      await this.kv.put(key, JSON.stringify({ at: new Date(now).toISOString(), ...entry }), {
        expirationTtl: 7 * DAY,
      });
    } catch {
      /* best effort */
    }
  }

  /** The most recent recorded events, newest first. */
  async recent(limit = 30): Promise<unknown[]> {
    if (!this.kv?.list) return [];
    const { keys } = await this.kv.list({ prefix: 'event:', limit });
    const values = await Promise.all(keys.map((k) => this.kv!.get(k.name)));
    return values.flatMap((value) => {
      try {
        return value ? [JSON.parse(value)] : [];
      } catch {
        return [];
      }
    });
  }

  /** Count one crawl request against today's budget; false when the budget is spent. */
  async takeCrawl(limit: number, now = new Date()): Promise<boolean> {
    if (!this.kv) return true;
    const key = `budget:${now.toISOString().slice(0, 10)}`;
    try {
      const used = Number((await this.kv.get(key)) ?? 0) || 0;
      if (used >= limit) return false;
      await this.kv.put(key, String(used + 1), { expirationTtl: 2 * DAY });
    } catch {
      /* best effort */
    }
    return true;
  }
}
