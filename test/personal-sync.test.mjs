import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const token = 'synthetic-personal-token-'.repeat(2);
const adminToken = 'synthetic-metadata-token-'.repeat(2);
let mf;
let db;
function instance(bindings = {}) {
  return new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-10-02',
    compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'personal-test' },
    bindings: { ALLOWED_ORIGINS: 'https://blog.test', PERSONAL_SYNC_TOKEN: token, METADATA_UPDATE_TOKEN: adminToken, ...bindings },
  }));
}
before(async () => {
  mf = instance();
  db = await mf.getD1Database('DB');
  for (const file of ['0001_metadata.sql', '0002_item_details.sql', '0003_remove_gacha_type.sql', '0004_personal_sync.sql']) {
    const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
    for (const statement of sql.split(';').filter(value => value.trim())) await db.prepare(statement).run();
  }
});
after(async () => { await mf?.dispose(); });

const post = (body, headers = {}, path = '/api/v1/personal/sync') => mf.dispatchFetch(`https://worker.test${path}`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const row = (id = '9007199254740993', extra = {}) => ({ id, item_id: '10001', time: '2026-10-03 12:00:00', gacha_type: '301', uigf_gacha_type: '301', rank_type: '5', ...extra });
const write = (revision, list = [row()], extra = {}) => ({ action: 'write', game: 'hk4e', uid: '123456789', timezone: 8, revision, list, ...extra });
const read = (extra = {}) => post({ action: 'read', game: 'hk4e', uid: '123456789', ...extra });
async function revision() { return (await (await post({ action: 'list' })).json()).revision; }

test('authentication is mandatory even for allowed origins; credentials are separate', async () => {
  for (const headers of [{ Authorization: '' }, { Authorization: `Bearer ${adminToken}` }, { Authorization: '', Origin: 'https://blog.test' }]) {
    const response = await post({ action: 'list' }, headers);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.equal((await post({ action: 'list' }, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await post({}, { Authorization: `Bearer ${token}` }, '/api/v1/admin/metadata')).status, 401);
});

test('browser preflight permits only POST and the documented headers', async () => {
  const response = await mf.dispatchFetch('https://worker.test/api/v1/personal/sync', { method: 'OPTIONS', headers: {
    Origin: 'https://blog.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type',
  } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://blog.test');
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
  const denied = await mf.dispatchFetch('https://worker.test/api/v1/personal/sync', { method: 'OPTIONS', headers: {
    Origin: 'https://blog.test', 'Access-Control-Request-Method': 'DELETE',
  } });
  assert.equal(denied.status, 405);
  assert.equal((await mf.dispatchFetch('https://worker.test/api/v1/personal/sync')).status, 405);
});

test('create, page, edit and delete records without losing 64-bit IDs or raw ranks', async () => {
  let rev = await revision();
  const response = await post(write(rev, [row('10'), row('2'), row()]));
  assert.equal(response.status, 200);
  const created = await response.json();
  assert.ok(created.revision > rev);
  assert.ok(Math.abs(created.revision - Date.now()) < 10000);
  rev = created.revision;
  const first = await (await read({ limit: 2 })).json();
  assert.deepEqual(first.list.map(value => value.id), ['2', '10']);
  assert.equal(first.next, '10');
  assert.equal(first.account.timezone, 8);
  const last = await (await read({ after: first.next, limit: 2 })).json();
  assert.equal(last.list[0].id, '9007199254740993');
  assert.equal(last.list[0].rank_type, '5');
  assert.equal(last.next, null);
  assert.equal((await post(write(rev, [row('10', { item_id: '10002' })], { delete_ids: ['2'], timezone: 1 }))).status, 200);
  const updated = await (await read()).json();
  assert.ok(updated.revision > rev);
  rev = updated.revision;
  assert.equal(updated.account.timezone, 1);
  assert.deepEqual(updated.list.map(value => value.id), ['10', '9007199254740993']);
  assert.equal(updated.list[0].item_id, '10002');
  const empty = await read({ uid: '777' }); // Extra value replaces default uid.
  assert.equal((await empty.json()).account, null);
});

test('stale writes, deletes and concurrent writes cannot overwrite newer data', async () => {
  const rev = await revision();
  const responses = await Promise.all([post(write(rev, [row('30')])), post(write(rev, [row('40')]))]);
  assert.deepEqual(responses.map(value => value.status).sort(), [200, 409]);
  assert.equal((await post({ action: 'delete_account', game: 'hk4e', uid: '123456789', revision: rev })).status, 409);
  const stored = await (await read()).json();
  assert.equal(stored.list.filter(value => ['30', '40'].includes(value.id)).length, 1);
});

test('namespace isolation, account pagination and deletion prevent stale resurrection', async () => {
  let rev = await revision();
  assert.equal((await post(write(rev, [row('10', { schedule_id: '20', op_gacha_type: '2000', rank_type: '1' })], { game: 'hk4e_ugc' }))).status, 200);
  rev = await revision();
  assert.equal((await post(write(rev, [row('10', { gacha_type: '1', rank_type: '2' })], { game: 'nap' }))).status, 200);
  rev = await revision();
  const page = await (await post({ action: 'list', limit: 1 })).json();
  assert.equal(page.accounts.length, 1);
  assert.equal(typeof page.next, 'string');
  const next = await (await post({ action: 'list', limit: 1, after: page.next })).json();
  assert.equal(next.accounts[0].game, 'hk4e_ugc');
  assert.equal((await post({ action: 'delete_account', game: 'hk4e', uid: '123456789', revision: rev })).status, 200);
  const deleted = await (await read()).json();
  assert.equal(deleted.account, null);
  assert.deepEqual(deleted.list, []);
  assert.ok(deleted.revision > rev);
  assert.equal((await post(write(rev))).status, 409);
  const ugc = await (await read({ game: 'hk4e_ugc' })).json();
  assert.equal(ugc.list[0].rank_type, '1');
  const zzz = await (await read({ game: 'nap' })).json();
  assert.equal(zzz.list[0].rank_type, '2');
});

test('full validation rejects sensitive fields, malformed rows, ambiguous IDs and excessive operations', async () => {
  const rev = await revision();
  for (const value of [
    write(rev, [row('1', { authkey: 'synthetic' })]), write(rev, [row('1', { name: 'localized' })]),
    write(rev, [row('1'), row('01')]), write(rev, [row('1')], { delete_ids: ['01'] }),
    write(rev, [row('1', { time: '2026-02-30 12:00:00' })]), write(rev, [row('1', { rank_type: '2' })]),
    write(rev, [row()], { timezone: 100 }), write(rev, [row()], { uid: 123 }),
    write(rev, Array.from({ length: 2001 }, (_, index) => row(String(index)))),
    { action: 'list', cookie: 'synthetic' }, { action: 'read', game: 'nap', uid: '123', limit: 501 },
  ]) assert.equal((await post(value)).status, 400);
  assert.equal(await revision(), rev);
  assert.equal((await post({ action: 'list' }, {}, '/api/v1/personal/sync?token=synthetic')).status, 400);
  assert.equal((await post({ action: 'list' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post({ action: 'list' }, { 'Content-Encoding': 'gzip' })).status, 415);
  assert.equal((await post({ action: 'list', padding: 'x'.repeat(1024 * 1024) })).status, 413);
});

test('D1 write failures roll back the revision and all account/record changes', async () => {
  const rev = await revision();
  await db.prepare("CREATE TRIGGER synthetic_failure BEFORE INSERT ON personal_sync_records WHEN NEW.uid = '999' BEGIN SELECT RAISE(ABORT, 'synthetic'); END").run();
  try {
    const response = await post(write(rev, [row('1')], { uid: '999' }));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'DATABASE_UNAVAILABLE');
    assert.equal(await revision(), rev);
    assert.equal((await (await read({ uid: '999' })).json()).account, null);
  } finally { await db.prepare('DROP TRIGGER synthetic_failure').run(); }
});

test('missing secret disables sync; wildcard origins never grant browser sync access', async () => {
  for (const bindings of [{ PERSONAL_SYNC_TOKEN: '' }, { ALLOWED_ORIGINS: '*' }]) {
    const local = instance(bindings);
    try {
      const response = await local.dispatchFetch('https://worker.test/api/v1/personal/sync', { method: 'POST', headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(bindings.ALLOWED_ORIGINS ? { Origin: 'https://arbitrary.test' } : {}),
      }, body: '{"action":"list"}' });
      assert.equal(response.status, bindings.ALLOWED_ORIGINS ? 403 : 503);
    } finally { await local.dispose(); }
  }
});

test('large writes stay below SQL parameter limits and public queries cannot expose personal rows', async () => {
  const rows = Array.from({ length: 2000 }, (_, index) => row(String(index + 1), { gacha_type: '11', gacha_id: '1001' }));
  const response = await post(write(await revision(), rows, { game: 'hkrpg', uid: '555' }));
  assert.equal(response.status, 200);
  const stored = await (await read({ game: 'hkrpg', uid: '555', limit: 500 })).json();
  assert.equal(stored.list.length, 500);
  assert.equal(stored.next, '500');
  const publicResponse = await mf.dispatchFetch('https://worker.test/api/v1/items?game=hkrpg&ids=10001');
  assert.equal(publicResponse.status, 200);
  assert.deepEqual((await publicResponse.json()).items, []);
});

test('timestamp revision remains increasing if the clock is behind the previous write', async () => {
  const future = Date.now() + 60000;
  await db.prepare('UPDATE personal_sync_state SET revision = ? WHERE singleton = 1').bind(future).run();
  const response = await post(write(future, [], { uid: '888' }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revision, future + 1);
  assert.equal((await post(write(future, [], { uid: '888' }))).status, 409);
});

test('authenticated first sync creates missing personal tables; unauthenticated calls create nothing', async () => {
  const fresh = instance();
  try {
    const database = await fresh.getD1Database('DB');
    const call = authorization => fresh.dispatchFetch('https://worker.test/api/v1/personal/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization }, body: JSON.stringify({ action: 'list' }),
    });
    assert.equal((await call('')).status, 401);
    assert.equal((await database.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name LIKE 'personal_sync_%'").first()).count, 0);
    const responses = await Promise.all([call(`Bearer ${token}`), call(`Bearer ${token}`)]);
    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { revision: 0, accounts: [], next: null });
    }
    assert.equal((await database.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name IN ('personal_sync_state', 'personal_sync_accounts', 'personal_sync_records')").first()).count, 3);
  } finally { await fresh.dispose(); }
});

test('repairing a missing records table preserves the existing revision and accounts', async () => {
  const fresh = instance();
  try {
    const database = await fresh.getD1Database('DB');
    const call = body => fresh.dispatchFetch('https://worker.test/api/v1/personal/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    });
    assert.equal((await call({ action: 'list' })).status, 200);
    const written = await call(write(0));
    assert.equal(written.status, 200);
    const revision = (await written.json()).revision;
    await database.prepare('DROP TABLE personal_sync_records').run();
    const list = await call({ action: 'list' });
    assert.equal(list.status, 200);
    const result = await list.json();
    assert.equal(result.revision, revision);
    assert.equal(result.accounts.length, 1);
    assert.equal((await call({ action: 'read', game: 'hk4e', uid: '123456789' })).status, 200);
    const reread = await call({ action: 'list' });
    assert.equal((await reread.json()).revision, revision);
  } finally { await fresh.dispose(); }
});
