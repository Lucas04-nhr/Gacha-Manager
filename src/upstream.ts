import catalog from './catalog.json';

type Game = 'hk4e' | 'hkrpg' | 'nap';
type Job = { game: Game | 'hk4e_ugc'; lang: string; load: () => Promise<unknown> };
type ObjectData = Record<string, unknown>;
type Candidate = { id: string; name?: string; rank?: number; type: string; icon?: string; nameKey?: string };
const stores = { hk4e: 'gi', hkrpg: 'hsr', nap: 'zzz' } as const;
const languages: Record<string, string> = { 'en-us': 'en', 'zh-cn': 'zh-cn', 'zh-tw': 'zh-tw', 'de-de': 'de', 'es-es': 'es', 'fr-fr': 'fr', 'id-id': 'id', 'ja-jp': 'ja', 'ko-kr': 'ko', 'pt-pt': 'pt', 'ru-ru': 'ru', 'th-th': 'th', 'vi-vn': 'vi', 'tr-tr': 'tr', 'it-it': 'it' };
const textCodes: Record<string, string> = { en: 'EN', 'zh-cn': 'CHS', 'zh-tw': 'CHT', de: 'DE', es: 'ES', fr: 'FR', id: 'ID', ja: 'JP', ko: 'KR', pt: 'PT', ru: 'RU', th: 'TH', vi: 'VI', tr: 'TR', it: 'IT' };
const enka = 'https://raw.githubusercontent.com/EnkaNetwork/API-docs/master/store';
const dimbreath = { hk4e: 'https://gitlab.com/Dimbreath/animegamedata2/-/raw/main', hkrpg: 'https://gitlab.com/Dimbreath/turnbasedgamedata/-/raw/main', nap: 'https://git.mero.moe/Dimbreath/ZenlessData/raw/branch/master' };

function object(value: unknown): ObjectData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid upstream object');
  return value as ObjectData;
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
function key(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return undefined;
}
function name(loc: ObjectData, hash: string | undefined): string | undefined {
  const result = hash ? text(loc[hash]) : undefined;
  return result && result !== hash ? result.replace(/\{RUBY#[^}]*\}/g, '').replace(/<\/?unbreak>/g, '') : undefined;
}
function icon(value: unknown): string | undefined {
  const path = text(value);
  if (!path) return undefined;
  if (path.startsWith('/ui/')) return `https://enka.network${path}`;
  if (/^https:\/\//.test(path)) return path;
  return undefined;
}
function quality(value: unknown): number | undefined {
  return value === 'QUALITY_PURPLE' ? 4 : value === 'QUALITY_ORANGE' || value === 'QUALITY_ORANGE_SP' ? 5 : undefined;
}

// Preserve integer tokens beyond IEEE-754 precision, including HSR localization hashes.
export function parseUpstreamJson(input: string): unknown {
  return JSON.parse(input.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => {
    if (/^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token))) return JSON.stringify(token);
    return token;
  }));
}

async function download(url: string, limit = 1024 * 1024): Promise<unknown> {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json' } });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Upstream unavailable'); }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let input = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new Error('Upstream exceeds size limit');
      input += decoder.decode(chunk.value, { stream: true });
    }
    input += decoder.decode();
    return parseUpstreamJson(input);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function enkaItems(game: Game, avatars: unknown, weapons: unknown, localization: unknown, lang: string): Candidate[] {
  const locale = languages[lang];
  if (!locale) throw new Error('Unsupported upstream language');
  const loc = object(object(localization)[locale]);
  const rows: Candidate[] = [];
  for (const [character, entries] of [[true, object(avatars)], [false, object(weapons)]] as const) {
    if (!Object.keys(entries).length) throw new Error('Empty processed store');
    for (const [id, value] of Object.entries(entries)) {
      if (!/^\d{1,20}$/.test(id)) continue; // GI element variants are not separate public item IDs.
      const data = object(value);
      let hash: string | undefined;
      let rank: number | undefined;
      let image: unknown;
      if (game === 'hk4e') {
        hash = key(data.NameTextMapHash);
        rank = character ? quality(data.QualityType) : typeof data.Rarity === 'number' ? data.Rarity : undefined;
        image = character ? data.SideIconName : data.Icon;
        if (!character && rank !== undefined && rank < 3) continue;
      } else if (game === 'hkrpg') {
        const reference = character ? data.AvatarName : data.EquipmentName;
        hash = reference ? key(object(reference).Hash) : undefined;
        rank = typeof data.Rarity === 'number' ? data.Rarity : undefined;
        image = character ? data.AvatarSideIconPath : data.ImagePath;
      } else {
        hash = key(character ? data.Name : data.ItemName);
        rank = typeof data.Rarity === 'number' ? data.Rarity + 1 : undefined;
        image = character ? data.Image : data.ImagePath;
      }
      if (rank !== undefined && ![3, 4, 5].includes(rank)) throw new Error('Invalid upstream rank');
      rows.push({ id, nameKey: hash, name: name(loc, hash), rank, icon: icon(image), type: character ? 'character' : game === 'hk4e' ? 'weapon' : game === 'hkrpg' ? 'light_cone' : 'w_engine' });
    }
  }
  return rows;
}

async function supplement(game: Game, lang: string, rows: Candidate[]): Promise<{ rows: Candidate[]; count: number }> {
  const missing = rows.filter(row => !row.name || row.rank === undefined || !row.icon);
  if (!missing.length) return { rows, count: 0 };
  const locale = languages[lang];
  const code = locale ? textCodes[locale] : undefined;
  if (!code) throw new Error('No verified fallback locale');
  let loc: ObjectData;
  const configs = new Map<string, ObjectData>();
  if (game === 'nap') {
    const suffix = code === 'CHS' ? '' : `_${code === 'JP' ? 'JA' : code === 'KR' ? 'KO' : code}`;
    loc = object(await download(`${dimbreath.nap}/TextMap/TextMap${suffix}TemplateTb.json`, 16 * 1024 * 1024));
  } else {
    const files: Record<string, string | undefined> = game === 'hk4e' ? { character: 'ExcelBinOutput/AvatarExcelConfigData.json', weapon: 'ExcelBinOutput/WeaponExcelConfigData.json' }
      : { character: 'ExcelOutput/AvatarConfig.json', light_cone: 'ExcelOutput/EquipmentConfig.json' };
    for (const type of new Set(missing.map(row => row.type))) {
      const path = files[type];
      if (!path) throw new Error('Unknown fallback type');
      const values = await download(`${dimbreath[game]}/${path}`, 8 * 1024 * 1024);
      if (!Array.isArray(values)) throw new Error('Invalid fallback configuration');
      for (const value of values) {
        const data = object(value);
        const id = key(game === 'hk4e' ? data.id : type === 'character' ? data.AvatarID : data.EquipmentID);
        if (id) configs.set(`${type}:${id}`, data);
      }
    }
    loc = object(await download(`${dimbreath[game]}/TextMap/TextMap${code}.json`, 16 * 1024 * 1024));
  }
  let count = 0;
  const completed = rows.map(row => {
    if (!missing.includes(row)) return row;
    const data = configs.get(`${row.type}:${row.id}`);
    let hash = row.nameKey;
    let fallbackRank: number | undefined;
    let fallbackIcon: string | undefined;
    if (data && game === 'hk4e') {
      hash = key(data.nameTextMapHash) ?? hash;
      fallbackRank = row.type === 'character' ? quality(data.qualityType) : typeof data.rankLevel === 'number' ? data.rankLevel : undefined;
      const path = text(data.iconName);
      fallbackIcon = path ? `https://enka.network/ui/${path}.png` : undefined;
    } else if (data && game === 'hkrpg') {
      const ref = row.type === 'character' ? data.AvatarName : data.EquipmentName;
      hash = ref ? key(object(ref).Hash) ?? hash : hash;
      const match = text(data.Rarity)?.match(/([345])$/);
      fallbackRank = match ? Number(match[1]) : undefined;
      const path = text(row.type === 'character' ? data.AvatarSideIconPath : data.ImagePath);
      fallbackIcon = path ? `https://enka.network/ui/hsr/${path.replace(/^\/?ui\/hsr\//, '').replace(/^\//, '')}` : undefined;
    }
    const result = { ...row, name: row.name ?? name(loc, hash), rank: row.rank ?? fallbackRank, icon: row.icon ?? fallbackIcon };
    if (!result.name || result.rank === undefined || !result.icon) throw new Error('Fallback cannot complete required fields');
    count += 1;
    return result;
  });
  return { rows: completed, count };
}

export function starwardItems(input: unknown, game: 'nap' | 'hk4e_ugc', lang: string): unknown {
  let values: unknown;
  let source: string;
  if (game === 'nap') {
    const root = object(input);
    const data = object(root.data);
    if (root.retcode !== 0 || data.game !== 'nap' || data.lang !== lang) throw new Error('Unexpected Starward locale');
    values = data.list;
    source = `https://starward-static.scighost.com/metadata/v1/zzz/ZZZGachaInfo.nap_global.${lang}.json`;
  } else {
    if (lang !== 'zh-cn') throw new Error('Outfit source is Chinese only');
    values = input;
    source = 'https://starward-static.scighost.com/game-assets/genshin/GenshinBeyondGachaInfo.json';
  }
  if (!Array.isArray(values) || !values.length) throw new Error('Empty Starward metadata');
  const entries = values.flatMap(value => {
    const row = object(value);
    const id = key(game === 'nap' ? row.id : row.Id);
    if (!id || !/^\d+$/.test(id)) throw new Error('Invalid Starward ID');
    // Starward's public ZZZ list groups agents (1xxxx), engines (1xxxx/2xxxx)
    // and buddies (5xxxx). Only import the verified buddy range here.
    if (game === 'nap' && !/^5\d{4}$/.test(id)) return [];
    const rank = game === 'nap' ? row.rarity : row.Rank;
    if (typeof rank !== 'number' || !Number.isInteger(rank) || !(game === 'nap' ? [2, 3, 4] : [0, 1, 2, 3, 4, 5]).includes(rank)) throw new Error('Invalid Starward rank');
    const title = text(game === 'nap' ? row.name : row.Name);
    const image = icon(game === 'nap' ? row.icon : row.Icon);
    if (!title || !image) throw new Error('Incomplete Starward metadata');
    const type = game === 'nap' ? 'bangboo' : 'ugc_item';
    return [{ game, lang, kind: 'item', item_id: id, name: title, rank_type: String(rank), item_type: type, type, icon: image }];
  });
  if (!entries.length) throw new Error('No Starward items');
  return { source, entries };
}

export function upstreamJobs(env: { UPSTREAM_SYNC_ENABLED: string; UPSTREAM_LANGUAGES: string }): Job[] {
  if (env.UPSTREAM_SYNC_ENABLED === 'false') return [];
  if (env.UPSTREAM_SYNC_ENABLED !== 'true') throw new Error('Invalid upstream switch');
  const selected: unknown = JSON.parse(env.UPSTREAM_LANGUAGES);
  if (!Array.isArray(selected) || !selected.length || selected.length > catalog.languages.length
    || selected.some(lang => typeof lang !== 'string' || !catalog.languages.includes(lang)) || new Set(selected).size !== selected.length) throw new Error('Invalid upstream languages');
  const jobs: Job[] = (Object.keys(stores) as Game[]).flatMap(game => {
    // Cache downloads only within this synchronization, never across requests.
    let store: Promise<[unknown, unknown, unknown]> | undefined;
    return selected.map((lang: string) => ({ game, lang, load: async () => {
      const base = `${enka}/${stores[game]}`;
      store ??= (async () => [await download(`${base}/avatars.json`), await download(`${base}/weapons.json`), await download(`${base}/${game === 'hkrpg' ? 'hsr' : 'locs'}.json`)] as [unknown, unknown, unknown])();
      const [avatars, weapons, loc] = await store;
      const result = await supplement(game, lang, enkaItems(game, avatars, weapons, loc, lang));
      console.log(JSON.stringify({ event: 'metadata_fallback', game, lang, items: result.count }));
      return { source: `https://github.com/EnkaNetwork/API-docs/tree/master/store/${stores[game]}`, entries: result.rows.map(row => ({ game, lang, kind: 'item', item_id: row.id,
        name: row.name, rank_type: String(game === 'nap' ? (row.rank ?? 0) - 1 : row.rank), item_type: row.type, type: row.type, icon: row.icon })) };
    } }));
  });
  for (const lang of selected as string[]) jobs.push({ game: 'nap', lang, load: async () => starwardItems(await download(`https://starward-static.scighost.com/metadata/v1/zzz/ZZZGachaInfo.nap_global.${lang}.json`), 'nap', lang) });
  // The outfit feed is unlocalized Chinese. Never label it as English.
  jobs.push({ game: 'hk4e_ugc', lang: 'zh-cn', load: async () => starwardItems(await download('https://starward-static.scighost.com/game-assets/genshin/GenshinBeyondGachaInfo.json'), 'hk4e_ugc', 'zh-cn') });
  return jobs;
}
