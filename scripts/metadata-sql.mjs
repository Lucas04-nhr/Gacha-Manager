import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const catalog = JSON.parse(await readFile(new URL('../src/catalog.json', import.meta.url), 'utf8'));

function object(value, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context}: expected object`);
  return value;
}

function keys(value, allowed, context) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${context}: unexpected field ${key}; public metadata only`);
  }
}

function string(value, max, context) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value)) {
    throw new Error(`${context}: expected nonempty string of at most ${max} characters`);
  }
  return value;
}

function decimal(value, context) {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) throw new Error(`${context}: expected decimal string ID`);
  return value;
}

const sqlValue = value => value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;

// Offline operator tool: validates the entire file before emitting SQL. No network or DB writes.
export function metadataSql(input, updatedAt = new Date().toISOString()) {
  const data = object(input, 'root');
  keys(data, ['source', 'entries'], 'root');
  const source = string(data.source, 2048, 'source');
  const sourceUrl = new URL(source);
  if (sourceUrl.protocol !== 'https:' || sourceUrl.username || sourceUrl.password || sourceUrl.search || sourceUrl.hash) {
    throw new Error('source must be a public HTTPS provenance URL without credentials, query or fragment');
  }
  if (!Array.isArray(data.entries) || data.entries.length === 0 || data.entries.length > 100000) {
    throw new Error('entries must contain 1–100000 public metadata rows');
  }
  const seen = new Set();
  const statements = data.entries.map((value, index) => {
    const row = object(value, `entries[${index}]`);
    const context = `entries[${index}]`;
    if (!Object.hasOwn(catalog.games, row.game)) throw new Error(`${context}: unsupported game`);
    if (!catalog.languages.includes(row.lang)) throw new Error(`${context}: unsupported language`);
    if (!['item', 'pool'].includes(row.kind)) throw new Error(`${context}: kind must be item or pool`);
    keys(row, row.kind === 'item'
      ? ['game', 'lang', 'kind', 'item_id', 'name', 'item_type', 'rank_type']
      : ['game', 'lang', 'kind', 'pool_id', 'name', 'gacha_type'], context);
    const id = decimal(row.kind === 'item' ? row.item_id : row.pool_id, `${context}.id`);
    const name = string(row.name, 256, `${context}.name`);
    const key = JSON.stringify([row.game, row.kind, row.lang, id]);
    if (seen.has(key)) throw new Error(`${context}: duplicate metadata key`);
    seen.add(key);
    let rank = null;
    let type = null;
    let gacha = null;
    if (row.kind === 'item') {
      type = string(row.item_type, 64, `${context}.item_type`);
      rank = decimal(row.rank_type, `${context}.rank_type`);
      const ranks = row.game === 'nap' ? ['2', '3', '4'] : ['3', '4', '5'];
      if (row.game !== 'hk4e_ugc' && !ranks.includes(rank)) throw new Error(`${context}: invalid raw rank_type`);
    } else {
      gacha = decimal(row.gacha_type, `${context}.gacha_type`);
    }
    const values = [row.game, row.kind, id, row.lang, name, type, rank, gacha, source, updatedAt].map(sqlValue);
    return `INSERT INTO ${catalog.games[row.game]} (namespace, kind, entity_id, lang, name, item_type, rank_type, gacha_type, source, updated_at) VALUES (${values.join(', ')}) ON CONFLICT (namespace, kind, lang, entity_id) DO UPDATE SET name=excluded.name, item_type=excluded.item_type, rank_type=excluded.rank_type, gacha_type=excluded.gacha_type, source=excluded.source, updated_at=excluded.updated_at;`;
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
