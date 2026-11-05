// Register, list and remove the Webflow webhooks that drive the stock sync, and build the env file for
// Webflow Cloud. Run from the repo root with Node 22+.
//
//   node tools/webhooks.mjs list
//   node tools/webhooks.mjs create [url]   default: https://johnston-motors.webflow.io/app/api/webflow-webhook
//   node tools/webhooks.mjs delete <url>   remove every webhook pointing at <url> (e.g. after a domain move)
//   node tools/webhooks.mjs cloud-env      write ../jm-webflow-cloud.env for Webflow Cloud's "Bulk import"
//
// Needs a site API token with Sites: read and write plus CMS: read (collection_item_* triggers need it), in ../.env.local (the johnston-motors folder, outside
// this public repo) as JOHNSTON_WEBFLOW_SITE_TOKEN. Webhooks made with a site token each come with their
// own signing secret; this script keeps them in ../.webhooks.local.json and never prints them. Webhooks
// made in the Webflow dashboard are unsigned, so don't use those.

import { readFile, writeFile } from 'node:fs/promises';

const SITE_ID = '6ad1843872fde47acaeb0f8c';
const DEFAULT_URL = 'https://johnston-motors.webflow.io/app/api/webflow-webhook';
const TRIGGERS = [
  'collection_item_published',
  'collection_item_unpublished',
  'collection_item_deleted',
  'collection_item_changed',
  'collection_item_created',
  'site_publish',
];
const ENV_FILE = new URL('../../.env.local', import.meta.url);
const STORE_FILE = new URL('../../.webhooks.local.json', import.meta.url);
const CLOUD_ENV_FILE = new URL('../../jm-webflow-cloud.env', import.meta.url);

async function readEnv() {
  const text = await readFile(ENV_FILE, 'utf8').catch(() => '');
  return Object.fromEntries([...text.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
}

async function readStore() {
  try {
    return JSON.parse(await readFile(STORE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function api(token, method, path, body) {
  const res = await fetch(`https://api.webflow.com/v2${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json.message ?? text}`);
  return json;
}

async function listWebhooks(token) {
  const { webhooks = [] } = await api(token, 'GET', `/sites/${SITE_ID}/webhooks`);
  return webhooks;
}

const env = await readEnv();
const [command = 'list', arg] = process.argv.slice(2);
const token = env.JOHNSTON_WEBFLOW_SITE_TOKEN;
if (!token && command !== 'cloud-env') {
  console.error('Add JOHNSTON_WEBFLOW_SITE_TOKEN (site API token, Sites: read and write, CMS: read) to johnston-motors/.env.local');
  process.exit(1);
}

if (command === 'list') {
  const store = await readStore();
  for (const w of await listWebhooks(token)) {
    console.log(`${w.id}  ${w.triggerType.padEnd(28)} ${w.url}  last: ${w.lastTriggered ?? 'never'}  secret: ${store[w.id] ? 'stored' : 'none'}`);
  }
} else if (command === 'create') {
  const url = arg ?? DEFAULT_URL;
  const store = await readStore();
  const existing = await listWebhooks(token);
  for (const triggerType of TRIGGERS) {
    if (existing.some((w) => w.triggerType === triggerType && w.url === url)) {
      console.log(`exists   ${triggerType}`);
      continue;
    }
    const created = await api(token, 'POST', `/sites/${SITE_ID}/webhooks`, { triggerType, url });
    if (created.secretKey) store[created.id] = { triggerType, url, secret: created.secretKey };
    // Save after every webhook: the secret is only returned once, so a later failure mustn't lose it.
    await writeFile(STORE_FILE, JSON.stringify(store, null, 2) + '\n');
    console.log(`created  ${triggerType}  ${created.id}  ${created.secretKey ? 'secret stored' : 'NO SECRET RETURNED'}`);
  }
  console.log('Next: node tools/webhooks.mjs cloud-env, then import that file in Webflow Cloud.');
} else if (command === 'delete') {
  if (!arg) throw new Error('usage: node tools/webhooks.mjs delete <url>');
  const store = await readStore();
  for (const w of await listWebhooks(token)) {
    if (w.url !== arg) continue;
    await api(token, 'DELETE', `/webhooks/${w.id}`);
    delete store[w.id];
    console.log(`deleted  ${w.triggerType}  ${w.id}`);
  }
  await writeFile(STORE_FILE, JSON.stringify(store, null, 2) + '\n');
} else if (command === 'cloud-env') {
  const store = await readStore();
  const live = token ? new Set((await listWebhooks(token)).map((w) => w.id)) : null;
  const secrets = Object.entries(store)
    .filter(([id]) => !live || live.has(id))
    .map(([, w]) => w.secret);
  const vars = {
    ALGOLIA_SYNC_API_KEY: env.JOHNSTON_ALGOLIA_SYNC_API_KEY,
    ALGOLIA_CRAWLER_USER_ID: env.JOHNSTON_ALGOLIA_CRAWLER_USER_ID,
    ALGOLIA_CRAWLER_API_KEY: env.JOHNSTON_ALGOLIA_CRAWLER_API_KEY,
    WEBFLOW_WEBHOOK_SECRETS: secrets.join(','),
    SYNC_ADMIN_TOKEN: env.JOHNSTON_SYNC_ADMIN_TOKEN,
  };
  const empty = Object.entries(vars).filter(([, v]) => !v).map(([k]) => k);
  if (empty.length) console.log('Missing values (left blank):', empty.join(', '));
  await writeFile(CLOUD_ENV_FILE, Object.entries(vars).map(([k, v]) => `${k}=${v ?? ''}`).join('\n') + '\n');
  console.log(`Wrote johnston-motors/jm-webflow-cloud.env (${Object.keys(vars).length} variables, ${secrets.length} webhook secrets).`);
  console.log('Import it in Webflow Cloud (mark every variable Secret), then delete the file.');
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
