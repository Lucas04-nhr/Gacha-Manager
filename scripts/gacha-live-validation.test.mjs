import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
test('real download artifacts import and query locally', { timeout: 60000 }, async () => {
  const folder = '/private/tmp/gacha-metadata-live-all';
  const manifest = JSON.parse(await readFile(`${folder}/manifest.json`, 'utf8'));
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-10-02', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'live-validation' }, bindings: { ALLOWED_ORIGINS: '*' } }));
  try {
    const db = await mf.getD1Database('DB');
    for (const file of ['0001_metadata.sql', '0002_item_details.sql', '0003_remove_gacha_type.sql']) {
      const sql = await readFile(`migrations/${file}`, 'utf8');
      for (const statement of sql.split(';').filter(value => value.trim())) await db.prepare(statement).run();
    }
    let rows = 0, batches = 0;
    for (const task of manifest.tasks) for (const file of task.files) {
      const lines = (await readFile(`${folder}/${file.sql}`, 'utf8')).split('\n').filter(line => line.trim() && !line.startsWith('--'));
      await db.batch(lines.map(line => db.prepare(line)));
      const payload = JSON.parse(await readFile(`${folder}/${file.json}`, 'utf8'));
      const first = payload.entries[0];
      const response = await mf.dispatchFetch(`https://worker.test/api/v1/items?game=${first.game}&lang=${first.lang}&ids=${first.item_id}`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).items[0].name, first.name);
      rows += file.rows; batches++;
    }
    let stored = 0;
    for (const table of ['genshin_meta', 'starrail_meta', 'zenless_meta', 'genshin_ugc_meta']) stored += (await db.prepare(`SELECT count(*) AS count FROM ${table}`).first()).count;
    assert.equal(stored, rows);
    console.log(JSON.stringify({ tasks: manifest.tasks.length, batches, validatedRows: rows, storedRows: stored, apiChecks: batches }));
  } finally { await mf.dispose(); }
});
