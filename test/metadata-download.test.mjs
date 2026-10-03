import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { downloadMetadata, parseOptions, splitPayload } from '../scripts/metadata-download.mjs';
const payload = { source: 'https://example.com/public', entries: [{ game: 'hk4e', lang: 'zh-cn', kind: 'item', item_id: '9007199254740993', name: "测试'物品", rank_type: '5', item_type: 'weapon', type: 'weapon' }] };

test('options reject unknown games, languages and duplicate flags', () => {
  assert.throws(() => parseOptions(['--output', 'out', '--games', 'bad']));
  assert.throws(() => parseOptions(['--output', 'out', '--languages', 'bad']));
  assert.throws(() => parseOptions(['--output', 'out', '--output', 'other']));
  assert.deepEqual(parseOptions(['--output', 'out', '--games', 'hk4e', '--languages', 'zh-cn']).games, ['hk4e']);
});

test('splitting preserves all IDs and enforces row and byte budgets', () => {
  const input = { ...payload, entries: Array.from({ length: 1200 }, (_, i) => ({ ...payload.entries[0], item_id: String(BigInt(payload.entries[0].item_id) + BigInt(i)) })) };
  const batches = splitPayload(input);
  assert.deepEqual(batches.map(batch => batch.entries.length), [500, 500, 200]);
  assert.deepEqual(batches.flatMap(batch => batch.entries), input.entries);
  assert.throws(() => splitPayload({ ...payload, entries: [payload.entries[0], payload.entries[0]] }));
  const large = { ...input, source: 'https://example.com/' + 's'.repeat(1900), entries: input.entries.map(row => ({ ...row, icon: 'https://example.com/' + 'i'.repeat(1900) })) };
  const bounded = splitPayload(large);
  assert.ok(bounded.some(batch => batch.entries.length < 500));
  assert.equal(bounded.flatMap(batch => batch.entries).length, 1200);
  for (const batch of bounded) assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 900 * 1024);
});

test('validated artifacts import into local D1 and reruns preserve existing items', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'gacha-download-test-'));
  const output = join(parent, 'output');
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok") } };', d1Databases: { DB: 'download-test' } }));
  try {
    const result = await downloadMetadata({ output, jobs: [{ game: 'hk4e', lang: 'zh-cn', load: async () => payload }] });
    assert.equal(result.complete, true);
    const file = result.tasks[0].files[0];
    assert.deepEqual(JSON.parse(await readFile(join(output, file.json), 'utf8')), payload);
    const db = await mf.getD1Database('DB');
    for (const migration of ['0001_metadata.sql', '0002_item_details.sql', '0003_remove_gacha_type.sql']) {
      const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8');
      for (const statement of sql.split(';').filter(value => value.trim())) await db.prepare(statement).run();
    }
    const sql = (await readFile(join(output, file.sql), 'utf8')).split('\n').filter(line => !line.startsWith('--')).join('\n');
    for (let i = 0; i < 2; i++) await db.exec(sql);
    const rows = await db.prepare('SELECT entity_id, name, lang FROM genshin_meta').all();
    assert.deepEqual(rows.results, [{ entity_id: '9007199254740993', name: "测试'物品", lang: 'zh-cn' }]);
    await assert.rejects(downloadMetadata({ output, jobs: [] }));
  } finally { await mf.dispose(); await rm(parent, { recursive: true, force: true }); }
});

test('failed source keeps nonzero completion while remaining sources are attempted', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'gacha-download-failure-'));
  try {
    const result = await downloadMetadata({ output: join(parent, 'out'), jobs: [
      { game: 'hk4e', lang: 'zh-cn', load: async () => { throw new Error('private transport details'); } },
      { game: 'hk4e', lang: 'en-us', load: async () => null },
      { game: 'hk4e', lang: 'zh-cn', load: async () => payload },
    ] });
    assert.equal(result.complete, false);
    assert.deepEqual(result.tasks.map(task => task.status), ['failed', 'skipped', 'success']);
    assert.equal(JSON.stringify(result).includes('private transport details'), false);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
