// Wiring for the Workers runtime: env, KV, background work and logs (Webflow Cloud → Runtime logs).

import { readConfig } from './config.ts';
import { SyncState, type KVLike } from './state.ts';
import type { Deps } from './sync.ts';

export function log(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ app: 'jm-stock-sync', ...entry }));
}

export function setup(env: Record<string, unknown>) {
  const { config, missing } = readConfig(env);
  const state = new SyncState(env.SYNC_STATE as KVLike | undefined);
  const deps: Deps = {
    fetch: (input, init) => fetch(input, init),
    state,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  return { config, missing, state, deps };
}

/** Keep work running after the response (Astro's Cloudflare adapter exposes ctx as locals.cfContext). */
export function runInBackground(locals: unknown, work: Promise<unknown>): Promise<unknown> | undefined {
  const ctx = (locals as { cfContext?: { waitUntil(p: Promise<unknown>): void } })?.cfContext;
  if (ctx?.waitUntil) {
    ctx.waitUntil(work);
    return undefined;
  }
  return work; // local dev without a Workers context: caller awaits
}

/** `Authorization: Bearer <SYNC_ADMIN_TOKEN>`, compared in constant time. */
export function authorised(request: Request, token: string): boolean {
  if (!token) return false;
  const given = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (given.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= given.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
