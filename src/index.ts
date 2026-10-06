import { apiPage } from './page';
import catalog from './catalog.json';
import { updateRequest, UpdateError } from './update';
import { personalSyncRequest } from './personal-sync';
import { sessionRequest, connectionVerifyRequest, TurnstileConfigError, ClientContextError } from './sync-session';

const games = Object.keys(catalog.games);
const languages = catalog.languages;
const maxIds = catalog.max_ids;
const paths = ['/', '/api/v1/health', '/api/v1/games', '/api/v1/items'];

interface MetadataRow {
  entity_id: string;
  name: string;
  item_type: string | null;
  rank_type: string | null;
  source: string;
  updated_at: string;
  item_category: string | null;
  icon: string | null;
}

interface PublicItem {
  item_id: string;
  name: string;
  item_type: string | null;
  rank_type: string | null;
  rarity: number | null;
  rank: number | null;
  type: string | null;
  icon: string | null;
  source: string;
  updated_at: string;
}

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

function fail(status: number, code: string, message: string): never {
  throw new HttpError(status, code, message);
}

function query(url: URL, allowed: string[]): void {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) {
      fail(400, 'INVALID_QUERY', 'Unknown or repeated query parameter. Send public item metadata only.');
    }
  }
}

function json(value: unknown, status = 200, cache = 'no-store'): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': cache } });
}

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  if (!paths.includes(path)) {
    fail(404, 'NOT_FOUND', 'Endpoint not found.');
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    fail(405, 'METHOD_NOT_ALLOWED', 'Only GET, HEAD and OPTIONS are supported.');
  }
  if (path === '/') {
    query(url, []);
    return new Response(apiPage, { headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    } });
  }
  if (path === '/api/v1/health') {
    query(url, []);
    for (const table of new Set(Object.values(catalog.games))) {
      await env.DB.prepare(`SELECT entity_id FROM ${table} LIMIT 1`).all();
    }
    // Discovery is public and independent of private protection readiness.
    // Never advertise disabled mode when enabled configuration is incomplete.
    const enabled = !!env.TURNSTILE_ENABLED && String(env.TURNSTILE_ENABLED) !== 'false';
    const siteKey = /^[!-~]{1,256}$/.test(env.TURNSTILE_SITE_KEY ?? '') ? env.TURNSTILE_SITE_KEY : undefined;
    return json({ status: 'ok', database: 'gacha_meta', turnstile: enabled ? { enabled: true, siteKey } : { enabled: false } });
  }
  if (path === '/api/v1/games') {
    query(url, []);
    return json({ games, languages, max_ids: maxIds, default_lang: catalog.default_lang, language_fallback: false }, 200, 'public, max-age=3600');
  }
  query(url, ['game', 'lang', 'ids']);
  const game = url.searchParams.get('game') ?? '';
  const lang = url.searchParams.get('lang') ?? catalog.default_lang;
  if (!games.includes(game)) fail(400, 'INVALID_GAME', 'game must be hk4e, hk4e_ugc, hkrpg or nap.');
  if (!languages.some(value => value === lang)) fail(400, 'INVALID_LANGUAGE', 'Unsupported language. See /api/v1/games.');
  const idsValue = url.searchParams.get('ids') ?? '';
  const rawIds = idsValue.split(',');
  if (rawIds.length > maxIds || rawIds.some(id => !/^\d{1,20}$/.test(id))) {
    fail(400, 'INVALID_IDS', `ids must contain 1–${maxIds} comma-separated decimal strings, each at most 20 digits.`);
  }
  const ids = [...new Set(rawIds)];
  const kind = 'item';
  // Only this static allowlist selects SQL table names; all request values are bound.
  const table = catalog.games[game as keyof typeof catalog.games];
  const result = await env.DB.prepare(
    `SELECT entity_id, name, item_type, rank_type, source, updated_at, item_category, icon FROM ${table} WHERE namespace = ? AND kind = ? AND lang = ? AND entity_id IN (${ids.map(() => '?').join(',')})`,
  ).bind(game, kind, lang, ...ids).all<MetadataRow>();
  const byId = new Map(result.results.map(item => [item.entity_id, item]));
  const entries = ids.flatMap<PublicItem>(id => {
    const item = byId.get(id);
    if (!item) return [];
    const common = { name: item.name, source: item.source, updated_at: item.updated_at };
    const rawRank = Number(item.rank_type);
    const rank = game === 'hk4e_ugc' ? (rawRank >= 1 && rawRank <= 5 ? rawRank : null) : rawRank + (game === 'nap' ? 1 : 0);
    return [{ item_id: id, ...common, item_type: item.item_type, rank_type: item.rank_type,
      rarity: rank, rank, type: item.item_category, icon: item.icon }];
  });
  // No default names or rarity for missing data, and no implicit language fallback.
  const data = Object.fromEntries(entries.map(item => [item.item_id, { name: item.name, rank: item.rank, type: item.type, icon: item.icon }]));
  return json({ game, lang, items: entries, data, missing_ids: ids.filter(id => !byId.has(id)) }, 200, 'public, max-age=300');
}

function originAllowed(origin: string, rules: string[]): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) return false;
  return rules.some(rule => {
    if (rule === origin) return true;
    if (rule === 'localhost' || rule === '127.0.0.1') return url.hostname === rule;
    if (rule.startsWith('*.')) {
      const domain = rule.slice(2).toLowerCase();
      return /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(domain) && url.hostname.endsWith(`.${domain}`);
    }
    return false;
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const origins = env.ALLOWED_ORIGINS.split(',').map(value => value.trim()).filter(Boolean);
    const wildcard = origins.includes('*');
    const connection = new URL(request.url).pathname === '/api/v1/connection/verify';
    const session = new URL(request.url).pathname === '/api/v1/personal/session';
    const personal = session || new URL(request.url).pathname === '/api/v1/personal/sync';
    const admin = ['/api/v1/admin/metadata', '/api/v1/admin/sync'].includes(new URL(request.url).pathname);
    const postEndpoint = personal || admin || connection;
    const allowed = connection ? !!origin && originAllowed(origin, origins) : !origin || (!personal && wildcard) || originAllowed(origin, origins);
    let response: Response;
    try {
      if (!allowed) fail(403, 'ORIGIN_NOT_ALLOWED', 'Origin is not allowed.');
      const url = new URL(request.url);
      if (url.search.length > 4096) fail(414, 'QUERY_TOO_LONG', 'Query is too long.');
      if (postEndpoint) {
        query(url, []);
        if (request.method === 'OPTIONS') {
          const method = request.headers.get('Access-Control-Request-Method');
          const headers = request.headers.get('Access-Control-Request-Headers')?.split(',').map(value => value.trim().toLowerCase()) ?? [];
          if ((method && method !== 'POST') || headers.some(value => !(connection ? ['content-type'] : personal ? ['authorization', 'content-type', 'x-gacha-sync-session'] : ['authorization', 'content-type']).includes(value))) {
            fail(405, 'METHOD_NOT_ALLOWED', connection ? 'Preflight permits POST with Content-Type only.' : personal ? 'Preflight permits POST with Authorization, Content-Type and X-Gacha-Sync-Session only.' : 'Preflight permits POST with Authorization and Content-Type only.');
          }
          response = new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
        } else {
          response = connection ? await connectionVerifyRequest(request, env) : session ? await sessionRequest(request, env) : personal ? await personalSyncRequest(request, env) : await updateRequest(request, env);
        }
      } else if (request.method === 'OPTIONS') {
        if (!paths.includes(url.pathname)) fail(404, 'NOT_FOUND', 'Endpoint not found.');
        query(url, ['/api/v1/items'].includes(url.pathname) ? ['game', 'lang', 'ids'] : []);
        const method = request.headers.get('Access-Control-Request-Method');
        const headers = request.headers.get('Access-Control-Request-Headers');
        if ((method && !['GET', 'HEAD'].includes(method)) || headers) {
          fail(405, 'METHOD_NOT_ALLOWED', 'Preflight only permits GET/HEAD without custom headers.');
        }
        response = new Response(null, { status: 204 });
      } else {
        response = await route(request, env, url);
      }
    } catch (error) {
      if (error instanceof HttpError || error instanceof UpdateError) {
        response = json({ error: { code: error.code, message: error.message, ...(error instanceof TurnstileConfigError || error instanceof ClientContextError ? { reasons: error.reasons } : {}) } }, error.status);
      } else {
        // Do not log URLs, SQL parameters, headers or request bodies.
        console.error(JSON.stringify({ event: connection ? 'connection_verification_failed' : personal ? 'personal_sync_failed' : 'metadata_query_failed' }));
        response = json({ error: { code: connection ? 'TURNSTILE_UNAVAILABLE' : 'DATABASE_UNAVAILABLE', message: connection ? 'Connection verification is unavailable.' : personal ? 'Personal sync database is unavailable.' : 'Metadata database is unavailable.' } }, 503);
      }
    }
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('Vary', 'Origin');
    if (allowed) {
      if (wildcard && !personal && !connection) response.headers.set('Access-Control-Allow-Origin', '*');
      else if (origin) response.headers.set('Access-Control-Allow-Origin', origin);
      response.headers.set('Access-Control-Allow-Methods', postEndpoint ? 'POST, OPTIONS' : 'GET, HEAD, OPTIONS');
      if (postEndpoint) response.headers.set('Access-Control-Allow-Headers', connection ? 'Content-Type' : personal ? 'Authorization, Content-Type, X-Gacha-Sync-Session' : 'Authorization, Content-Type');
      response.headers.set('Access-Control-Max-Age', '86400');
    }
    if (response.status === 405) response.headers.set('Allow', postEndpoint ? 'POST, OPTIONS' : 'GET, HEAD, OPTIONS');
    if (response.status === 429) response.headers.set('Retry-After', '60');
    if (response.status === 401) response.headers.set('WWW-Authenticate', 'Bearer');
    return request.method === 'HEAD' ? new Response(null, response) : response;
  },
} satisfies ExportedHandler<Env>;
