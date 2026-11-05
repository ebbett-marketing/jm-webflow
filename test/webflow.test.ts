import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { changedLivePage, fieldHash, parseEvent, verifySignature } from '../src/lib/webflow.ts';

const sign = (secret: string, ts: number, body: string) => createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');

test('accepts a body signed with any configured webhook secret', async () => {
  const body = JSON.stringify({ triggerType: 'collection_item_published', payload: { id: 'a' } });
  const ts = Date.now();
  const result = await verifySignature({ rawBody: body, timestamp: String(ts), signature: sign('second', ts, body), secrets: ['first', 'second'] });
  assert.equal(result, 'ok');
});

test('rejects wrong secrets, tampered bodies, missing headers and old timestamps', async () => {
  const body = '{"triggerType":"site_publish","payload":{}}';
  const ts = Date.now();
  assert.equal(await verifySignature({ rawBody: body, timestamp: String(ts), signature: sign('other', ts, body), secrets: ['s'] }), 'bad');
  assert.equal(await verifySignature({ rawBody: body.replace('site', 'x'), timestamp: String(ts), signature: sign('s', ts, body), secrets: ['s'] }), 'bad');
  assert.equal(await verifySignature({ rawBody: body, timestamp: null, signature: 'x', secrets: ['s'] }), 'missing');
  const old = ts - 6 * 60 * 1000;
  assert.equal(await verifySignature({ rawBody: body, timestamp: String(old), signature: sign('s', old, body), secrets: ['s'] }), 'stale');
});

test('accepts a signature over the re-serialised body when the raw body has extra whitespace', async () => {
  const pretty = '{ "triggerType": "site_publish", "payload": {} }';
  const ts = Date.now();
  const sig = sign('s', ts, JSON.stringify(JSON.parse(pretty)));
  assert.equal(await verifySignature({ rawBody: pretty, timestamp: String(ts), signature: sig, secrets: ['s'] }), 'ok');
});

test('parses single-item and bulk payloads', () => {
  const single = parseEvent({
    triggerType: 'collection_item_published',
    payload: { id: 'i1', collectionId: 'c', isDraft: false, fieldData: { name: 'Car', slug: 'car-1' } },
  });
  assert.deepEqual(single.items.map((i) => [i.id, i.collectionId, i.slug]), [['i1', 'c', 'car-1']]);

  const bulk = parseEvent({
    triggerType: 'collection_item_published',
    payload: { items: [{ id: 'i1', collectionId: 'c', fieldData: { slug: 'a' } }, { id: 'i2', collectionId: 'c', fieldData: { slug: 'b' } }] },
  });
  assert.deepEqual(bulk.items.map((i) => i.slug), ['a', 'b']);

  const deleted = parseEvent({ triggerType: 'collection_item_deleted', payload: { id: 'i9', collectionId: 'c' } });
  assert.equal(deleted.items[0].slug, undefined);
  assert.equal(parseEvent(null).trigger, '');
});

test('field hash ignores view counts and key order, and gives up on name/slug-only payloads', async () => {
  const a = await fieldHash({ name: 'Car', slug: 'car', 'price---current-now': 100, 'analytics-view-count': 5 }, ['analytics-view-count']);
  const b = await fieldHash({ 'analytics-view-count': 99, 'price---current-now': 100, slug: 'car', name: 'Car' }, ['analytics-view-count']);
  const c = await fieldHash({ name: 'Car', slug: 'car', 'price---current-now': 90 }, ['analytics-view-count']);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(await fieldHash({ name: 'Car', slug: 'car' }, []), null);
});

test('created/changed only count when the edit went live in the same operation', () => {
  const t = '2026-11-05T10:00:00.000Z';
  assert.equal(changedLivePage({ id: '1', isDraft: false, lastPublished: t, lastUpdated: t }, 'collection_item_changed'), true);
  assert.equal(
    changedLivePage({ id: '1', isDraft: false, lastPublished: '2026-11-01T00:00:00Z', lastUpdated: t }, 'collection_item_changed'),
    false,
  );
  assert.equal(changedLivePage({ id: '1', isDraft: true, lastPublished: t, lastUpdated: t }, 'collection_item_changed'), false);
  assert.equal(changedLivePage({ id: '1', lastPublished: null }, 'collection_item_published'), true);
});
