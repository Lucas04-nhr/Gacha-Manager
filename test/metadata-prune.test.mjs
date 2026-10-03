import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { pruneSql } from '../scripts/metadata-prune.mjs';

test('language cleanup preserves four locales and all personal data across repeated runs', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok"); } };', d1Databases: { DB: 'language-cleanup-test' } }));
  try {
    const db = await mf.getD1Database('DB');
    const tables = ['genshin_meta', 'genshin_ugc_meta', 'starrail_meta', 'zenless_meta', 'personal_sync_records'];
    for (const table of tables) {
      await db.prepare(`CREATE TABLE ${table} (lang TEXT NOT NULL)`).run();
      for (const lang of ['en-us', 'zh-cn', 'zh-tw', 'ja-jp', 'de-de', 'fr-fr']) await db.prepare(`INSERT INTO ${table} VALUES (?)`).bind(lang).run();
    }
    for (let i = 0; i < 2; i++) await db.batch(pruneSql().split(';').filter(sql => sql.trim()).map(sql => db.prepare(sql)));
    for (const table of tables.slice(0, 4)) {
      const rows = await db.prepare(`SELECT lang FROM ${table} ORDER BY lang`).all();
      assert.deepEqual(rows.results.map(row => row.lang), ['en-us', 'ja-jp', 'zh-cn', 'zh-tw']);
    }
    assert.equal((await db.prepare('SELECT count(*) AS count FROM personal_sync_records').first()).count, 6);
  } finally { await mf.dispose(); }
});
