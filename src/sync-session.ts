import { isValidToken, tokenRequirement } from './token.mjs';
import { readJson, UpdateError } from './update';

// Optional secrets are declared here; Wrangler generates the non-secret configuration.
declare global {
  interface Env { TURNSTILE_SECRET?: string; SYNC_SESSION_SECRET?: string }
}
const encoder = new TextEncoder();
function reject(status: number, code: string, message: string): never {
  throw new UpdateError(status, code, message);
}
export function turnstileConfig(env: Env) {
  if (!env.TURNSTILE_ENABLED || String(env.TURNSTILE_ENABLED) === 'false') return null;
  const hosts = (env.TURNSTILE_HOSTNAMES ?? '').split(',').map(host => host.trim());
  if (String(env.TURNSTILE_ENABLED) !== 'true' || !/^[!-~]{1,256}$/.test(env.TURNSTILE_SITE_KEY)
    || !env.TURNSTILE_SECRET || !/^[!-~]{1,256}$/.test(env.TURNSTILE_SECRET)
    || !isValidToken(env.SYNC_SESSION_SECRET) || (env.SYNC_SESSION_SECRET === env.PERSONAL_SYNC_TOKEN || env.SYNC_SESSION_SECRET === env.TURNSTILE_SECRET)
    || hosts.some(host => !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host))) {
    reject(503, 'TURNSTILE_UNAVAILABLE', 'Turnstile configuration is unavailable.');
  }
  return { siteKey: env.TURNSTILE_SITE_KEY, hosts, secret: env.TURNSTILE_SECRET, signing: env.SYNC_SESSION_SECRET };
}
async function digest(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}
function hex(bytes: Uint8Array): string { return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''); }
async function bearer(request: Request, env: Env): Promise<string> {
  if (!isValidToken(env.PERSONAL_SYNC_TOKEN)) reject(503, 'PERSONAL_SYNC_DISABLED', `Configure PERSONAL_SYNC_TOKEN with ${tokenRequirement}.`);
  const supplied = /^Bearer ([!-~]{32,64})$/.exec(request.headers.get('Authorization') ?? '')?.[1] ?? '';
  const hashes = await Promise.all([env.PERSONAL_SYNC_TOKEN, supplied].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  if (!hashes[0] || !hashes[1] || !crypto.subtle.timingSafeEqual(hashes[0], hashes[1])) reject(401, 'UNAUTHORIZED', 'A valid personal sync Bearer token is required.');
  return digest(env.PERSONAL_SYNC_TOKEN);
}
function context(request: Request, hosts: string[]): { origin: string; ip: string } {
  const origin = request.headers.get('Origin') ?? '';
  const ip = request.headers.get('CF-Connecting-IP') ?? '';
  let hostname = '';
  try { hostname = new URL(origin).hostname; } catch { /* reject below */ }
  if (!hosts.includes(hostname) || !ip || ip.length > 64 || !/^[0-9a-fA-F:.]+$/.test(ip)) reject(403, 'SYNC_SESSION_INVALID', 'A trusted frontend Origin and client context are required.');
  return { origin, ip };
}
// Atomic primary-D1 counters, shared by every isolate/location; no per-isolate limiter.
async function rate(env: Env, key: string, limit: number): Promise<void> {
  const minute = Math.floor(Date.now() / 60000);
  try {
    const db = env.DB.withSession('first-primary');
    await db.prepare('DELETE FROM sync_security_limits WHERE window < ?').bind(minute - 1).run();
    const result = await db.prepare(`INSERT INTO sync_security_limits (key, window, count) VALUES (?, ?, 1)
      ON CONFLICT (key) DO UPDATE SET window = excluded.window,
      count = CASE WHEN window = excluded.window THEN MIN(count + 1, ?) ELSE 1 END RETURNING count`)
      .bind(await digest(key), minute, limit + 1).first<{ count: number }>();
    if (!result) throw new Error('Counter unavailable');
    if (result.count > limit) reject(429, 'RATE_LIMITED', 'Request rate exceeded. Wait before retrying.');
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    reject(503, 'TURNSTILE_UNAVAILABLE', 'Sync protection is unavailable.');
  }
}
async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
interface Claims { scope: string; identity: string; origin: string; client: string; issued: number; expires: number; nonce: string }
export async function sessionRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') reject(405, 'METHOD_NOT_ALLOWED', 'Session issuance supports POST only.');
  const config = turnstileConfig(env);
  if (!config) reject(503, 'PERSONAL_SYNC_DISABLED', 'Turnstile sessions are disabled.');
  // Count all attempts before comparing bearer, including absent/incorrect credentials.
  await rate(env, 'entry:' + (request.headers.get('CF-Connecting-IP') ?? 'missing'), 10);
  await rate(env, 'entry:global', 120);
  const client = context(request, config.hosts);
  if (request.headers.has('Content-Encoding') || request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') reject(400, 'TURNSTILE_REQUIRED', 'Send unencoded application/json with turnstileToken.');
  const input = await readJson(request.body, 8192);
  if (!input || typeof input !== 'object' || Array.isArray(input)) reject(400, 'TURNSTILE_REQUIRED', 'A Turnstile token is required.');
  const data = input as Record<string, unknown>;
  if (Object.keys(data).some(key => key !== 'turnstileToken') || typeof data.turnstileToken !== 'string' || !/^[!-~]{1,2048}$/.test(data.turnstileToken)) reject(400, 'TURNSTILE_REQUIRED', 'A bounded Turnstile token is required.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let verification: unknown;
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: config.secret, response: data.turnstileToken, remoteip: client.ip }),
    });
    if (!response.ok) throw new Error('Verification unavailable');
    verification = await readJson(response.body, 16384);
  } catch { reject(503, 'TURNSTILE_UNAVAILABLE', 'Turnstile verification is unavailable.'); }
  finally { clearTimeout(timeout); }
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) reject(503, 'TURNSTILE_UNAVAILABLE', 'Turnstile verification is unavailable.');
  const result = verification as Record<string, unknown>;
  if (result.success !== true && Array.isArray(result['error-codes']) && result['error-codes'].some(code => ['internal-error', 'invalid-input-secret', 'missing-input-secret'].includes(String(code)))) reject(503, 'TURNSTILE_UNAVAILABLE', 'Turnstile verification is unavailable.');
  if (result.success !== true || result.action !== 'personal_sync' || result.hostname !== new URL(client.origin).hostname || !config.hosts.includes(String(result.hostname))) reject(403, 'TURNSTILE_FAILED', 'Turnstile verification failed.');
  // Challenge redemption precedes bearer comparison; no bearer oracle without a challenge.
  const identity = await bearer(request, env);
  const issued = Date.now();
  const claims: Claims = { scope: 'personal-sync', identity, origin: client.origin, client: await digest(client.ip), issued, expires: issued + 900000, nonce: crypto.randomUUID() };
  const payload = btoa(JSON.stringify(claims)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const signature = hex(new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(config.signing), encoder.encode(payload))));
  return Response.json({ sessionToken: `${payload}.${signature}`, expiresAt: claims.expires }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function protectPersonalSync(request: Request, env: Env): Promise<void> {
  const config = turnstileConfig(env);
  if (!config) { await bearer(request, env); return; }
  await rate(env, 'sync:' + (request.headers.get('CF-Connecting-IP') ?? 'missing'), 240);
  const client = context(request, config.hosts);
  if (!isValidToken(env.PERSONAL_SYNC_TOKEN)) reject(503, 'PERSONAL_SYNC_DISABLED', 'Personal sync is disabled.');
  const token = request.headers.get('X-Gacha-Sync-Session') ?? '';
  if (!token) reject(403, 'TURNSTILE_REQUIRED', 'A verified sync session is required.');
  if (!/^[!-~]{1,4096}$/.test(token)) reject(401, 'SYNC_SESSION_INVALID', 'Sync session is invalid or expired.');
  try {
    const parts = token.split('.');
    const payload = parts[0];
    const signature = parts[1];
    if (parts.length !== 2 || !payload || !/^[A-Za-z0-9_-]+$/.test(payload) || !signature || !/^[a-f0-9]{64}$/.test(signature)) throw new Error('Invalid');
    const bytes = Uint8Array.from(signature.match(/../g) ?? [], value => parseInt(value, 16));
    if (!await crypto.subtle.verify('HMAC', await signingKey(config.signing), bytes, encoder.encode(payload))) throw new Error('Invalid');
    const claims: unknown = JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/')));
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new Error('Invalid');
    const c = claims as Record<string, unknown>;
    const now = Date.now();
    if (c.scope !== 'personal-sync' || c.origin !== client.origin || c.client !== await digest(client.ip)
      || c.identity !== await digest(env.PERSONAL_SYNC_TOKEN) || typeof c.issued !== 'number' || typeof c.expires !== 'number'
      || !Number.isSafeInteger(c.issued) || !Number.isSafeInteger(c.expires) || c.issued > now || c.expires <= now || c.expires - c.issued !== 900000
      || typeof c.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(c.nonce)) throw new Error('Invalid');
    await rate(env, 'session:' + c.nonce, 120);
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    reject(401, 'SYNC_SESSION_INVALID', 'Sync session is invalid or expired.');
  }
  await bearer(request, env);
}
