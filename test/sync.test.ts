import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/lib/config.ts';
import { SyncState, type KVLike } from '../src/lib/state.ts';
import { handleEvent, reconcile, type Deps } from '../src/lib/sync.ts';

const { config } = readConfig({
  ALGOLIA_SYNC_API_KEY: 'k',
  ALGOLIA_CRAWLER_USER_ID: 'u',
  ALGOLIA_CRAWLER_API_KEY: 'c',
  WEBFLOW_WEBHOOK_SECRETS: 's',
  SYNC_ADMIN_TOKEN: 't',
  CRAWL_DELAY_MS: '0',
});
const SITE = config.siteUrl;
const VEHICLES = config.vehicleCollectionId;

class MemoryKV implements KVLike {
  data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.data.set(key, value);
  }
  async list({ prefix = '', limit = 1000 }: { prefix?: string; limit?: number }) {
    const names = [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
    return { keys: names.slice(0, limit).map((name) => ({ name })) };
  }
}

/** Fake site + Algolia: `live` = published vehicle paths, `index` = records in Algolia. */
function world(opts: { live: string[]; index: { objectID: string; url: string }[]; sitemap?: string[] }) {
  const calls: { url: string; body?: any; method?: string }[] = [];
  const sitemap = opts.sitemap ?? opts.live;
  const fetch = async (input: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: input, body, method: init?.method ?? 'GET' });
    const u = new URL(input);
    if (u.pathname === '/sitemap.xml') {
      const xml = `<urlset><url><loc>${SITE}/about</loc></url>${sitemap.map((p) => `<url><loc>${SITE}${p}</loc></url>`).join('')}</urlset>`;
      return new Response(xml, { status: 200 });
    }
    if (u.hostname.endsWith('-dsn.algolia.net')) return Response.json({ hits: opts.index });
    if (u.hostname.endsWith('.algolia.net') && init?.method === 'DELETE') return Response.json({ taskID: 42 });
    if (u.hostname === 'crawler.algolia.com') return Response.json({ taskId: 'task-1' });
    if (u.pathname.startsWith('/inventory/')) return new Response('', { status: opts.live.includes(u.pathname) ? 200 : 404 });
    return new Response('', { status: 500 });
  };
  const kv = new MemoryKV();
  const deps: Deps = { fetch, state: new SyncState(kv), sleep: async () => {} };
  return { deps, calls, kv };
}

const published = (id: string, slug: string, fields: Record<string, unknown> = {}) => ({
  triggerType: 'collection_item_published',
  items: [
    {
      id,
      collectionId: VEHICLES,
      slug,
      isDraft: false,
      fieldData: { name: 'Car', slug, 'price---current-now': 100, 'analytics-view-count': 1, ...fields },
    },
  ],
});

test('a published car is re-crawled once; a re-publish with only a new view count is skipped', async () => {
  const w = world({ live: ['/inventory/car-1'], index: [] });
  const first = await handleEvent(config, { trigger: 'collection_item_published', items: published('i1', 'car-1').items }, w.deps);
  assert.equal(first.action, 'crawl');
  assert.deepEqual(first.urls, [`${SITE}/inventory/car-1`]);
  const crawl = w.calls.find((c) => c.url.includes('/urls/crawl'));
  assert.deepEqual(crawl?.body, { urls: [`${SITE}/inventory/car-1`], save: false });

  const again = await handleEvent(
    config,
    { trigger: 'collection_item_published', items: published('i1', 'car-1', { 'analytics-view-count': 50 }).items },
    w.deps,
  );
  assert.equal(again.action, 'none');

  const priceChange = await handleEvent(
    config,
    { trigger: 'collection_item_published', items: published('i1', 'car-1', { 'price---current-now': 90 }).items },
    w.deps,
  );
  assert.equal(priceChange.action, 'crawl');
});

test('two identical webhooks at once crawl once', async () => {
  const w = world({ live: ['/inventory/car-1'], index: [] });
  const slowDeps = { ...w.deps, sleep: () => new Promise<void>((r) => setTimeout(r, 20)) };
  const event = { trigger: 'collection_item_published', items: published('i1', 'car-1').items };
  const [a, b] = await Promise.all([handleEvent(config, event, slowDeps), handleEvent(config, event, slowDeps)]);
  assert.deepEqual([a.action, b.action].sort(), ['crawl', 'none']);
});

test('a publish ("published" + "changed" at once) crawls once; a live edit alone still crawls', async () => {
  const w = world({ live: ['/inventory/car-1'], index: [] });
  // real waits scaled down 100x, and a store with network-like latency (so both events read before either writes)
  class SlowKV extends MemoryKV {
    async get(key: string) {
      await new Promise((r) => setTimeout(r, 2));
      return super.get(key);
    }
    async put(key: string, value: string) {
      await new Promise((r) => setTimeout(r, 2));
      return super.put(key, value);
    }
  }
  const deps = {
    ...w.deps,
    state: new SyncState(new SlowKV()),
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms / 100)),
  };
  const now = new Date().toISOString();
  const item = { ...published('i1', 'car-1').items[0], lastPublished: now, lastUpdated: now };
  const [pub, changed] = await Promise.all([
    handleEvent(config, { trigger: 'collection_item_published', items: [item] }, deps),
    handleEvent(config, { trigger: 'collection_item_changed', items: [item] }, deps),
  ]);
  assert.equal(pub.action, 'crawl');
  assert.equal(changed.action, 'none');

  const edited = { ...item, fieldData: { ...item.fieldData, 'price---current-now': 80 } };
  const alone = await handleEvent(config, { trigger: 'collection_item_changed', items: [edited] }, deps);
  assert.equal(alone.action, 'crawl');
});

test('a failed crawl request releases the hash so the next webhook retries', async () => {
  const w = world({ live: ['/inventory/car-1'], index: [] });
  const failing = { ...w.deps, fetch: async () => new Response('{"message":"boom"}', { status: 500 }) };
  const event = { trigger: 'collection_item_published', items: published('i1', 'car-1').items };
  await assert.rejects(handleEvent(config, event, failing), /crawler 500/);
  const retry = await handleEvent(config, event, w.deps);
  assert.equal(retry.action, 'crawl');
});

test('events from other collections are ignored', async () => {
  const w = world({ live: [], index: [] });
  const result = await handleEvent(
    config,
    { trigger: 'collection_item_published', items: [{ id: 'x', collectionId: 'offers', slug: 'deal' }] },
    w.deps,
  );
  assert.equal(result.action, 'ignored');
  assert.equal(w.calls.length, 0);
});

test('an unpublished car is deleted only once its page 404s', async () => {
  const index = [
    { objectID: '1', url: '/inventory/car-1' },
    { objectID: '2', url: '/inventory/car-2' },
  ];
  // car-2 unpublished: gone from page and sitemap
  const w = world({ live: ['/inventory/car-1'], index });
  const result = await handleEvent(
    config,
    { trigger: 'collection_item_unpublished', items: [{ id: 'i2', collectionId: VEHICLES, slug: 'car-2' }] },
    w.deps,
  );
  assert.deepEqual(result.gone, ['/inventory/car-2']);
  const deletes = w.calls.filter((c) => c.method === 'DELETE').map((c) => new URL(c.url).pathname);
  assert.deepEqual(deletes, ['/1/indexes/stock/2']);
});

test('unpublish then republish with no changes crawls the car again', async () => {
  const w = world({ live: ['/inventory/car-1'], index: [] });
  const event = { trigger: 'collection_item_published', items: published('i1', 'car-1').items };
  assert.equal((await handleEvent(config, event, w.deps)).action, 'crawl');
  await handleEvent(
    config,
    { trigger: 'collection_item_unpublished', items: [{ id: 'i1', collectionId: VEHICLES, slug: 'car-1' }] },
    w.deps,
  );
  assert.equal((await handleEvent(config, event, w.deps)).action, 'crawl');
});

test('an unpublished car whose page still answers 200 at first is checked again', async () => {
  const index = [{ objectID: '1', url: '/inventory/car-1' }];
  // sitemap still lists car-1 (it only refreshes on a site publish); the page flips to 404 after a moment
  const w = world({ live: ['/inventory/car-1'], index, sitemap: ['/inventory/car-1'] });
  const fetchOnce = w.deps.fetch;
  let pageChecks = 0;
  const deps = {
    ...w.deps,
    fetch: async (input: string, init?: RequestInit) => {
      if (new URL(input).pathname === '/inventory/car-1' && pageChecks++ > 0) return new Response('', { status: 404 });
      return fetchOnce(input, init);
    },
  };
  const result = await handleEvent(
    config,
    { trigger: 'collection_item_unpublished', items: [{ id: 'i1', collectionId: VEHICLES, slug: 'car-1' }] },
    deps,
  );
  assert.equal(result.rechecked, 1);
  assert.deepEqual(result.gone, ['/inventory/car-1']);
  assert.deepEqual(result.stillLive, []);
});

test('recorded events come back newest first', async () => {
  const kv = new MemoryKV();
  const state = new SyncState(kv);
  await state.record({ n: 1 }, 1_000);
  await state.record({ n: 2 }, 2_000);
  await state.record({ n: 3 }, 3_000);
  const events = (await state.recent(2)) as { n: number }[];
  assert.deepEqual(events.map((e) => e.n), [3, 2]);
});

test('a webhook for a car that is still live deletes nothing', async () => {
  const index = [{ objectID: '1', url: '/inventory/car-1' }];
  const w = world({ live: ['/inventory/car-1'], index });
  const result = await handleEvent(
    config,
    { trigger: 'collection_item_deleted', items: [{ id: 'i1', collectionId: VEHICLES, slug: 'car-1' }] },
    w.deps,
  );
  assert.deepEqual(result.gone, []);
  assert.deepEqual(result.stillLive, ['/inventory/car-1']);
  assert.equal(w.calls.some((c) => c.method === 'DELETE'), false);
});

test('site publish crawls published cars missing from search', async () => {
  const w = world({ live: ['/inventory/car-1', '/inventory/new-car'], index: [{ objectID: '1', url: '/inventory/car-1' }] });
  const result = await handleEvent(config, { trigger: 'site_publish', items: [] }, w.deps);
  assert.deepEqual(result.missing, ['/inventory/new-car']);
  assert.equal(result.crawlTask, 'task-1');
});

test('safety stops: empty sitemap, or too many deletions at once', async () => {
  const index = Array.from({ length: 10 }, (_, i) => ({ objectID: String(i), url: `/inventory/car-${i}` }));
  const empty = world({ live: [], index, sitemap: [] });
  const r1 = await reconcile(config, empty.deps);
  assert.match(String(r1.stopped), /no vehicle pages/);

  // only car-0 still listed, the other 9 "404" (e.g. wrong SITE_URL): 9 > max(3, 20% of 10)
  const broken = world({ live: ['/inventory/car-0'], index });
  const r2 = await reconcile(config, broken.deps);
  assert.match(String(r2.stopped), /would delete 9 of 10/);
  assert.equal(broken.calls.some((c) => c.method === 'DELETE'), false);
});

test('dry run reports without changing anything', async () => {
  const w = world({ live: ['/inventory/new-car'], index: [{ objectID: '1', url: '/inventory/old-car' }] });
  const result = await reconcile(config, w.deps, { dryRun: true });
  assert.deepEqual(result.missing, ['/inventory/new-car']);
  assert.deepEqual(result.gone, ['/inventory/old-car']);
  assert.equal(w.calls.some((c) => c.method === 'DELETE' || c.url.includes('/urls/crawl')), false);
});

test('the daily crawl budget stops crawl requests', async () => {
  const w = world({ live: ['/inventory/car-1'], index: [] });
  const today = `budget:${new Date().toISOString().slice(0, 10)}`;
  w.kv.data.set(today, String(config.dailyCrawlBudget));
  const result = await handleEvent(config, { trigger: 'collection_item_published', items: published('i1', 'car-1').items }, w.deps);
  assert.equal(result.action, 'budget-spent');
  assert.equal(w.calls.some((c) => c.url.includes('/urls/crawl')), false);
});
