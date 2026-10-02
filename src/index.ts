import { apiPage } from './page';
import catalog from './catalog.json';
import { syncMetadata, updateRequest, UpdateError } from './update';

const games = Object.keys(catalog.games);
const languages = catalog.languages;
const maxIds = catalog.max_ids;
const paths = ['/', '/api/v1/health', '/api/v1/games', '/api/v1/items'];

interface MetadataRow {
  entity_id: string;
  name: string;
  item_type: string | null;
  rank_type: string | null;
  gacha_type: string | null;
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
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    } });
  }
  if (path === '/api/v1/health') {
    query(url, []);
    for (const table of new Set(Object.values(catalog.games))) {
      await env.DB.prepare(`SELECT entity_id FROM ${table} LIMIT 1`).all();
    }
    return json({ status: 'ok', database: 'gacha_meta' });
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
    `SELECT entity_id, name, item_type, rank_type, gacha_type, source, updated_at, item_category, icon FROM ${table} WHERE namespace = ? AND kind = ? AND lang = ? AND entity_id IN (${ids.map(() => '?').join(',')})`,
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

export default {
  async fetch(request, env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const origins = env.ALLOWED_ORIGINS.split(',').map(value => value.trim()).filter(Boolean);
    const wildcard = origins.includes('*');
    const allowed = !origin || wildcard || origins.includes(origin);
    let response: Response;
    try {
      if (!allowed) fail(403, 'ORIGIN_NOT_ALLOWED', 'Origin is not allowed.');
      const url = new URL(request.url);
      if (url.search.length > 4096) fail(414, 'QUERY_TOO_LONG', 'Query is too long.');
      if (['/api/v1/admin/metadata', '/api/v1/admin/sync'].includes(url.pathname)) {
        query(url, []);
        response = await updateRequest(request, env);
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
        response = json({ error: { code: error.code, message: error.message } }, error.status);
      } else {
        // Do not log URLs, SQL parameters, headers or request bodies.
        console.error(JSON.stringify({ event: 'metadata_query_failed' }));
        response = json({ error: { code: 'DATABASE_UNAVAILABLE', message: 'Metadata database is unavailable.' } }, 503);
      }
    }
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('Vary', 'Origin');
    const admin = ['/api/v1/admin/metadata', '/api/v1/admin/sync'].includes(new URL(request.url).pathname);
    if (allowed && !admin) {
      if (wildcard) response.headers.set('Access-Control-Allow-Origin', '*');
      else if (origin) response.headers.set('Access-Control-Allow-Origin', origin);
      response.headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      response.headers.set('Access-Control-Max-Age', '86400');
    }
    if (response.status === 405) response.headers.set('Allow', admin ? 'POST' : 'GET, HEAD, OPTIONS');
    if (response.status === 401) response.headers.set('WWW-Authenticate', 'Bearer');
    return request.method === 'HEAD' ? new Response(null, response) : response;
  },
  async scheduled(_controller, env): Promise<void> {
    await syncMetadata(env);
  },
} satisfies ExportedHandler<Env>;
