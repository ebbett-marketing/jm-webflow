/* eslint-disable @typescript-eslint/no-empty-interface */
// Bindings and environment variables (set in Webflow Cloud → environment → Environment Variables).
interface Env {
  SYNC_STATE: KVNamespace;
  ALGOLIA_SYNC_API_KEY: string;
  ALGOLIA_CRAWLER_USER_ID: string;
  ALGOLIA_CRAWLER_API_KEY: string;
  WEBFLOW_WEBHOOK_SECRETS: string;
  SYNC_ADMIN_TOKEN: string;
  SITE_URL?: string;
  CRAWL_DELAY_MS?: string;
  DAILY_CRAWL_BUDGET?: string;
}
