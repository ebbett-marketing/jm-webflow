// Small memory in Webflow Cloud's Key Value Store (binding SYNC_STATE):
//   hash:<item id>     hash of the item's fields at its last crawl, to skip re-publishes with nothing new
//   budget:<YYYY-MM-DD> crawl requests made that UTC day
// KV is eventually consistent and allows one write per key per second, so both are soft guards: if the
// store is missing or a call fails, the sync still runs (it just can't skip duplicates).

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

const DAY = 24 * 60 * 60;

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
