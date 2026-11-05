// What each webhook does to the stock index.
//
//   car published / updated live  -> ask the crawler to re-crawl that page (skipped if nothing but the view
//                                    count changed since the last crawl)
//   car unpublished / deleted     -> reconcile: drop records whose page now 404s
//   whole site published          -> reconcile: crawl published cars missing from search, drop gone ones
//
// Every delete is confirmed against the live page first, so a forged or stale webhook can't remove a car
// that is still on the site. The crawler's daily 6am crawl stays as the backstop for anything missed.

import type { SyncConfig } from './config.ts';
import { browseRecords, crawlUrls, deleteRecords, type Fetch } from './algolia.ts';
import { changedLivePage, fieldHash, type WebflowEvent } from './webflow.ts';
import type { SyncState } from './state.ts';

export interface Deps {
  fetch: Fetch;
  state: SyncState;
  sleep: (ms: number) => Promise<void>;
}

const REMOVE_TRIGGERS = new Set(['collection_item_unpublished', 'collection_item_deleted']);
const UPDATE_TRIGGERS = new Set(['collection_item_published', 'collection_item_changed', 'collection_item_created']);

export async function handleEvent(cfg: SyncConfig, event: WebflowEvent, deps: Deps): Promise<Record<string, unknown>> {
  const { trigger } = event;

  if (trigger === 'site_publish') {
    return { trigger, action: 'reconcile', ...(await reconcile(cfg, deps)) };
  }
  if (!REMOVE_TRIGGERS.has(trigger) && !UPDATE_TRIGGERS.has(trigger)) {
    return { trigger, action: 'ignored' };
  }

  const vehicles = event.items.filter((item) => item.collectionId === cfg.vehicleCollectionId);
  const unknown = event.items.filter((item) => !item.collectionId);
  if (!vehicles.length && !unknown.length) return { trigger, action: 'ignored', reason: 'not a vehicle' };

  if (REMOVE_TRIGGERS.has(trigger)) {
    // Forget what was last crawled, so republishing the car unchanged still puts it back in search.
    for (const item of [...vehicles, ...unknown]) if (item.id) await deps.state.saveHash(item.id, '');
    const suspects = vehicles.flatMap((item) => (item.slug ? [cfg.vehiclePath + item.slug] : []));
    return { trigger, action: 'reconcile', ...(await reconcile(cfg, deps, { suspects })) };
  }

  const crawl: { id: string; url: string; hash: string | null }[] = [];
  const skipped: { id: string; why: string }[] = [];
  for (const item of vehicles) {
    if (!item.slug) skipped.push({ id: item.id, why: 'no slug' });
    else if (!changedLivePage(item, trigger)) skipped.push({ id: item.id, why: 'not live' });
    else {
      const hash = await fieldHash(item.fieldData, cfg.ignoredFields);
      if (hash && hash === (await deps.state.lastHash(item.id))) skipped.push({ id: item.id, why: 'unchanged' });
      else crawl.push({ id: item.id, url: cfg.siteUrl + cfg.vehiclePath + item.slug, hash });
    }
  }
  if (!crawl.length) return { trigger, action: 'none', skipped };

  const urls = [...new Set(crawl.map((c) => c.url))];
  if (!(await deps.state.takeCrawl(cfg.dailyCrawlBudget))) {
    return { trigger, action: 'budget-spent', urls, skipped };
  }
  // Claim the hashes before waiting, so a duplicate webhook arriving meanwhile is skipped; release them
  // if the crawl request fails so the next webhook tries again.
  for (const c of crawl) if (c.hash) await deps.state.saveHash(c.id, c.hash);
  try {
    await deps.sleep(cfg.crawlDelayMs);
    const taskId = await crawlUrls(cfg, urls, deps.fetch);
    return { trigger, action: 'crawl', urls, taskId, skipped };
  } catch (error) {
    for (const c of crawl) if (c.hash) await deps.state.saveHash(c.id, '');
    throw error;
  }
}

/** Vehicle page paths listed in the live sitemap. */
export async function sitemapPaths(cfg: SyncConfig, fetchFn: Fetch): Promise<Set<string>> {
  const res = await fetchFn(`${cfg.siteUrl}/sitemap.xml?sync=${Date.now()}`);
  if (!res.ok) throw new Error(`sitemap ${res.status}`);
  const xml = await res.text();
  const paths = new Set<string>();
  for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    try {
      const path = decodeURI(new URL(match[1]).pathname);
      if (path.startsWith(cfg.vehiclePath) && path.length > cfg.vehiclePath.length) paths.add(path);
    } catch {
      /* not a URL */
    }
  }
  return paths;
}

/** HTTP status of a live page, bypassing Webflow's CDN cache with a throwaway query string. */
async function pageStatus(cfg: SyncConfig, path: string, fetchFn: Fetch): Promise<number> {
  const res = await fetchFn(`${cfg.siteUrl}${encodeURI(path)}?sync=${Date.now()}`, { redirect: 'manual' });
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed */
  }
  return res.status;
}

const MAX_CHECKS = 25;
/** Right after an unpublish a car's page can still answer 200 for a moment; look again this much later. */
const RECHECK_MS = 10_000;
const isGone = (status: number) => status === 404 || status === 410;

export interface ReconcileResult {
  sitemap: number;
  indexed: number;
  missing: string[];
  gone: string[];
  stillLive: string[];
  rechecked?: number;
  deleteTask?: number | null;
  crawlTask?: string;
  stopped?: string;
  dryRun?: boolean;
}

export async function reconcile(
  cfg: SyncConfig,
  deps: Deps,
  opts: { suspects?: string[]; dryRun?: boolean } = {},
): Promise<ReconcileResult> {
  const suspects = opts.suspects ?? [];
  // After an unpublish, give the CDN and sitemap the same head start a crawl gets.
  if (suspects.length) await deps.sleep(cfg.crawlDelayMs);

  const [sitemap, records] = await Promise.all([sitemapPaths(cfg, deps.fetch), browseRecords(cfg, deps.fetch)]);
  const result: ReconcileResult = {
    sitemap: sitemap.size,
    indexed: records.length,
    missing: [],
    gone: [],
    stillLive: [],
    ...(opts.dryRun ? { dryRun: true } : {}),
  };
  if (!sitemap.size) {
    result.stopped = 'sitemap lists no vehicle pages';
    return result;
  }

  const byPath = new Map<string, string>();
  for (const r of records) if (r.url) byPath.set(r.url, r.objectID);

  result.missing = [...sitemap].filter((path) => !byPath.has(path));

  const candidates = new Set([...byPath.keys()].filter((path) => !sitemap.has(path)));
  for (const path of suspects) if (byPath.has(path)) candidates.add(path);

  if (candidates.size > MAX_CHECKS) {
    result.stopped = `${candidates.size} indexed cars are missing from the sitemap; not checking or deleting any`;
  } else {
    for (const path of candidates) {
      const status = await pageStatus(cfg, path, deps.fetch);
      (isGone(status) ? result.gone : result.stillLive).push(path);
    }
    const late = result.stillLive.filter((path) => suspects.includes(path));
    if (late.length) {
      await deps.sleep(RECHECK_MS);
      for (const path of late) {
        if (isGone(await pageStatus(cfg, path, deps.fetch))) {
          result.stillLive = result.stillLive.filter((p) => p !== path);
          result.gone.push(path);
        }
      }
      result.rechecked = late.length;
    }
    const limit = Math.max(3, Math.ceil(records.length * 0.2));
    if (result.gone.length > limit) {
      result.stopped = `would delete ${result.gone.length} of ${records.length} records; limit is ${limit}`;
    } else if (result.gone.length && !opts.dryRun) {
      result.deleteTask = await deleteRecords(
        cfg,
        result.gone.map((path) => byPath.get(path)!),
        deps.fetch,
      );
    }
  }

  if (result.missing.length && !opts.dryRun && (await deps.state.takeCrawl(cfg.dailyCrawlBudget))) {
    result.crawlTask = await crawlUrls(
      cfg,
      result.missing.map((path) => cfg.siteUrl + encodeURI(path)),
      deps.fetch,
    );
  }
  return result;
}
