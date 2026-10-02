import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions, CorePaths } from 'miniflare';

const fixture = JSON.parse(await readFile(new URL('./fixtures/metadata.json', import.meta.url), 'utf8'));
const schema = await readFile(new URL('../migrations/0001_metadata.sql', import.meta.url), 'utf8');
const token = 'test-only-metadata-secret-not-for-production';
const options = { unsafeTriggerHandlers: true, modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-10-02', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'update-tests' }, bindings: { ALLOWED_ORIGINS: '*', METADATA_UPDATE_TOKEN: token, METADATA_FEEDS: '[]' } };
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

test('admin updates all four tables atomically and remains inaccessible to blog browsers', async () => {
  const response = await post(fixture);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).updated, fixture.entries.length);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await item('hk4e', '10000003')).items[0].name, '琴');
  assert.equal((await item('hk4e_ugc', '10000003')).items[0].name, '测试衣装');
  assert.equal((await item('nap', '1001')).items[0].rarity, 5);
  assert.equal((await item('hkrpg', '1001')).items[0].name, '三月七');
  assert.equal((await post(fixture, { headers: { Origin: 'https://blog.test' } })).status, 403);
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'DELETE']) {
    const blocked = await mf.dispatchFetch('https://worker.test/api/v1/admin/metadata', { method });
    assert.equal(blocked.status, 405);
    assert.equal(blocked.headers.get('Allow'), 'POST');
    assert.equal(blocked.headers.get('Access-Control-Allow-Origin'), null);
  }
});

test('authentication fails closed without token or with malformed/wrong authorization', async () => {
  for (const authorization of ['', 'Bearer wrong', `Basic ${token}`, `Bearer ${token} extra`]) {
    const response = await post(fixture, { headers: { Authorization: authorization } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('WWW-Authenticate'), 'Bearer');
  }
  const disabled = new Miniflare(convertV4MiniflareOptions({ ...options, bindings: { ALLOWED_ORIGINS: '*', METADATA_FEEDS: '[]' } }));
  try {
    const response = await disabled.dispatchFetch('https://worker.test/api/v1/admin/metadata', { method: 'POST' });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'UPDATES_DISABLED');
    assert.equal((await disabled.dispatchFetch('https://worker.test/api/v1/games')).status, 200);
  } finally { await disabled.dispose(); }
});

test('validate full payload before writes and reject user fields, wrong types and invalid JSON', async () => {
  const bad = { ...fixture, entries: [{ ...fixture.entries[0], name: 'must not change' }, { ...fixture.entries[4], uid: '123' }] };
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
    const payload = { ...fixture, entries: [{ ...fixture.entries[0], name: 'must roll back' }, { ...fixture.entries[4], name: 'rejected' }] };
    assert.equal((await post(payload)).status, 503);
    assert.equal((await item('hk4e', '10000003')).items[0].name, '琴');
    assert.equal((await item('hkrpg', '1001')).items[0].name, '三月七');
  } finally { await db.prepare('DROP TRIGGER reject_test_update').run(); }
});

test('upserts preserve historical pools and unrelated language entries', async () => {
  const updated = { ...fixture, entries: [{ ...fixture.entries[0], name: "Jean's updated name" }] };
  assert.equal((await post(updated)).status, 200);
  assert.equal((await item('hk4e', '10000003')).items[0].name, "Jean's updated name");
  const english = await mf.dispatchFetch('https://worker.test/api/v1/items?game=hk4e&ids=10000003');
  assert.equal((await english.json()).items[0].name, 'Jean');
  const pool = await mf.dispatchFetch('https://worker.test/api/v1/pools?game=hkrpg&lang=zh-cn&ids=2003');
  assert.equal((await pool.json()).pools.length, 1);
});

test('JSON expansion supports updates beyond D1 SQL parameter limits', async () => {
  const entries = Array.from({ length: 200 }, (_, i) => ({ ...fixture.entries[0], item_id: String(90000000 + i) }));
  const response = await post({ ...fixture, entries });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).updated, 200);
  assert.equal((await item('hk4e', '90000199')).items.length, 1);
});

test('scheduled handler fetches configured normalized feeds with no authorization forwarding', async () => {
  const calls = [];
  const cron = new Miniflare(convertV4MiniflareOptions({ ...options,
    bindings: { ...options.bindings, METADATA_FEEDS: '["https://metadata.example.com/feed.json"]' },
    outboundService: async request => {
      calls.push(request.url);
      assert.equal(request.headers.get('Authorization'), null);
      return Response.json(fixture);
    },
  }));
  try {
    await migrate(cron);
    const response = await cron.dispatchFetch(`https://worker.test${CorePaths.SCHEDULED}?cron=0+3+*+*+*`);
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ['https://metadata.example.com/feed.json']);
    const query = await cron.dispatchFetch('https://worker.test/api/v1/items?game=hk4e_ugc&lang=zh-cn&ids=10000003');
    assert.equal((await query.json()).items[0].name, '测试衣装');
  } finally { await cron.dispose(); }
});

test('cron continues after a failed feed, keeps existing metadata, and signals failure', async () => {
  const calls = [];
  const cron = new Miniflare(convertV4MiniflareOptions({ ...options,
    bindings: { ...options.bindings, METADATA_FEEDS: '["https://metadata.example.com/bad.json","https://metadata.example.com/good.json"]' },
    outboundService: async request => {
      calls.push(request.url);
      return request.url.endsWith('/bad.json') ? new Response('upstream failed', { status: 500 }) : Response.json(fixture);
    },
  }));
  try {
    await migrate(cron);
    const response = await cron.dispatchFetch(`https://worker.test${CorePaths.SCHEDULED}?cron=0+3+*+*+*`);
    assert.equal(response.status, 500);
    assert.equal(calls.length, 2);
    const query = await cron.dispatchFetch('https://worker.test/api/v1/items?game=hk4e&lang=zh-cn&ids=10000003');
    assert.equal((await query.json()).items[0].name, '琴');
  } finally { await cron.dispose(); }
});

test('empty cron feed configuration is a no-op', async () => {
  const response = await mf.dispatchFetch(`https://worker.test${CorePaths.SCHEDULED}`);
  assert.equal(response.status, 200);
  assert.equal((await item('hk4e', '10000003')).items[0].name, "Jean's updated name");
});

test('cron rejects redirects and invalid metadata without following or writing', async () => {
  const calls = [];
  const cron = new Miniflare(convertV4MiniflareOptions({ ...options,
    bindings: { ...options.bindings, METADATA_FEEDS: '["https://metadata.example.com/redirect","https://metadata.example.com/invalid"]' },
    outboundService: async request => {
      calls.push(request.url);
      return request.url.endsWith('/redirect')
        ? new Response(null, { status: 302, headers: { Location: 'https://other.example.com/data' } })
        : Response.json({ ...fixture, uid: '123' });
    },
  }));
  try {
    await migrate(cron);
    const response = await cron.dispatchFetch(`https://worker.test${CorePaths.SCHEDULED}`);
    assert.equal(response.status, 500);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(url => url.startsWith('https://metadata.example.com/')));
    const query = await cron.dispatchFetch('https://worker.test/api/v1/items?game=hk4e&lang=zh-cn&ids=10000003');
    assert.deepEqual((await query.json()).missing_ids, ['10000003']);
  } finally { await cron.dispose(); }
});
