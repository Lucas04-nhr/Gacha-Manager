import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const bearer = 'Synthetic-personal-token-123456789!';
const signing = 'Synthetic-session-signing-123456789!';
const origin = 'https://blog.test';
const ip = '192.0.2.1';
const hash = value => createHash('sha256').update(value).digest('hex');
async function setup(bindings = {}) {
  const used = new Set();
  let calls = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-10-02', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'session-test' },
    bindings: { ALLOWED_ORIGINS: origin + ',https://other.test', PERSONAL_SYNC_TOKEN: bearer,
      TURNSTILE_ENABLED: 'true', TURNSTILE_SITE_KEY: 'synthetic-public-sitekey', TURNSTILE_HOSTNAMES: 'blog.test,other.test',
      TURNSTILE_SECRET: 'synthetic-turnstile-secret', SYNC_SESSION_SECRET: signing, ...bindings },
    outboundService: async request => {
      calls++;
      assert.equal(request.url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
      const body = await request.json();
      assert.equal(body.secret, 'synthetic-turnstile-secret');
      assert.equal(body.remoteip, ip);
      const scenario = body.response.replace(/^connection-/, '');
      if (scenario === 'timeout') await new Promise(resolve => setTimeout(resolve, 5500));
      if (scenario === 'unavailable') return new Response('unavailable', { status: 503 });
      if (scenario === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://evil.test/' } });
      if (scenario === 'internal') return Response.json({ success: false, 'error-codes': ['internal-error'] });
      if (scenario === 'malformed') return new Response('not json');
      const success = !used.has(body.response) && scenario !== 'failed';
      used.add(body.response);
      return Response.json({ success, hostname: scenario === 'hostname' ? 'evil.test' : 'blog.test',
        action: scenario === 'action' ? 'other' : body.response.startsWith('connection-') ? 'connection_settings' : 'personal_sync' });
    },
  }));
  try {
    const db = await mf.getD1Database('DB');
    for (const file of ['0001_metadata.sql', '0002_item_details.sql', '0003_remove_gacha_type.sql', '0004_personal_sync.sql', '0005_sync_security_limits.sql']) {
      for (const statement of (await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')).replace(/^--.*$/gm, '').split(';').filter(s => s.trim())) await db.prepare(statement).run();
    }
    const post = (path, body, extra = {}) => mf.dispatchFetch('https://worker.test/api/v1/personal/' + path, {
      method: 'POST', headers: { Origin: origin, 'CF-Connecting-IP': ip, Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body),
    });
    return { mf, db, post, calls: () => calls };
  } catch (error) { await mf.dispose(); throw error; }
}
async function code(response, expected, status) {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  const body = await response.json();
  assert.equal(body.error.code, expected);
  for (const secret of [bearer, signing, 'synthetic-turnstile-secret']) assert.ok(!JSON.stringify(body).includes(secret));
}
function signed(extra = {}, secret = signing) {
  const issued = Date.now() - 100;
  const claims = { scope: 'personal-sync', identity: hash(bearer), origin, client: hash(ip), issued, expires: issued + 900000, nonce: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', ...extra };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return payload + '.' + createHmac('sha256', secret).update(payload).digest('hex');
}

test('health advertises public configuration; incomplete/invalid enabled settings fail closed', async () => {
  for (const [bindings, status] of [[{}, 200], [{ TURNSTILE_ENABLED: 'false' }, 200], [{ TURNSTILE_SECRET: '' }, 503], [{ SYNC_SESSION_SECRET: '' }, 503], [{ TURNSTILE_HOSTNAMES: '' }, 503], [{ TURNSTILE_SITE_KEY: '' }, 503], [{ TURNSTILE_ENABLED: 'typo' }, 503]]) {
    const { mf } = await setup(bindings);
    try {
      const response = await mf.dispatchFetch('https://worker.test/api/v1/health');
      assert.equal(response.status, status, await response.clone().text());
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      const body = await response.json();
      if (status === 200) {
        assert.equal(body.status, 'ok'); assert.equal(body.database, 'gacha_meta');
        assert.deepEqual(body.turnstile, bindings.TURNSTILE_ENABLED === 'false' ? { enabled: false } : { enabled: true, siteKey: 'synthetic-public-sitekey' });
      } else assert.equal(body.error.code, 'TURNSTILE_UNAVAILABLE');
      assert.ok(!JSON.stringify(body).includes('synthetic-turnstile-secret'));
    } finally { await mf.dispose(); }
  }
});

test('issuance rejects missing/failed/replayed/mismatched challenge, service errors and timeout', async () => {
  const { mf, post, db } = await setup();
  try {
    for (const [body, expected, status] of [[{}, 'TURNSTILE_REQUIRED', 400], [{ turnstileToken: 'x'.repeat(2049) }, 'TURNSTILE_REQUIRED', 400], ...['failed', 'hostname', 'action'].map(turnstileToken => [{ turnstileToken }, 'TURNSTILE_FAILED', 403]), ...['unavailable', 'malformed', 'redirect', 'internal', 'timeout'].map(turnstileToken => [{ turnstileToken }, 'TURNSTILE_UNAVAILABLE', 503])]) {
      await code(await post('session', body), expected, status);
    }
    await db.prepare('DELETE FROM sync_security_limits').run();
    const valid = await post('session', { turnstileToken: 'one-use' });
    assert.equal(valid.status, 200);
    const session = await valid.json();
    assert.match(session.sessionToken, /^[!-~]{1,4096}$/);
    assert.ok(session.expiresAt > Date.now() && session.expiresAt <= Date.now() + 900000);
    await code(await post('session', { turnstileToken: 'one-use' }), 'TURNSTILE_FAILED', 403);
    await code(await post('session', { turnstileToken: 'fresh' }, { Authorization: 'Bearer incorrect' }), 'UNAUTHORIZED', 401);
    await db.prepare('DELETE FROM sync_security_limits').run();
    await code(await post('session', { turnstileToken: 'fresh' }), 'TURNSTILE_FAILED', 403);
  } finally { await mf.dispose(); }
});

test('all actions gate before parsing/data access; forged, expired, binding, scope and rotated-secret sessions fail', async () => {
  const { mf, post } = await setup();
  try {
    for (const action of ['list', 'read', 'write', 'delete_account', 'unknown']) await code(await post('sync', { action }), 'TURNSTILE_REQUIRED', 403);
    for (const session of ['forged', signed({}, 'Other-session-signing-secret-12345!'), signed({ scope: 'metadata' }), signed({ origin: 'https://other.test' }), signed({ client: hash('192.0.2.2') }), signed({ identity: hash('rotated') }), signed({ issued: Date.now() - 1000000, expires: Date.now() - 100000 })]) {
      await code(await post('sync', { action: 'list' }, { 'X-Gacha-Sync-Session': session }), 'SYNC_SESSION_INVALID', 401);
    }
    await code(await post('sync', { action: 'list' }, { 'X-Gacha-Sync-Session': signed(), Authorization: '' }), 'UNAUTHORIZED', 401);
    assert.equal((await post('sync', { action: 'list' }, { 'X-Gacha-Sync-Session': signed() })).status, 200);
  } finally { await mf.dispose(); }
});

test('one issued session supports 500-row pagination and multiple batches; conflicts/cancellation retain committed batches', async () => {
  const { mf, post } = await setup();
  try {
    const issued = await (await post('session', { turnstileToken: 'normal' })).json();
    const headers = { 'X-Gacha-Sync-Session': issued.sessionToken };
    const sync = body => post('sync', body, headers);
    let revision = (await (await sync({ action: 'list' })).json()).revision;
    const initial = revision;
    const rows = Array.from({ length: 501 }, (_, i) => ({ id: String(i + 1), item_id: '10001', time: '2026-10-03 12:00:00', gacha_type: '301', uigf_gacha_type: '301' }));
    const write = list => ({ action: 'write', game: 'hk4e', uid: '123', timezone: 8, revision, list });
    revision = (await (await sync(write(rows))).json()).revision;
    const committed = revision;
    revision = (await (await sync(write([{ ...rows[0], id: '502' }]))).json()).revision;
    assert.ok(revision > committed);
    const stale = await sync({ ...write([]), revision: initial });
    assert.equal(stale.status, 409); assert.equal((await stale.json()).error.code, 'SYNC_CONFLICT');
    const first = await (await sync({ action: 'read', game: 'hk4e', uid: '123', limit: 500 })).json();
    assert.equal(first.list.length, 500);
    const second = await (await sync({ action: 'read', game: 'hk4e', uid: '123', limit: 500, after: first.next })).json();
    assert.equal(second.list.length, 2);
    // A cancelled flow sends no more batches. An expired subsequent request cannot undo prior commits.
    assert.equal((await post('sync', write([]), { 'X-Gacha-Sync-Session': signed({ issued: Date.now() - 1000000, expires: Date.now() - 100000 }) })).status, 401);
    assert.equal((await (await sync({ action: 'list' })).json()).revision, revision);
    assert.equal((await sync({ action: 'delete_account', game: 'hk4e', uid: '123', revision })).status, 200);
  } finally { await mf.dispose(); }
});

test('OPTIONS is unauthenticated; errors and 429 carry CORS; global atomic limits precede bearer probing', async () => {
  const { mf, post, calls, db } = await setup();
  try {
    for (const path of ['session', 'sync']) {
      const response = await mf.dispatchFetch('https://worker.test/api/v1/personal/' + path, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization, Content-Type, X-Gacha-Sync-Session' } });
      assert.equal(response.status, 204); assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
      assert.match(response.headers.get('Access-Control-Allow-Headers'), /X-Gacha-Sync-Session/);
    }
    assert.equal(calls(), 0);
    await code(await post('session', { turnstileToken: 'normal' }, { Origin: origin, 'CF-Connecting-IP': 'invalid' }), 'SYNC_SESSION_INVALID', 403);
    for (let i = 0; i < 10; i++) await code(await post('session', { turnstileToken: `failed-auth-${i}` }, { Authorization: '' }), 'UNAUTHORIZED', 401);
    const limited = await post('session', { turnstileToken: 'blocked' });
    assert.equal(limited.headers.get('Retry-After'), '60');
    await code(limited, 'RATE_LIMITED', 429);
    assert.equal(calls(), 10);
    await db.prepare('DELETE FROM sync_security_limits').run();
    await db.prepare('INSERT INTO sync_security_limits VALUES (?, ?, ?)').bind(hash('session:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), Math.floor(Date.now() / 60000), 120).run();
    await code(await post('sync', { action: 'list' }, { 'X-Gacha-Sync-Session': signed() }), 'RATE_LIMITED', 429);
    const rows = await db.prepare('SELECT key FROM sync_security_limits').all();
    assert.ok(rows.results.every(row => /^[a-f0-9]{64}$/.test(row.key)));
    assert.equal((await post('session', { turnstileToken: 'normal' }, { Origin: 'https://evil.test' })).status, 403);
  } finally { await mf.dispose(); }
});

test('source logging is fixed and sanitized; no request/challenge/session logging', async () => {
  for (const name of ['sync-session.ts', 'personal-sync.ts']) assert.ok(!/console\./.test(await readFile(new URL('../src/' + name, import.meta.url), 'utf8')));
});

test('security counters fail closed and concurrent issuance consumes a single remaining admission', async () => {
  const { mf, post, db, calls } = await setup();
  try {
    const minute = Math.floor(Date.now() / 60000);
    await db.prepare('INSERT INTO sync_security_limits VALUES (?, ?, ?)').bind(hash('entry:' + ip), minute, 9).run();
    const responses = await Promise.all(Array.from({ length: 5 }, () => post('session', {})));
    assert.deepEqual(responses.map(response => response.status).sort(), [400, 429, 429, 429, 429]);
    assert.equal(calls(), 0);
    await db.prepare('DROP TABLE sync_security_limits').run();
    await code(await post('session', { turnstileToken: 'never-redeemed' }), 'TURNSTILE_UNAVAILABLE', 503);
    await code(await post('sync', { action: 'list' }, { 'X-Gacha-Sync-Session': signed() }), 'TURNSTILE_UNAVAILABLE', 503);
    assert.equal(calls(), 0);
  } finally { await mf.dispose(); }
});

test('session and sync bodies remain bounded; malformed and encoded challenge bodies cannot issue sessions', async () => {
  const { mf, post, calls } = await setup();
  try {
    await code(await post('session', { turnstileToken: 'x'.repeat(9000) }), 'PAYLOAD_TOO_LARGE', 413);
    await code(await post('session', { turnstileToken: 'x', archive: {} }), 'TURNSTILE_REQUIRED', 400);
    await code(await post('session', { turnstileToken: 'x' }, { 'Content-Encoding': 'gzip' }), 'TURNSTILE_REQUIRED', 400);
    const malformed = await mf.dispatchFetch('https://worker.test/api/v1/personal/session', { method: 'POST', headers: { Origin: origin, 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' }, body: '{' });
    await code(malformed, 'INVALID_JSON', 400);
    await code(await post('sync', { action: 'list', extra: 'x'.repeat(1024 * 1024) }, { 'X-Gacha-Sync-Session': signed() }), 'PAYLOAD_TOO_LARGE', 413);
    assert.equal(calls(), 0);
  } finally { await mf.dispose(); }
});

function anonymous(mf, body, headers = {}) {
  return mf.dispatchFetch('https://worker.test/api/v1/connection/verify', {
    method: 'POST', headers: { Origin: origin, 'CF-Connecting-IP': ip, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}

test('anonymous connection check needs no bearer and grants no identity/session or personal data access', async () => {
  const { mf, db, post } = await setup({ PERSONAL_SYNC_TOKEN: '' });
  try {
    // Even absent personal tables must not be read, written or reconstructed by this check.
    for (const table of ['personal_sync_records', 'personal_sync_accounts', 'personal_sync_state']) await db.prepare(`DROP TABLE ${table}`).run();
    const response = await anonymous(mf, { turnstileToken: 'connection-ok' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(response.headers.get('Set-Cookie'), null);
    assert.deepEqual(await response.json(), { verified: true });
    assert.deepEqual((await db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'personal_sync_%'").all()).results, []);
    await code(await post('sync', { action: 'list' }), 'PERSONAL_SYNC_DISABLED', 503);
  } finally { await mf.dispose(); }
});

test('connection tokens are bounded, single-use and action/hostname specific; cannot authorize any personal action', async () => {
  const { mf, post, db } = await setup();
  try {
    for (const [body, expected, status] of [[{}, 'TURNSTILE_REQUIRED', 400], [{ turnstileToken: '' }, 'TURNSTILE_REQUIRED', 400], [{ turnstileToken: 'x'.repeat(2049) }, 'TURNSTILE_REQUIRED', 400], [{ turnstileToken: 'x'.repeat(9000) }, 'PAYLOAD_TOO_LARGE', 413], [{ turnstileToken: 'connection-ok', extra: {} }, 'TURNSTILE_REQUIRED', 400], ...['failed', 'hostname', 'action'].map(value => [{ turnstileToken: 'connection-' + value }, 'TURNSTILE_FAILED', 403]), [{ turnstileToken: 'personal-for-anonymous' }, 'TURNSTILE_FAILED', 403]]) {
      await code(await anonymous(mf, body), expected, status);
    }
    await db.prepare('DELETE FROM sync_security_limits').run();
    assert.equal((await anonymous(mf, { turnstileToken: 'connection-replay' })).status, 200);
    await code(await anonymous(mf, { turnstileToken: 'connection-replay' }), 'TURNSTILE_FAILED', 403);
    await code(await post('session', { turnstileToken: 'connection-replay' }), 'TURNSTILE_FAILED', 403);
    await code(await post('session', { turnstileToken: 'connection-fresh-for-session' }), 'TURNSTILE_FAILED', 403);
    for (const action of ['list', 'read', 'write', 'delete_account']) {
      await code(await post('sync', { action }), 'TURNSTILE_REQUIRED', 403);
      await code(await post('sync', { action }, { 'X-Gacha-Sync-Session': '{"verified":true}' }), 'SYNC_SESSION_INVALID', 401);
    }
  } finally { await mf.dispose(); }
});

test('anonymous Origin/CORS/context checks reject third-party consumption before Siteverify', async () => {
  const { mf, calls, db } = await setup();
  try {
    const response = await mf.dispatchFetch('https://worker.test/api/v1/connection/verify', { method: 'OPTIONS', headers: {
      Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type',
    } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(response.headers.get('Access-Control-Allow-Headers'), 'Content-Type');
    assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
    assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sync_security_limits').first()).n, 0);
    for (const headers of [{ Origin: '' }, { Origin: 'https://evil.test' }]) {
      const denied = await anonymous(mf, { turnstileToken: 'connection-not-consumed' }, headers);
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).error.code, 'ORIGIN_NOT_ALLOWED');
      assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
    }
    await code(await anonymous(mf, { turnstileToken: 'connection-no-ip' }, { 'CF-Connecting-IP': 'invalid' }), 'TURNSTILE_FAILED', 403);
    await code(await anonymous(mf, { turnstileToken: 'connection-cookie' }, { Cookie: 'synthetic=cookie' }), 'TURNSTILE_REQUIRED', 400);
    // Allowed Origin, but verifier returns another allowed hostname: exact match still required.
    const mismatch = await anonymous(mf, { turnstileToken: 'connection-host-match' }, { Origin: 'https://other.test' });
    assert.equal(mismatch.status, 403); assert.equal((await mismatch.json()).error.code, 'TURNSTILE_FAILED');
    const deniedPreflight = await mf.dispatchFetch('https://worker.test/api/v1/connection/verify', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization' } });
    await code(deniedPreflight, 'METHOD_NOT_ALLOWED', 405);
    assert.equal(calls(), 1);
  } finally { await mf.dispose(); }
  const wildcard = await setup({ ALLOWED_ORIGINS: '*' });
  try {
    assert.equal((await anonymous(wildcard.mf, { turnstileToken: 'connection-no-wildcard' })).status, 403);
    assert.equal(wildcard.calls(), 0);
  } finally { await wildcard.mf.dispose(); }
});

test('anonymous verification fails closed on disabled/incomplete configuration, unavailable counters and Siteverify faults', async () => {
  for (const bindings of [{ TURNSTILE_ENABLED: 'false' }, { TURNSTILE_SECRET: '' }, { TURNSTILE_HOSTNAMES: '' }, { TURNSTILE_SITE_KEY: '' }, { SYNC_SESSION_SECRET: '' }]) {
    const { mf, calls } = await setup(bindings);
    try {
      await code(await anonymous(mf, { turnstileToken: 'connection-config' }), 'TURNSTILE_UNAVAILABLE', 503);
      assert.equal(calls(), 0);
    } finally { await mf.dispose(); }
  }
  const { mf, db } = await setup();
  try {
    for (const value of ['unavailable', 'malformed', 'redirect', 'internal', 'timeout']) await code(await anonymous(mf, { turnstileToken: 'connection-' + value }), 'TURNSTILE_UNAVAILABLE', 503);
    await db.prepare('DROP TABLE sync_security_limits').run();
    await code(await anonymous(mf, { turnstileToken: 'connection-no-counter' }), 'TURNSTILE_UNAVAILABLE', 503);
  } finally { await mf.dispose(); }
});

test('anonymous and personal session issuance share atomic per-IP and global rate budgets', async () => {
  const { mf, db, post, calls } = await setup();
  try {
    await db.prepare('INSERT INTO sync_security_limits VALUES (?, ?, ?)').bind(hash('entry:' + ip), Math.floor(Date.now() / 60000), 9).run();
    const responses = await Promise.all([anonymous(mf, {}), post('session', {}), anonymous(mf, {})]);
    assert.deepEqual(responses.map(response => response.status).sort(), [400, 429, 429]);
    for (const response of responses.filter(response => response.status === 429)) {
      assert.equal(response.headers.get('Retry-After'), '60'); await code(response, 'RATE_LIMITED', 429);
    }
    await db.prepare('DELETE FROM sync_security_limits').run();
    await db.prepare('INSERT INTO sync_security_limits VALUES (?, ?, ?)').bind(hash('entry:global'), Math.floor(Date.now() / 60000), 120).run();
    await code(await anonymous(mf, { turnstileToken: 'connection-global-block' }), 'RATE_LIMITED', 429);
    assert.equal(calls(), 0);
  } finally { await mf.dispose(); }
});
