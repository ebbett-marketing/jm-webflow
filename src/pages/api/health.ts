// GET {mount}/api/health — is the app deployed and fully configured? Reveals no values.

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { json, setup } from '../../lib/runtime.ts';

export const prerender = false;

export const GET: APIRoute = () => {
  const { config, missing, state } = setup(env as unknown as Record<string, unknown>);
  return json({
    ok: true,
    configured: missing.length === 0,
    webhookSecrets: config.webhookSecrets.length,
    store: state.available,
    site: config.siteUrl,
    index: config.algoliaIndex,
  });
};
