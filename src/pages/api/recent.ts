// GET {mount}/api/recent — the last webhooks the app handled and what it did with each, newest first
// (kept 7 days). `?limit=` up to 100. Needs `Authorization: Bearer <SYNC_ADMIN_TOKEN>`.

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { authorised, json, setup } from '../../lib/runtime.ts';

export const prerender = false;

export const GET: APIRoute = async ({ request, url }) => {
  const { config, state } = setup(env as unknown as Record<string, unknown>);
  if (!authorised(request, config.adminToken)) return json({ error: 'unauthorised' }, 401);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
  return json({ events: await state.recent(limit) });
};
