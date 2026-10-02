import catalog from './catalog.json' with { type: 'json' };

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

export function validateMetadata(input, maxEntries = 100000) {
  const data = object(input, 'root');
  keys(data, ['source', 'entries'], 'root');
  const source = string(data.source, 2048, 'source');
  const sourceUrl = new URL(source);
  if (sourceUrl.protocol !== 'https:' || sourceUrl.username || sourceUrl.password || sourceUrl.search || sourceUrl.hash) {
    throw new Error('source must be a public HTTPS provenance URL without credentials, query or fragment');
  }
  if (!Array.isArray(data.entries) || data.entries.length === 0 || data.entries.length > maxEntries) {
    throw new Error(`entries must contain 1–${maxEntries} public metadata rows`);
  }
  const seen = new Set();
  const entries = data.entries.map((value, index) => {
    const row = object(value, `entries[${index}]`);
    const context = `entries[${index}]`;
    if (typeof row.game !== 'string' || !Object.hasOwn(catalog.games, row.game)) throw new Error(`${context}: unsupported game`);
    if (!catalog.languages.includes(row.lang)) throw new Error(`${context}: unsupported language`);
    if (row.kind !== 'item') throw new Error(`${context}: only public item metadata is maintained; pool schedules are unsupported`);
    keys(row, ['game', 'lang', 'kind', 'item_id', 'name', 'item_type', 'rank_type', 'type', 'icon'], context);
    const id = decimal(row.item_id, `${context}.id`);
    const name = string(row.name, 256, `${context}.name`);
    const key = JSON.stringify([row.game, row.kind, row.lang, id]);
    if (seen.has(key)) throw new Error(`${context}: duplicate metadata key`);
    seen.add(key);
    let rank = null;
    let type = null;
    let category = null;
    let icon = null;
    type = string(row.item_type, 64, `${context}.item_type`);
    rank = decimal(row.rank_type, `${context}.rank_type`);
    const ranks = row.game === 'nap' ? ['2', '3', '4'] : ['3', '4', '5'];
    if (row.game !== 'hk4e_ugc' && !ranks.includes(rank)) throw new Error(`${context}: invalid raw rank_type`);
    if (row.type !== undefined) {
      const allowed = { hk4e: ['character', 'weapon'], hkrpg: ['character', 'light_cone'], nap: ['character', 'w_engine', 'bangboo'], hk4e_ugc: ['outfit', 'ugc_item'] };
      if (!allowed[row.game].includes(row.type)) throw new Error(`${context}: invalid item type`);
      category = row.type;
    }
    if (row.icon !== undefined) {
      icon = string(row.icon, 2048, `${context}.icon`);
      const url = new URL(icon);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${context}: invalid icon URL`);
    }
    return { game: row.game, kind: row.kind, entity_id: id, lang: row.lang, name, item_type: type, rank_type: rank, item_category: category, icon };
  });
  return { source, entries };
}
