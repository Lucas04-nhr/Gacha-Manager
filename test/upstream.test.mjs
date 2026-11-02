import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { validateMetadata } from '../src/metadata.mjs';

const catalog = await readFile(new URL('../src/catalog.json', import.meta.url), 'utf8');
const source = (await readFile(new URL('../src/upstream.ts', import.meta.url), 'utf8')).replace("import catalog from './catalog.json';", `const catalog = ${catalog};`);
const compiled = stripTypeScriptTypes(source);
const { enkaItems, parseUpstreamJson, starwardItems, upstreamJobs } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const avatar = { '10000002': { NameTextMapHash: 123, QualityType: 'QUALITY_ORANGE', SideIconName: '/ui/Ayaka.png' }, '10000005-501': {} };
const weapon = { '11401': { NameTextMapHash: 456, Rarity: 4, Icon: '/ui/Sword.png' }, '11101': { Rarity: 1 } };
const loc = { en: { 123: 'Ayaka', 456: 'Sword' }, 'zh-cn': { 123: '绫华', 456: '剑' } };

test('processed stores normalize IDs, variants, localized names, ranks and icons', () => {
  const rows = enkaItems('hk4e', avatar, weapon, loc, 'en-us');
  assert.deepEqual(rows.map(row => [row.id, row.name, row.rank, row.type, row.icon]), [
    ['10000002', 'Ayaka', 5, 'character', 'https://enka.network/ui/Ayaka.png'],
    ['11401', 'Sword', 4, 'weapon', 'https://enka.network/ui/Sword.png'],
  ]);
  const zzz = enkaItems('nap', { 1011: { Name: 'agent', Rarity: 3, Image: '/ui/zzz/agent.png' } }, { 12001: { ItemName: 'engine', Rarity: 2, ImagePath: '/ui/zzz/engine.png' } }, { en: { agent: 'Anby', engine: 'Engine' } }, 'en-us');
  assert.deepEqual(zzz.map(row => [row.rank, row.type]), [[4, 'character'], [3, 'w_engine']]);
  assert.throws(() => enkaItems('hk4e', avatar, weapon, {}, 'en-us'));
});

test('64-bit localization hashes remain exact without changing string contents', () => {
  const data = parseUpstreamJson('{"Hash":6186714091647966180,"safe":123,"literal":"6186714091647966180","escaped":"a\\\"b"}');
  assert.equal(data.Hash, '6186714091647966180');
  assert.equal(data.safe, 123);
  assert.equal(data.literal, '6186714091647966180');
  const rows = enkaItems('hkrpg', { 1001: { AvatarName: { Hash: data.Hash }, Rarity: 4, AvatarSideIconPath: '/ui/hsr/avatar.png' } }, { 20000: { EquipmentName: { Hash: '2' }, Rarity: 3, ImagePath: '/ui/hsr/cone.png' } }, { en: { [data.Hash]: 'March 7th', 2: 'Arrow' } }, 'en-us');
  assert.equal(rows[0].name, 'March 7th');
});

test('Starward imports only buddies into ZZZ and keeps outfit source Chinese', () => {
  const payload = starwardItems({ retcode: 0, data: { game: 'nap', lang: 'en-us', list: [
    { id: 1011, name: 'Agent', rarity: 3, icon: 'https://example.com/a.png' },
    { id: 54001, name: 'Buddy', rarity: 4, icon: 'https://example.com/b.png' },
  ] } }, 'nap', 'en-us');
  const data = validateMetadata(payload);
  assert.equal(data.entries.length, 1);
  assert.equal(data.entries[0].item_category, 'bangboo');
  assert.equal(data.entries[0].rank_type, '4');
  const outfits = [{ Id: 260001, Name: '衣装', Rank: 2, Icon: 'https://example.com/c.png' }];
  assert.equal(validateMetadata(starwardItems(outfits, 'hk4e_ugc', 'zh-cn')).entries[0].rank_type, '2');
  assert.throws(() => starwardItems(outfits, 'hk4e_ugc', 'en-us'));
  assert.throws(() => starwardItems({ retcode: 0, data: { game: 'nap', lang: 'zh-cn', list: [] } }, 'nap', 'en-us'));
});

test('fallback is lazy, fills missing names, and preserves existing Enka fields', async () => {
  const original = globalThis.fetch;
  const calls = [];
  let missing = false;
  globalThis.fetch = async input => {
    const url = String(input); calls.push(url);
    if (url.endsWith('/gi/avatars.json')) return Response.json(avatar);
    if (url.endsWith('/gi/weapons.json')) return Response.json(weapon);
    if (url.endsWith('/gi/locs.json')) return Response.json(missing ? { en: { 123: '123', 456: 'Sword' } } : loc);
    if (url.endsWith('AvatarExcelConfigData.json')) return Response.json([{ id: 10000002, nameTextMapHash: 123, qualityType: 'QUALITY_PURPLE', iconName: 'Wrong' }]);
    if (url.endsWith('TextMapEN.json')) {
      const bytes = new TextEncoder().encode(JSON.stringify({ 123: 'Fallback 绫华', 456: 'Wrong sword', unused: 'quote\" and slash\\' }));
      let offset = 0;
      return new Response(new ReadableStream({ pull(controller) {
        if (offset === bytes.length) { controller.close(); return; }
        controller.enqueue(bytes.subarray(offset, offset + 2)); offset = Math.min(offset + 2, bytes.length);
      } }));
    }
    throw new Error('Unexpected network request');
  };
  try {
    const config = { UPSTREAM_SYNC_ENABLED: 'true', UPSTREAM_LANGUAGES: '["en-us"]' };
    let job = upstreamJobs(config).find(job => job.game === 'hk4e');
    let result = validateMetadata(await job.load());
    assert.equal(result.entries[0].name, 'Ayaka');
    assert.equal(calls.filter(url => url.includes('Dimbreath')).length, 0);
    missing = true; calls.length = 0;
    job = upstreamJobs(config).find(job => job.game === 'hk4e');
    result = validateMetadata(await job.load());
    assert.equal(result.entries[0].name, 'Fallback 绫华');
    assert.equal(result.entries[0].rank_type, '5');
    assert.equal(result.entries[0].icon, 'https://enka.network/ui/Ayaka.png');
    assert.equal(result.entries[1].name, 'Sword');
    assert.equal(calls.filter(url => url.includes('Dimbreath')).length, 1);
  } finally { globalThis.fetch = original; }
});

test('primary errors do not trigger wholesale fallback and configuration is strict', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async input => { calls.push(String(input)); return new Response('', { status: 302 }); };
  try {
    const job = upstreamJobs({ UPSTREAM_SYNC_ENABLED: 'true', UPSTREAM_LANGUAGES: '["en-us"]' })[0];
    await assert.rejects(job.load());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].includes('Dimbreath'), false);
    assert.deepEqual(upstreamJobs({ UPSTREAM_SYNC_ENABLED: 'false', UPSTREAM_LANGUAGES: 'bad' }), []);
    assert.throws(() => upstreamJobs({ UPSTREAM_SYNC_ENABLED: 'true', UPSTREAM_LANGUAGES: '["en-us","en-us"]' }));
  } finally { globalThis.fetch = original; }
});

test('UGC fallback localizes only Starward IDs and shares configuration across languages', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    assert.equal(init.redirect, 'manual');
    if (url.endsWith('GenshinBeyondGachaInfo.json')) return Response.json([
      { Id: 260001, Name: '中文衣装', Rank: 2, Icon: 'https://example.com/outfit.png' },
      { Id: 275016, Name: '测试套装形录', Rank: 4, Icon: 'https://example.com/catalog.png' },
      { Id: 260003, Name: '相关奖励', Rank: 0, Icon: 'https://example.com/reward.png' },
    ]);
    if (url.endsWith('BeyondCostumeExcelConfigData.json')) return new Response('[{"costumeId":260001,"nameTextMapHash":6186714091647966180},{"costumeId":260002,"nameTextMapHash":123}]');
    if (url.endsWith('BeyondCostumeDrawingExcelConfigData.json')) return Response.json([{ FHIDKAKGMFN: 275016, nameTextMapHash: 3481381737 }, { FHIDKAKGMFN: 275017, nameTextMapHash: 123 }]);
    if (url.endsWith('TextMapEN.json')) return Response.json({ 3481381737: 'Synthetic catalog', '6186714091647966180': 'Outfit', 123: 'Not in primary' });
    if (url.endsWith('TextMapJP.json')) return Response.json({ '6186714091647966180': '衣装' });
    if (url.endsWith('TextMapCHT.json')) return Response.json({});
    throw new Error('Unexpected request');
  };
  try {
    const jobs = upstreamJobs({ UPSTREAM_SYNC_ENABLED: 'true', UPSTREAM_LANGUAGES: '["zh-cn","en-us","ja-jp","zh-tw"]' }).filter(job => job.game === 'hk4e_ugc');
    const chinese = validateMetadata(await jobs[0].load());
    assert.equal(chinese.entries[0].name, '中文衣装');
    assert.equal(calls.length, 1);
    for (const job of jobs.slice(1, 3)) {
      const result = validateMetadata(await job.load());
      assert.equal(result.entries.length, job.lang === 'en-us' ? 2 : 1);
      if (job.lang === 'en-us') {
        assert.equal(result.entries[1].entity_id, '275016');
        assert.equal(result.entries[1].name, 'Synthetic catalog');
        assert.equal(result.entries[1].rank_type, '4');
        assert.equal(result.entries[1].icon, chinese.entries[1].icon);
      }
      assert.equal(result.entries[0].entity_id, '260001');
      assert.equal(result.entries[0].lang, job.lang);
      assert.equal(result.entries[0].rank_type, '2');
      assert.equal(result.entries[0].icon, chinese.entries[0].icon);
      assert.ok(result.source.includes('Dimbreath'));
    }
    assert.equal(await jobs[3].load(), null);
    assert.equal(calls.filter(url => url.endsWith('GenshinBeyondGachaInfo.json')).length, 1);
    assert.equal(calls.filter(url => url.endsWith('BeyondCostumeExcelConfigData.json')).length, 1);
    assert.equal(calls.filter(url => url.endsWith('BeyondCostumeDrawingExcelConfigData.json')).length, 1);
    calls.length = 0;
    globalThis.fetch = async input => { calls.push(String(input)); return new Response(null, { status: 302 }); };
    const failed = upstreamJobs({ UPSTREAM_SYNC_ENABLED: 'true', UPSTREAM_LANGUAGES: '["en-us"]' }).filter(job => job.game === 'hk4e_ugc');
    for (const job of failed) await assert.rejects(job.load(), /HTTP 302 for GenshinBeyondGachaInfo\.json/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].includes('Dimbreath'), false);
  } finally { globalThis.fetch = original; }
});

async function localizeOutfits(textMap, chunkSize) {
  const original = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith('GenshinBeyondGachaInfo.json')) return Response.json([
      { Id: 260001, Name: '衣装一', Rank: 2, Icon: 'https://example.com/1.png' },
      { Id: 260002, Name: '衣装二', Rank: 2, Icon: 'https://example.com/2.png' },
      { Id: 275016, Name: '未翻译形录', Rank: 4, Icon: 'https://example.com/3.png' },
    ]);
    if (url.endsWith('BeyondCostumeExcelConfigData.json')) return Response.json([{ costumeId: 260001, nameTextMapHash: 111 }, { costumeId: 260002, nameTextMapHash: 222 }]);
    if (url.endsWith('BeyondCostumeDrawingExcelConfigData.json')) return Response.json([{ FHIDKAKGMFN: 275016, nameTextMapHash: 333 }]);
    if (url.endsWith('TextMapEN.json')) {
      const bytes = new TextEncoder().encode(textMap);
      let offset = 0;
      return new Response(new ReadableStream({ pull(controller) {
        if (offset >= bytes.length) { controller.close(); return; }
        controller.enqueue(bytes.subarray(offset, offset + chunkSize)); offset += chunkSize;
      } }));
    }
    throw new Error('Unexpected request');
  };
  try {
    const job = upstreamJobs({ UPSTREAM_SYNC_ENABLED: 'true', UPSTREAM_LANGUAGES: '["en-us"]' })
      .find(job => job.game === 'hk4e_ugc' && job.lang === 'en-us');
    return await job.load();
  } finally { globalThis.fetch = original; }
}

test('localization streaming resolves entries across chunks and ignores key-like values', async () => {
  const textMap = JSON.stringify({
    unused: 'quote" and slash\\',
    999: '"222":"Forged inside a value"',
    long: 'x'.repeat(20000),
    111: 'Outfit "绫华" \\ one',
    222: '第二件\n衣装',
  });
  for (const chunkSize of [1, 2, 7, 4096, textMap.length * 4]) {
    const result = await localizeOutfits(textMap, chunkSize);
    assert.deepEqual(result.entries.map(row => row.name), ['Outfit "绫华" \\ one', '第二件\n衣装']);
  }
});

test('localization streaming rejects truncated maps and oversized entries', async () => {
  await assert.rejects(localizeOutfits('{"111":"Outfit","222":"Unfinished', 5), /Truncated localization map/);
  await assert.rejects(localizeOutfits('["111"]', 5), /Invalid localization map/);
  await assert.rejects(localizeOutfits(`{"long":"${'x'.repeat(2 * 1024 * 1024)}","111":"Outfit"}`, 64 * 1024), /Localization entry too large/);
});

async function localizeDrawings(drawings) {
  const original = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith('GenshinBeyondGachaInfo.json')) return Response.json([
      { Id: 275016, Name: '测试形录', Rank: 4, Icon: 'https://example.com/catalog.png' },
    ]);
    if (url.endsWith('BeyondCostumeExcelConfigData.json')) return Response.json([{ costumeId: 260001, nameTextMapHash: 123 }]);
    if (url.endsWith('BeyondCostumeDrawingExcelConfigData.json')) return new Response(drawings);
    if (url.endsWith('TextMapEN.json')) return Response.json({ 3481381737: 'Synthetic catalog' });
    throw new Error('Unexpected request');
  };
  try {
    const job = upstreamJobs({ UPSTREAM_SYNC_ENABLED: 'true', UPSTREAM_LANGUAGES: '["en-us"]' })
      .find(job => job.game === 'hk4e_ugc' && job.lang === 'en-us');
    return await job.load();
  } finally { globalThis.fetch = original; }
}

test('UGC drawing ID field is identified by shape across renamed obfuscated schemas', async () => {
  for (const field of ['FHIDKAKGMFN', 'LHDNMFFMIJH']) {
    const result = await localizeDrawings(`[
      {"descTextMapHash":1,"iconHash":3806693058812336600,"nameTextMapHash":3481381737,"${field}":275016,"LFACFJCJKOM":"250013,3","BHFEOEAIMLO":"Green","BPGKHMDIMIH":[260001]},
      {"descTextMapHash":2,"iconHash":3806693058812336601,"nameTextMapHash":123,"${field}":275017,"LFACFJCJKOM":"250013,3","BHFEOEAIMLO":"Green","BPGKHMDIMIH":[260002]}
    ]`);
    assert.deepEqual(result.entries.map(row => [row.item_id, row.name]), [['275016', 'Synthetic catalog']]);
  }
});

test('UGC drawing schema changes fail explicitly instead of silently dropping translations', async () => {
  const rejected = [
    // No ID column at all.
    [{ nameTextMapHash: 3481381737, label: 'Green' }],
    // Unique integers that match no primary item are not item IDs.
    [{ unrelated: 1, nameTextMapHash: 3481381737 }],
    // Two columns could be the ID; picking one risks assigning wrong names.
    [{ first: 275016, second: 275016, nameTextMapHash: 3481381737 }],
    // Duplicated values cannot identify rows.
    [{ repeated: 275016, nameTextMapHash: 3481381737 }, { repeated: 275016, nameTextMapHash: 123 }],
    // The ID column must be present on every row.
    [{ partial: 275016, nameTextMapHash: 3481381737 }, { nameTextMapHash: 123 }],
  ];
  for (const drawings of rejected) await assert.rejects(localizeDrawings(JSON.stringify(drawings)), /Unrecognized outfit ID field/);
});
