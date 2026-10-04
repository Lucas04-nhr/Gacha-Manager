import { isValidToken, tokenRequirement } from './token.mjs';
import catalog from './catalog.json';
import { validateMetadata } from './metadata.mjs';
import { upstreamJobs } from './upstream';

export class UpdateError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const maxBytes = 1024 * 1024;
const maxEntries = 2000;

export async function readJson(body: ReadableStream<Uint8Array> | null): Promise<unknown> {
  if (!body) throw new UpdateError(400, 'INVALID_JSON', 'JSON body is required.');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maxBytes) throw new UpdateError(413, 'PAYLOAD_TOO_LARGE', 'JSON payload exceeds 1 MiB.');
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const payload = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { payload.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(payload)); }
  catch { throw new UpdateError(400, 'INVALID_JSON', 'Invalid UTF-8 JSON.'); }
}

function contentType(headers: Headers): void {
  if (headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new UpdateError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
  }
}

export async function writeMetadata(db: D1Database, input: unknown): Promise<{ updated: number; updated_at: string }> {
  let data: ReturnType<typeof validateMetadata>;
  try { data = validateMetadata(input, maxEntries); }
  catch { throw new UpdateError(400, 'INVALID_METADATA', 'Invalid public metadata; check the documented schema and limits.'); }
  const updatedAt = new Date().toISOString();
  const groups = new Map<string, typeof data.entries>();
  for (const row of data.entries) {
    const table = catalog.games[row.game];
    const rows = groups.get(table) ?? [];
    rows.push(row);
    groups.set(table, rows);
  }
  // JSON expansion keeps each statement well below D1's bound-parameter limit.
  // A single D1 batch atomically updates all affected tables.
  const statements = [...groups].map(([table, rows]) => db.prepare(`
    INSERT INTO ${table} (namespace, kind, entity_id, lang, name, item_type, rank_type, source, updated_at, item_category, icon)
    SELECT json_extract(value, '$.game'), json_extract(value, '$.kind'), json_extract(value, '$.entity_id'),
      json_extract(value, '$.lang'), json_extract(value, '$.name'), json_extract(value, '$.item_type'),
      json_extract(value, '$.rank_type'), ?, ?,
      json_extract(value, '$.item_category'), json_extract(value, '$.icon')
    FROM json_each(?) WHERE 1
    ON CONFLICT (namespace, kind, lang, entity_id) DO UPDATE SET
      name=excluded.name, item_type=excluded.item_type, rank_type=excluded.rank_type,
      source=excluded.source, updated_at=excluded.updated_at,
      item_category=COALESCE(excluded.item_category, ${table}.item_category), icon=COALESCE(excluded.icon, ${table}.icon)
    WHERE ${table}.name IS NOT excluded.name
      OR ${table}.item_type IS NOT excluded.item_type OR ${table}.rank_type IS NOT excluded.rank_type
      OR ${table}.source IS NOT excluded.source
      OR ${table}.item_category IS NOT COALESCE(excluded.item_category, ${table}.item_category)
      OR ${table}.icon IS NOT COALESCE(excluded.icon, ${table}.icon)
  `).bind(data.source, updatedAt, JSON.stringify(rows)));
  const results = await db.batch(statements);
  return { updated: results.reduce((count, result) => count + result.meta.changes, 0), updated_at: updatedAt };
}

export async function updateRequest(request: Request, env: Env): Promise<Response> {
  // Browser origins are checked by the router; all writes still require the operator token.
  if (request.method !== 'POST') throw new UpdateError(405, 'METHOD_NOT_ALLOWED', 'Only POST is supported.');
  if (!isValidToken(env.METADATA_UPDATE_TOKEN)) {
    throw new UpdateError(503, 'UPDATES_DISABLED', `Configure METADATA_UPDATE_TOKEN with ${tokenRequirement}.`);
  }
  const authorization = request.headers.get('Authorization') ?? '';
  const match = /^Bearer ([^\s]{32,64})$/.exec(authorization);
  const supplied = match?.[1] ?? '';
  const encode = new TextEncoder();
  const [expectedHash, suppliedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encode.encode(env.METADATA_UPDATE_TOKEN)),
    crypto.subtle.digest('SHA-256', encode.encode(supplied)),
  ]);
  if (!crypto.subtle.timingSafeEqual(expectedHash, suppliedHash)) {
    throw new UpdateError(401, 'UNAUTHORIZED', 'A valid metadata update Bearer token is required.');
  }
  if (new URL(request.url).pathname === '/api/v1/admin/sync') {
    // workerd may expose an empty stream for a POST with no payload.
    if (request.body) {
      const reader = request.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (chunk.value.byteLength) throw new UpdateError(400, 'INVALID_BODY', 'Sync accepts no request body. Configure sources at deployment.');
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    return Response.json(await syncMetadata(env), { headers: { 'Cache-Control': 'no-store' } });
  }
  if (request.headers.has('Content-Encoding')) throw new UpdateError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Encoded request bodies are not supported.');
  contentType(request.headers);
  const result = await writeMetadata(env.DB, await readJson(request.body));
  return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
}

function feeds(config: string): string[] {
  const values: unknown = JSON.parse(config);
  if (!Array.isArray(values) || values.length > 8) throw new Error('Invalid feed configuration');
  return values.map((value: unknown) => {
    if (typeof value !== 'string') throw new Error('Invalid feed URL');
    const url = new URL(value);
    // Deployment-controlled URLs only: no request may choose a fetch destination.
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash
      || !url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')
      || /(^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname)) throw new Error('Invalid feed URL');
    return url.href;
  });
}

export async function syncMetadata(env: Env): Promise<{ updated: number; sources: number }> {
  const urls = feeds(env.METADATA_FEEDS);
  const jobs = upstreamJobs(env);
  let failures = 0;
  let updated = 0;
  for (const job of jobs) {
    try {
      const payload = await job.load();
      if (payload === null) continue; // No resolved translations; preserve existing language rows.
      const result = await writeMetadata(env.DB, payload);
      updated += result.updated;
      console.log(JSON.stringify({ event: 'metadata_sync_complete', game: job.game, lang: job.lang, updated: result.updated }));
    } catch {
      failures += 1;
      console.error(JSON.stringify({ event: 'metadata_sync_failed', game: job.game, lang: job.lang }));
    }
  }
  for (const [index, url] of urls.entries()) {
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Feed unavailable'); }
      try { contentType(response.headers); }
      catch (error) { await response.body?.cancel(); throw error; }
      const result = await writeMetadata(env.DB, await readJson(response.body));
      updated += result.updated;
      console.log(JSON.stringify({ event: 'metadata_sync_complete', feed_index: index, updated: result.updated }));
    } catch {
      failures += 1;
      console.error(JSON.stringify({ event: 'metadata_sync_failed', feed_index: index }));
    }
  }
  // Attempt every configured feed, but let Cloudflare record a failed cron execution.
  if (failures) throw new UpdateError(502, 'SYNC_FAILED', 'One or more sources failed; successful sources committed. Retry after fixing upstream failures.');
  return { updated, sources: jobs.length + urls.length };
}
