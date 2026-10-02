import { readFile, writeFile } from 'node:fs/promises';
import { validateMetadata } from '../src/metadata.mjs';
import { pathToFileURL } from 'node:url';

const catalog = JSON.parse(await readFile(new URL('../src/catalog.json', import.meta.url), 'utf8'));

const sqlValue = value => value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;

export function metadataSql(input, updatedAt = new Date().toISOString()) {
  const { source, entries } = validateMetadata(input);
  const statements = entries.map(row => {
    const values = [row.game, row.kind, row.entity_id, row.lang, row.name, row.item_type, row.rank_type, row.gacha_type, source, updatedAt, row.item_category, row.icon].map(sqlValue);
    return `INSERT INTO ${catalog.games[row.game]} (namespace, kind, entity_id, lang, name, item_type, rank_type, gacha_type, source, updated_at, item_category, icon) VALUES (${values.join(', ')}) ON CONFLICT (namespace, kind, lang, entity_id) DO UPDATE SET name=excluded.name, item_type=excluded.item_type, rank_type=excluded.rank_type, gacha_type=excluded.gacha_type, source=excluded.source, updated_at=excluded.updated_at, item_category=COALESCE(excluded.item_category, ${catalog.games[row.game]}.item_category), icon=COALESCE(excluded.icon, ${catalog.games[row.game]}.icon);`;
  });
  return '-- Public metadata upserts; preserves historical pools and other languages.\n' + statements.join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [inputPath, outputPath, ...extra] = process.argv.slice(2);
    if (!inputPath || !outputPath || extra.length || inputPath === outputPath) {
      throw new Error('Usage: npm run metadata:sql -- metadata.json metadata.sql (distinct input/output paths)');
    }
    const sql = metadataSql(JSON.parse(await readFile(inputPath, 'utf8')));
    await writeFile(outputPath, sql, { flag: 'wx' });
    console.log('Validated public metadata SQL written. Apply with wrangler d1 execute; no database was modified.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
