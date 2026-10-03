import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const fixture = JSON.parse(await readFile(new URL('./fixtures/metadata.json', import.meta.url), 'utf8'));
fixture.entries = fixture.entries.filter(row => row.kind === 'item');
const schema = (await Promise.all(['0001_metadata.sql', '0002_item_details.sql', '0003_remove_gacha_type.sql'].map(file => readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')))).join('\n');
const token = 'test-only-metadata-secret-not-for-production';
const options = { unsafeTriggerHandlers: true, modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-10-02', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'update-tests' }, bindings: { ALLOWED_ORIGINS: '*', METADATA_UPDATE_TOKEN: token, METADATA_FEEDS: '[]', UPSTREAM_SYNC_ENABLED: 'false', UPSTREAM_LANGUAGES: '[]' } };
let mf;
let db;
async function migrate(instance) {
  const database = await instance.getD1Database('DB');
  for (const sql of schema.split(';').filter(sql => sql.trim())) await database.prepare(sql).run();
  return database;
}
before(async () => { mf = new Miniflare(convertV4MiniflareOptions(options)); db = await migrate(mf); });
after(async () => { await mf?.dispose(); });
const post = (payload, init = {}) => mf.dispatchFetch('https://worker.test/api/v1/admin/metadata', {
  method: 'POST', body: typeof payload === 'string' ? payload : JSON.stringify(payload), ...init,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
});
const item = async (game, id) => (await mf.dispatchFetch(`https://worker.test/api/v1/items?game=${game}&lang=zh-cn&ids=${id}`)).json();

test('admin updates all four tables atomically and supports authenticated browser requests', async () => {
  const response = await post(fixture);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).updated, fixture.entries.length);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await item('hk4e', '10000003')).items[0].name, '琴');
  assert.equal((await item('hk4e_ugc', '10000003')).items[0].name, '测试衣装');
  assert.equal((await item('nap', '1001')).items[0].rarity, 5);
  assert.equal((await item('hkrpg', '1001')).items[0].name, '三月七');
  assert.equal((await post(fixture, { headers: { Origin: 'https://blog.test' } })).status, 200);
  assert.equal((await post(fixture, { headers: { Origin: 'https://blog.test', Authorization: '' } })).status, 401);
  for (const method of ['GET', 'HEAD', 'DELETE']) {
    const blocked = await mf.dispatchFetch('https://worker.test/api/v1/admin/metadata', { method });
    assert.equal(blocked.status, 405);
    assert.equal(blocked.headers.get('Allow'), 'POST, OPTIONS');
    assert.equal(blocked.headers.get('Access-Control-Allow-Origin'), '*');
  }
});

test('authentication fails closed without token or with malformed/wrong authorization', async () => {
  for (const authorization of ['', 'Bearer wrong', `Basic ${token}`, `Bearer ${token} extra`]) {
    const response = await post(fixture, { headers: { Authorization: authorization } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('WWW-Authenticate'), 'Bearer');
  }
  const disabled = new Miniflare(convertV4MiniflareOptions({ ...options, bindings: { ALLOWED_ORIGINS: '*', METADATA_FEEDS: '[]', UPSTREAM_SYNC_ENABLED: 'false', UPSTREAM_LANGUAGES: '[]' } }));
  try {
    const response = await disabled.dispatchFetch('https://worker.test/api/v1/admin/metadata', { method: 'POST' });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'UPDATES_DISABLED');
    assert.equal((await disabled.dispatchFetch('https://worker.test/api/v1/games')).status, 200);
  } finally { await disabled.dispose(); }
});

test('admin browser preflight and writes enforce the origin allowlist and Bearer authentication', async () => {
  const origin = 'https://blog.test';
  const local = new Miniflare(convertV4MiniflareOptions({ ...options, bindings: { ...options.bindings, ALLOWED_ORIGINS: origin } }));
  try {
    await migrate(local);
    for (const path of ['/api/v1/admin/metadata', '/api/v1/admin/sync']) {
      const request = init => local.dispatchFetch(`https://worker.test${path}`, init);
      const headers = { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization, Content-Type' };
      const preflight = await request({ method: 'OPTIONS', headers });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
      assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
      assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'Authorization, Content-Type');
      assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'), null);
      assert.equal(preflight.headers.get('Cache-Control'), 'no-store');
      for (const changes of [{ 'Access-Control-Request-Method': 'GET' }, { 'Access-Control-Request-Headers': 'authorization, x-extra' }]) {
        assert.equal((await request({ method: 'OPTIONS', headers: { ...headers, ...changes } })).status, 405);
      }
      const body = path.endsWith('/metadata') ? JSON.stringify(fixture) : undefined;
      const init = { method: 'POST', body, headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
      const response = await request(init);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      for (const authorization of ['', 'Bearer wrong']) {
        const denied = await request({ ...init, headers: { ...init.headers, Authorization: authorization } });
        assert.equal(denied.status, 401);
        assert.equal(denied.headers.get('Access-Control-Allow-Origin'), origin);
      }
      for (const method of ['POST', 'OPTIONS']) {
        const denied = await request({ ...init, body: method === 'POST' ? body : undefined, method, headers: { ...init.headers, Origin: 'https://evil.test' } });
        assert.equal(denied.status, 403);
        assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
      }
      assert.equal((await local.dispatchFetch(`https://worker.test${path}?token=synthetic`, { method: 'OPTIONS', headers })).status, 400);
    }
  } finally { await local.dispose(); }
});

test('validate full payload before writes and reject user fields, wrong types and invalid JSON', async () => {
  const bad = { ...fixture, entries: [{ ...fixture.entries[0], name: 'must not change' }, { ...fixture.entries.find(row => row.game === 'hkrpg'), uid: '123' }] };
  assert.equal((await post(bad)).status, 400);
  assert.equal((await item('hk4e', '10000003')).items[0].name, '琴');
  assert.equal((await post('{')).status, 400);
  assert.equal((await post(fixture, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await post(fixture, { headers: { 'Content-Encoding': 'gzip' } })).status, 415);
  assert.equal((await post({ ...fixture, entries: [fixture.entries[0], fixture.entries[0]] })).status, 400);
  assert.equal((await post(' '.repeat(1024 * 1024 + 1))).status, 413);
  const tooMany = Array.from({ length: 2001 }, (_, i) => ({ ...fixture.entries[0], item_id: String(i) }));
  assert.equal((await post({ ...fixture, entries: tooMany })).status, 400);
});

test('D1 rolls back earlier table writes when a later table fails', async () => {
  await db.prepare("CREATE TRIGGER reject_test_update BEFORE UPDATE ON starrail_meta BEGIN SELECT RAISE(ABORT, 'test rollback'); END").run();
  try {
    const payload = { ...fixture, entries: [{ ...fixture.entries[0], name: 'must roll back' }, { ...fixture.entries.find(row => row.game === 'hkrpg'), name: 'rejected' }] };
    assert.equal((await post(payload)).status, 503);
    assert.equal((await item('hk4e', '10000003')).items[0].name, '琴');
    assert.equal((await item('hkrpg', '1001')).items[0].name, '三月七');
  } finally { await db.prepare('DROP TRIGGER reject_test_update').run(); }
});

test('upserts preserve unrelated games and language entries', async () => {
  const updated = { ...fixture, entries: [{ ...fixture.entries[0], name: "Jean's updated name" }] };
  assert.equal((await post(updated)).status, 200);
  assert.equal((await item('hk4e', '10000003')).items[0].name, "Jean's updated name");
  const english = await mf.dispatchFetch('https://worker.test/api/v1/items?game=hk4e&ids=10000003');
  assert.equal((await english.json()).items[0].name, 'Jean');
  assert.equal((await item('hkrpg', '1001')).items.length, 1);
});

test('JSON expansion supports updates beyond D1 SQL parameter limits', async () => {
  const entries = Array.from({ length: 200 }, (_, i) => ({ ...fixture.entries[0], item_id: String(90000000 + i) }));
  const response = await post({ ...fixture, entries });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).updated, 200);
  assert.equal((await item('hk4e', '90000199')).items.length, 1);
});

test('authenticated manual sync fetches configured normalized feeds with no authorization forwarding', async () => {
  const calls = [];
  const sync = new Miniflare(convertV4MiniflareOptions({ ...options,
    bindings: { ...options.bindings, METADATA_FEEDS: '["https://metadata.example.com/feed.json"]' },
    outboundService: async request => {
      calls.push(request.url);
      assert.equal(request.headers.get('Authorization'), null);
      return Response.json(fixture);
    },
  }));
  try {
    await migrate(sync);
    const response = await sync.dispatchFetch('https://worker.test/api/v1/admin/sync', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ['https://metadata.example.com/feed.json']);
    const query = await sync.dispatchFetch('https://worker.test/api/v1/items?game=hk4e_ugc&lang=zh-cn&ids=10000003');
    assert.equal((await query.json()).items[0].name, '测试衣装');
  } finally { await sync.dispose(); }
});

test('manual sync continues after a failed feed, keeps existing metadata, and signals failure', async () => {
  const calls = [];
  const sync = new Miniflare(convertV4MiniflareOptions({ ...options,
    bindings: { ...options.bindings, METADATA_FEEDS: '["https://metadata.example.com/bad.json","https://metadata.example.com/good.json"]' },
    outboundService: async request => {
      calls.push(request.url);
      return request.url.endsWith('/bad.json') ? new Response('upstream failed', { status: 500 }) : Response.json(fixture);
    },
  }));
  try {
    await migrate(sync);
    const response = await sync.dispatchFetch('https://worker.test/api/v1/admin/sync', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 502);
    assert.equal(calls.length, 2);
    const query = await sync.dispatchFetch('https://worker.test/api/v1/items?game=hk4e&lang=zh-cn&ids=10000003');
    assert.equal((await query.json()).items[0].name, '琴');
  } finally { await sync.dispose(); }
});

test('empty manual sync feed configuration is a no-op', async () => {
  const response = await mf.dispatchFetch('https://worker.test/api/v1/admin/sync', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal((await item('hk4e', '10000003')).items[0].name, "Jean's updated name");
});

test('manual sync rejects redirects and invalid metadata without following or writing', async () => {
  const calls = [];
  const sync = new Miniflare(convertV4MiniflareOptions({ ...options,
    bindings: { ...options.bindings, METADATA_FEEDS: '["https://metadata.example.com/redirect","https://metadata.example.com/invalid"]' },
    outboundService: async request => {
      calls.push(request.url);
      return request.url.endsWith('/redirect')
        ? new Response(null, { status: 302, headers: { Location: 'https://other.example.com/data' } })
        : Response.json({ ...fixture, uid: '123' });
    },
  }));
  try {
    await migrate(sync);
    const response = await sync.dispatchFetch('https://worker.test/api/v1/admin/sync', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 502);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(url => url.startsWith('https://metadata.example.com/')));
    const query = await sync.dispatchFetch('https://worker.test/api/v1/items?game=hk4e&lang=zh-cn&ids=10000003');
    assert.deepEqual((await query.json()).missing_ids, ['10000003']);
  } finally { await sync.dispose(); }
});

test('authenticated sync fetches processed stores and special feeds into unified D1 API', async () => {
  const bodies = {
    '/store/gi/avatars.json': { 10000002: { NameTextMapHash: 123, QualityType: 'QUALITY_ORANGE', SideIconName: '/ui/Ayaka.png' } },
    '/store/gi/weapons.json': { 11401: { NameTextMapHash: 456, Rarity: 4, Icon: '/ui/Sword.png' } },
    '/store/gi/locs.json': { en: { 123: 'Ayaka', 456: 'Sword' } },
    '/store/hsr/avatars.json': { 1001: { AvatarName: { Hash: '6186714091647966180' }, Rarity: 4, AvatarSideIconPath: '/ui/hsr/March.png' } },
    '/store/hsr/weapons.json': { 20000: { EquipmentName: { Hash: '2' }, Rarity: 3, ImagePath: '/ui/hsr/Arrow.png' } },
    '/store/hsr/hsr.json': { en: { '6186714091647966180': 'March 7th', 2: 'Arrow' } },
    '/store/zzz/avatars.json': { 1011: { Name: 'agent', Rarity: 3, Image: '/ui/zzz/agent.png' } },
    '/store/zzz/weapons.json': { 12001: { ItemName: 'engine', Rarity: 2, ImagePath: '/ui/zzz/engine.png' } },
    '/store/zzz/locs.json': { en: { agent: 'Anby', engine: 'Engine' } },
    '/ZZZGachaInfo.nap_global.en-us.json': { retcode: 0, data: { game: 'nap', lang: 'en-us', list: [
      { id: 1011, name: 'must not overwrite Enka', rarity: 3, icon: 'https://example.com/agent.png' },
      { id: 54001, name: 'Buddy', rarity: 4, icon: 'https://example.com/buddy.png' },
    ] } },
    '/BeyondCostumeExcelConfigData.json': [{ costumeId: 260001, nameTextMapHash: '6186714091647966180' }],
    '/TextMapEN.json': { '6186714091647966180': 'Localized outfit' },
    '/GenshinBeyondGachaInfo.json': [{ Id: 260001, Name: '衣装', Rank: 2, Icon: 'https://example.com/outfit.png' }, { Id: 260002, Name: '', Rank: 2, Icon: 'https://example.com/unknown.png' }],
  };
  const calls = [];
  const sync = new Miniflare(convertV4MiniflareOptions({ ...options,
    bindings: { ...options.bindings, UPSTREAM_SYNC_ENABLED: 'true', UPSTREAM_LANGUAGES: '["en-us"]' },
    outboundService: async request => {
      assert.equal(request.headers.get('Authorization'), null);
      assert.equal(request.headers.get('Cookie'), null);
      calls.push(request.url);
      const entry = Object.entries(bodies).find(([suffix]) => new URL(request.url).pathname.endsWith(suffix));
      assert.ok(entry, 'fetch destinations must be the configured public metadata sources');
      return Response.json(entry[1]);
    },
  }));
  try {
    await migrate(sync);
    assert.equal((await sync.dispatchFetch('https://worker.test/api/v1/admin/sync', { method: 'POST' })).status, 401);
    const response = await sync.dispatchFetch('https://worker.test/api/v1/admin/sync', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { updated: 9, sources: 6 });
    assert.equal(calls.length, 13);
    assert.equal(calls.filter(url => url.includes('Dimbreath')).length, 2);
    const query = async (game, ids, lang = 'en-us') => (await sync.dispatchFetch(`https://worker.test/api/v1/items?game=${game}&lang=${lang}&ids=${ids}`)).json();
    const zzz = await query('nap', '1011,54001');
    assert.equal(zzz.data['1011'].name, 'Anby');
    assert.deepEqual(zzz.data['54001'], { name: 'Buddy', rank: 5, type: 'bangboo', icon: 'https://example.com/buddy.png' });
    assert.equal((await query('hk4e_ugc', '260001', 'zh-cn')).data['260001'].rank, 2);
    assert.equal((await query('hk4e_ugc', '260001')).data['260001'].name, 'Localized outfit');
    const before = (await query('hk4e_ugc', '260001')).items[0].updated_at;
    const repeated = await sync.dispatchFetch('https://worker.test/api/v1/admin/sync', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).updated, 0);
    assert.equal((await query('hk4e_ugc', '260001')).items[0].updated_at, before);
    bodies['/TextMapEN.json']['6186714091647966180'] = 'Corrected outfit';
    const corrected = await sync.dispatchFetch('https://worker.test/api/v1/admin/sync', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await corrected.json()).updated, 1);
    assert.equal((await query('hk4e_ugc', '260001')).data['260001'].name, 'Corrected outfit');
    bodies['/TextMapEN.json'] = {};
    const missing = await sync.dispatchFetch('https://worker.test/api/v1/admin/sync', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(missing.status, 200);
    assert.equal((await query('hk4e_ugc', '260001')).data['260001'].name, 'Corrected outfit');
    assert.deepEqual((await query('hk4e', '260001')).missing_ids, ['260001']);
    assert.deepEqual((await query('hk4e_ugc', '260002', 'zh-cn')).missing_ids, ['260002']);
  } finally { await sync.dispose(); }
});
