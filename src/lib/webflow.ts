// Webflow webhook handling: signature check and payload parsing.
//
// Webhooks registered with a site API token (after 14 Apr 2025) each get their own secret. Webflow signs
// `${timestamp}:${body}` with HMAC-SHA256 and sends the hex digest in x-webflow-signature, the epoch-ms
// timestamp in x-webflow-timestamp. Webhooks made in the dashboard are unsigned, so we don't use them.

const encoder = new TextEncoder();

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type SignatureCheck = 'ok' | 'missing' | 'stale' | 'bad';

export async function verifySignature(opts: {
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  secrets: string[];
  now?: number;
  maxAgeMs?: number;
}): Promise<SignatureCheck> {
  const { rawBody, timestamp, signature, secrets, now = Date.now(), maxAgeMs = 5 * 60 * 1000 } = opts;
  if (!timestamp || !signature) return 'missing';
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > maxAgeMs) return 'stale';

  // Webflow's docs sign JSON.stringify(body); that's normally byte-identical to the raw body, but try both.
  const bodies = [rawBody];
  try {
    const restrung = JSON.stringify(JSON.parse(rawBody));
    if (restrung !== rawBody) bodies.push(restrung);
  } catch {
    /* not JSON: only the raw body can match */
  }

  const expected = signature.trim().toLowerCase();
  for (const secret of secrets) {
    for (const body of bodies) {
      if (constantTimeEqual(await hmacHex(secret, `${ts}:${body}`), expected)) return 'ok';
    }
  }
  return 'bad';
}

export interface WebflowItem {
  id: string;
  collectionId?: string;
  slug?: string;
  isDraft?: boolean;
  isArchived?: boolean;
  lastPublished?: string | null;
  lastUpdated?: string;
  fieldData?: Record<string, unknown>;
}

export interface WebflowEvent {
  trigger: string;
  items: WebflowItem[];
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Normalise a webhook body. Collection item events arrive either as one item in `payload`, or as
 * `payload.items` (bulk publishes); both shapes are accepted.
 */
export function parseEvent(body: unknown): WebflowEvent {
  const root = isObject(body) ? body : {};
  const trigger = typeof root.triggerType === 'string' ? root.triggerType : '';
  const payload = isObject(root.payload) ? root.payload : {};

  let raw: unknown[] = [];
  if (Array.isArray(payload.items)) raw = payload.items;
  else if (Array.isArray(root.payload)) raw = root.payload;
  else if (payload.id || payload.fieldData) raw = [payload];

  const items = raw
    .map((entry): WebflowItem | null => {
      if (typeof entry === 'string') return { id: entry, collectionId: payload.collectionId };
      if (!isObject(entry)) return null;
      const fieldData = isObject(entry.fieldData) ? entry.fieldData : undefined;
      const slug = typeof fieldData?.slug === 'string' ? fieldData.slug : typeof entry.slug === 'string' ? entry.slug : undefined;
      return {
        id: String(entry.id ?? entry._id ?? ''),
        collectionId: entry.collectionId ?? payload.collectionId,
        slug,
        isDraft: typeof entry.isDraft === 'boolean' ? entry.isDraft : undefined,
        isArchived: typeof entry.isArchived === 'boolean' ? entry.isArchived : undefined,
        lastPublished: entry.lastPublished ?? null,
        lastUpdated: entry.lastUpdated,
        fieldData,
      };
    })
    .filter((item): item is WebflowItem => item !== null);

  return { trigger, items };
}

/** Body shape for the logs: which keys arrived, never the values. */
export function describeBody(body: unknown): Record<string, unknown> {
  const root = isObject(body) ? body : {};
  const payload = root.payload;
  const first = isObject(payload) && Array.isArray(payload.items) ? payload.items[0] : payload;
  return {
    payloadKeys: isObject(payload) ? Object.keys(payload) : Array.isArray(payload) ? 'array' : typeof payload,
    itemKeys: isObject(first) ? Object.keys(first) : typeof first,
    fieldCount: isObject(first) && isObject(first.fieldData) ? Object.keys(first.fieldData).length : 0,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Hash of an item's field data without the ignored fields, so a re-publish with nothing new (or only a
 * new view count) doesn't use a crawl. Returns null when the payload doesn't carry the fields, in which
 * case the caller can't tell what changed and should crawl.
 */
export async function fieldHash(fieldData: Record<string, unknown> | undefined, ignored: string[]): Promise<string | null> {
  if (!fieldData) return null;
  const keys = Object.keys(fieldData).filter((k) => !ignored.includes(k));
  if (keys.length <= 2) return null; // name + slug only
  const subset: Record<string, unknown> = {};
  for (const k of keys) subset[k] = fieldData[k];
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(stableStringify(subset)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Whether this event changed the live page. Published events always do. Created/changed events also fire
 * for staged edits that aren't live yet; those only matter when the item was published in the same
 * operation (the Data API's `/items/live` endpoints), i.e. lastPublished is no older than lastUpdated.
 */
export function changedLivePage(item: WebflowItem, trigger: string): boolean {
  if (item.isDraft || item.isArchived) return false;
  if (trigger === 'collection_item_published') return true;
  if (!item.lastPublished) return false;
  const published = Date.parse(item.lastPublished);
  const updated = Date.parse(item.lastUpdated ?? '');
  if (!Number.isFinite(published)) return false;
  return !Number.isFinite(updated) || published >= updated - 2 * 60 * 1000;
}
