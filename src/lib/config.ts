// Settings for the stock sync. Non-secret IDs default to Johnston Motors' staging values; secrets come
// from the Webflow Cloud environment variables (see README). Plain module (no Workers imports) so the
// tests can run it in Node.

export interface SyncConfig {
  /** Origin the vehicle pages are served from, no trailing slash. Must match the crawler's pathsToMatch. */
  siteUrl: string;
  /** Stock | Vehicles collection. */
  vehicleCollectionId: string;
  /** Path prefix of the vehicle template pages. */
  vehiclePath: string;
  algoliaAppId: string;
  algoliaIndex: string;
  /** Scoped key: browse + deleteObject on the stock index only. */
  algoliaKey: string;
  crawlerId: string;
  crawlerUserId: string;
  crawlerApiKey: string;
  /** One signing secret per registered webhook (each Webflow webhook gets its own). */
  webhookSecrets: string[];
  /** Bearer token for the manual /api/reconcile endpoint. */
  adminToken: string;
  /** Wait before asking the crawler to fetch a page, so Webflow's CDN has the new version. */
  crawlDelayMs: number;
  /** Crawl requests per UTC day. The Crawler API allows 500 per 24 h; the daily scheduled crawl is the backstop. */
  dailyCrawlBudget: number;
  /** Item fields whose changes don't need a re-crawl (the daily crawl picks them up). */
  ignoredFields: string[];
}

export const REQUIRED_SECRETS = [
  'ALGOLIA_SYNC_API_KEY',
  'ALGOLIA_CRAWLER_USER_ID',
  'ALGOLIA_CRAWLER_API_KEY',
  'WEBFLOW_WEBHOOK_SECRETS',
  'SYNC_ADMIN_TOKEN',
] as const;

export function readConfig(env: Record<string, unknown>): { config: SyncConfig; missing: string[] } {
  const get = (key: string, fallback = ''): string => {
    const value = env[key];
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  };
  const num = (key: string, fallback: number): number => {
    const n = Number(get(key, String(fallback)));
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };

  const config: SyncConfig = {
    siteUrl: get('SITE_URL', 'https://johnston-motors.webflow.io').replace(/\/+$/, ''),
    vehicleCollectionId: get('VEHICLE_COLLECTION_ID', '6ad1843872fde47acaeb13b5'),
    vehiclePath: '/inventory/',
    algoliaAppId: get('ALGOLIA_APP_ID', 'EMQLKN9FHC'),
    algoliaIndex: get('ALGOLIA_INDEX', 'stock'),
    algoliaKey: get('ALGOLIA_SYNC_API_KEY'),
    crawlerId: get('ALGOLIA_CRAWLER_ID', '5d4d72cf-781f-4517-92b2-879c52b25e3d'),
    crawlerUserId: get('ALGOLIA_CRAWLER_USER_ID'),
    crawlerApiKey: get('ALGOLIA_CRAWLER_API_KEY'),
    webhookSecrets: get('WEBFLOW_WEBHOOK_SECRETS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    adminToken: get('SYNC_ADMIN_TOKEN'),
    crawlDelayMs: num('CRAWL_DELAY_MS', 5000),
    dailyCrawlBudget: num('DAILY_CRAWL_BUDGET', 400),
    ignoredFields: ['analytics-view-count'],
  };

  const missing = REQUIRED_SECRETS.filter((key) => !get(key));
  return { config, missing };
}
