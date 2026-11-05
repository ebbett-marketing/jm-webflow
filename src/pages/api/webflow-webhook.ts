// POST {mount}/api/webflow-webhook — receives the site's Webflow webhooks (registered with
// tools/webhooks.mjs) and keeps the Algolia stock index in step with published cars.

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { describeBody, parseEvent, verifySignature } from '../../lib/webflow.ts';
import { handleEvent } from '../../lib/sync.ts';
import { json, log, runInBackground, setup } from '../../lib/runtime.ts';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const { config, missing, deps } = setup(env as unknown as Record<string, unknown>);
  if (!config.webhookSecrets.length) {
    log({ msg: 'webhook refused: no WEBFLOW_WEBHOOK_SECRETS set' });
    return json({ error: 'not configured' }, 503);
  }

  const rawBody = await request.text();
  const check = await verifySignature({
    rawBody,
    timestamp: request.headers.get('x-webflow-timestamp'),
    signature: request.headers.get('x-webflow-signature'),
    secrets: config.webhookSecrets,
  });
  if (check !== 'ok') {
    log({ msg: 'webhook refused', reason: check });
    return json({ error: 'invalid signature' }, 401);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  const event = parseEvent(body);
  const received = {
    trigger: event.trigger,
    shape: describeBody(body),
    items: event.items.slice(0, 20).map((i) => ({
      id: i.id,
      collectionId: i.collectionId,
      slug: i.slug,
      isDraft: i.isDraft,
      lastPublished: i.lastPublished,
      lastUpdated: i.lastUpdated,
    })),
  };
  log({ msg: 'webhook', ...received });

  if (missing.length) {
    log({ msg: 'sync skipped: missing settings', missing });
    return json({ ok: true, synced: false });
  }

  const work = handleEvent(config, event, deps)
    .then(async (result) => {
      log({ msg: 'sync', ...result });
      await deps.state.record({ ...received, result });
    })
    .catch(async (error) => {
      const message = String(error?.message ?? error);
      log({ msg: 'sync failed', trigger: event.trigger, error: message });
      await deps.state.record({ ...received, error: message });
    });
  const pending = runInBackground(locals, work);
  if (pending) await pending;
  return json({ ok: true });
};
