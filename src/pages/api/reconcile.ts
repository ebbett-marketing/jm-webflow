// POST {mount}/api/reconcile — compare the live sitemap with the stock index now: crawl published cars
// that are missing from search and delete records whose page is gone. `?dry=1` reports without changing
// anything. Needs `Authorization: Bearer <SYNC_ADMIN_TOKEN>`.

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { reconcile } from '../../lib/sync.ts';
import { json, log, setup } from '../../lib/runtime.ts';

export const prerender = false;

function authorised(request: Request, token: string): boolean {
  if (!token) return false;
  const header = request.headers.get('authorization') ?? '';
  const given = header.replace(/^Bearer\s+/i, '');
  if (given.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= given.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

export const POST: APIRoute = async ({ request, url }) => {
  const { config, missing, deps } = setup(env as unknown as Record<string, unknown>);
  if (!authorised(request, config.adminToken)) return json({ error: 'unauthorised' }, 401);
  if (missing.length) return json({ error: 'missing settings', missing }, 503);

  const dryRun = url.searchParams.get('dry') === '1';
  try {
    const result = await reconcile(config, { ...deps, sleep: async () => {} }, { dryRun });
    log({ msg: 'manual reconcile', ...result });
    return json(result);
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    log({ msg: 'manual reconcile failed', error: message });
    return json({ error: message }, 502);
  }
};
