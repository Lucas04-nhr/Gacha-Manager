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
      { Id: 260003, Name: '相关奖励', Rank: 0, Icon: 'https://example.com/reward.png' },
    ]);
    if (url.endsWith('BeyondCostumeExcelConfigData.json')) return new Response('[{"costumeId":260001,"nameTextMapHash":6186714091647966180},{"costumeId":260002,"nameTextMapHash":123}]');
    if (url.endsWith('TextMapEN.json')) return Response.json({ '6186714091647966180': 'Outfit', 123: 'Not in primary' });
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
      assert.equal(result.entries.length, 1);
      assert.equal(result.entries[0].entity_id, '260001');
      assert.equal(result.entries[0].lang, job.lang);
      assert.equal(result.entries[0].rank_type, '2');
      assert.equal(result.entries[0].icon, chinese.entries[0].icon);
      assert.ok(result.source.includes('Dimbreath'));
    }
    assert.equal(await jobs[3].load(), null);
    assert.equal(calls.filter(url => url.endsWith('GenshinBeyondGachaInfo.json')).length, 1);
    assert.equal(calls.filter(url => url.endsWith('BeyondCostumeExcelConfigData.json')).length, 1);
    calls.length = 0;
    globalThis.fetch = async input => { calls.push(String(input)); return new Response(null, { status: 302 }); };
    const failed = upstreamJobs({ UPSTREAM_SYNC_ENABLED: 'true', UPSTREAM_LANGUAGES: '["en-us"]' }).filter(job => job.game === 'hk4e_ugc');
    for (const job of failed) await assert.rejects(job.load());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].includes('Dimbreath'), false);
  } finally { globalThis.fetch = original; }
});
