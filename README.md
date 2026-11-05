# jm-webflow: Johnston Motors stock sync

A small Webflow Cloud app on the Johnston Motors site. It keeps the Algolia `stock` index (app
`EMQLKN9FHC`) in step with the Stock | Vehicles CMS within seconds of a car being published, changed,
unpublished or deleted. Without it, search only catches up at the crawler's daily 6am crawl.

It doesn't build search records itself. The Algolia Crawler still does that from the JSON block in the
vehicle template head (config in [ebbett-marketing/JM-algolia](https://github.com/ebbett-marketing/JM-algolia),
`crawler/stock.config.js`). This app only tells the crawler which page to re-crawl, and removes records
for cars that are gone. The daily crawl stays as the backstop.

## What happens

| Webflow event | What the app does |
|---|---|
| Car published, or changed and published in one go (`/items/live`) | Waits 5 s for Webflow's CDN, then asks the crawler to re-crawl that page. Skipped if nothing but `analytics-view-count` changed since the last crawl. |
| Car unpublished or deleted | Reconciles: deletes the record once the car's page returns 404. |
| Site published | Reconciles: crawls published cars missing from search, and deletes records whose page 404s. |
| Anything else (other collections, staged-only edits) | Ignored. |

Guards:

- Every webhook must carry a valid Webflow signature, at most 5 minutes old.
- A record is only deleted after its live page returns 404, so a stale or forged webhook can't remove a
  car that is still on the site.
- Reconcile stops without deleting anything if the sitemap lists no cars, if more than 25 indexed cars
  are missing from it, or if it would delete more than 20% of the index (minimum 3) at once. That
  protects against a wrong `SITE_URL` or a broken publish.
- The Crawler API allows 500 URL-crawl requests a day. The app stops at 400 (`DAILY_CRAWL_BUDGET`) and
  dedupes repeat publishes through the Key Value Store, so a pipeline that re-saves every car doesn't
  use up the budget.

## Endpoints

The mount path is `/app` on johnston-motors.webflow.io (set in Webflow Cloud).

| | |
|---|---|
| `POST /app/api/webflow-webhook` | Webflow webhooks (signed) |
| `POST /app/api/reconcile` | Manual catch-up: `Authorization: Bearer <SYNC_ADMIN_TOKEN>`, `?dry=1` to report only |
| `GET /app/api/health` | Deployed and configured? Shows no values |

```bash
curl -s https://johnston-motors.webflow.io/app/api/health
curl -s -X POST 'https://johnston-motors.webflow.io/app/api/reconcile?dry=1' -H "Authorization: Bearer $SYNC_ADMIN_TOKEN"
```

Each webhook and its outcome are logged as one JSON line under Webflow Cloud → the environment →
Runtime logs (`"app":"jm-stock-sync"`).

## Environment variables (Webflow Cloud → environment → Environment Variables, all marked Secret)

| Variable | What |
|---|---|
| `ALGOLIA_SYNC_API_KEY` | Algolia key limited to `browse` + `deleteObject` on `stock` |
| `ALGOLIA_CRAWLER_USER_ID`, `ALGOLIA_CRAWLER_API_KEY` | Crawler API credentials (Crawler → Settings) |
| `WEBFLOW_WEBHOOK_SECRETS` | Comma-separated signing secrets, one per webhook |
| `SYNC_ADMIN_TOKEN` | Any long random string, for `/api/reconcile` |
| `SITE_URL` *(optional)* | Defaults to `https://johnston-motors.webflow.io`; set it to the live domain at launch |
| `CRAWL_DELAY_MS`, `DAILY_CRAWL_BUDGET` *(optional)* | Default 5000 and 400 |

Changing a variable needs a new deployment: push a commit, or use "Deploy latest build".

## Setting up the webhooks

Webhooks made in the Webflow dashboard aren't signed, so they're registered through the API with a
site token instead. Each one then gets its own secret.

1. Site settings → Apps & integrations → API access → generate a token with **Sites: read and write** and
   **CMS: read** (the `collection_item_*` triggers need CMS read, although the API reference only lists
   `sites:write`). Add it to `johnston-motors/.env.local` (outside this repo) as
   `JOHNSTON_WEBFLOW_SITE_TOKEN=…`. The app never uses the token. Webhooks keep firing after the token
   that created them is revoked (tested 5 Nov 2026), so it can lapse after 365 idle days; generate a new
   one only when the webhooks need listing, moving or deleting.
2. `node tools/webhooks.mjs create` registers the six triggers against `/app/api/webflow-webhook`.
   Secrets go to `johnston-motors/.webhooks.local.json`.
3. `node tools/webhooks.mjs cloud-env` writes `johnston-motors/jm-webflow-cloud.env`. Bulk-import it
   in Webflow Cloud, mark everything Secret, redeploy, then delete the file.
4. `node tools/webhooks.mjs list` shows each webhook's last trigger time.

## At launch

- Set `SITE_URL` to the live domain (matching the crawler's `pathsToMatch`), and redeploy.
- The webhooks can keep pointing at the webflow.io URL. To move them, `create <new url>` and then
  `delete <old url>`, and re-import the secrets.

## Development

```bash
npm install
npm test        # unit tests (Node 22.18+ runs the TypeScript directly)
npm run build   # what Webflow Cloud runs
```

To run the built app locally against the real index, put the variables above in `.dev.vars`
(gitignored), copy it next to `dist/server/wrangler.json`, and run
`npx wrangler dev --config dist/server/wrangler.json`. Routes are then under `/CLOUD_MOUNT_PATH/api/…`.

Pushing to `main` deploys to the Webflow Cloud environment. Runtime notes:

- Astro 6+ removed `locals.runtime.env`; read variables with `import { env } from "cloudflare:workers"`,
  and background work goes through `locals.cfContext.waitUntil`.
- Webflow Cloud requests time out after 20 s.
