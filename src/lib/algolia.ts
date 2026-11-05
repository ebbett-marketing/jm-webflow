// Algolia calls: ask the stock crawler to (re)crawl pages, list what's in the index, delete records.
// The crawler owns the record shape (its extractor reads the JSON block in the vehicle template head), so
// this app never writes records itself.

import type { SyncConfig } from './config.ts';

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

function algoliaHeaders(cfg: SyncConfig): Record<string, string> {
  return {
    'X-Algolia-Application-Id': cfg.algoliaAppId,
    'X-Algolia-API-Key': cfg.algoliaKey,
    'Content-Type': 'application/json',
  };
}

/** Crawl these URLs now with the crawler's current config; records go straight into the index. */
export async function crawlUrls(cfg: SyncConfig, urls: string[], fetchFn: Fetch): Promise<string> {
  const res = await fetchFn(`https://crawler.algolia.com/api/1/crawlers/${cfg.crawlerId}/urls/crawl`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${cfg.crawlerUserId}:${cfg.crawlerApiKey}`)}`,
      'Content-Type': 'application/json',
    },
    // save: false keeps these URLs out of the crawler config's extraUrls.
    body: JSON.stringify({ urls, save: false }),
  });
  const body = await readJson(res);
  if (!res.ok) throw new Error(`crawler ${res.status}: ${body?.error?.message ?? body?.message ?? 'request failed'}`);
  return String(body.taskId ?? '');
}

export interface IndexedRecord {
  objectID: string;
  url: string | null;
}

/** Every record's objectID and page path (the extractor stores `url` as the pathname). */
export async function browseRecords(cfg: SyncConfig, fetchFn: Fetch): Promise<IndexedRecord[]> {
  const out: IndexedRecord[] = [];
  const endpoint = `https://${cfg.algoliaAppId}-dsn.algolia.net/1/indexes/${encodeURIComponent(cfg.algoliaIndex)}/browse`;
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: algoliaHeaders(cfg),
      body: JSON.stringify(cursor ? { cursor } : { attributesToRetrieve: ['objectID', 'url'], hitsPerPage: 1000 }),
    });
    const body = await readJson(res);
    if (!res.ok) throw new Error(`algolia browse ${res.status}: ${body?.message ?? 'request failed'}`);
    for (const hit of body.hits ?? []) {
      out.push({ objectID: String(hit.objectID), url: typeof hit.url === 'string' ? hit.url : null });
    }
    cursor = body.cursor;
    if (!cursor) break;
  }
  return out;
}

/**
 * One DELETE per record: the batch endpoint needs the addObject ACL even for deletes, and the sync key
 * deliberately can't write records. Deletions come a few at a time, so this stays cheap.
 */
export async function deleteRecords(cfg: SyncConfig, objectIDs: string[], fetchFn: Fetch): Promise<number | null> {
  let taskID: number | null = null;
  const base = `https://${cfg.algoliaAppId}.algolia.net/1/indexes/${encodeURIComponent(cfg.algoliaIndex)}/`;
  for (const objectID of objectIDs) {
    const res = await fetchFn(base + encodeURIComponent(objectID), { method: 'DELETE', headers: algoliaHeaders(cfg) });
    const body = await readJson(res);
    if (!res.ok) throw new Error(`algolia delete ${res.status}: ${body?.message ?? 'request failed'}`);
    if (typeof body.taskID === 'number') taskID = body.taskID;
  }
  return taskID;
}
