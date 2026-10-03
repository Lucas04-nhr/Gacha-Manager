import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadMetadata } from '../scripts/metadata-download.mjs';
import { uploadMetadata, parseUploadOptions } from '../scripts/metadata-upload.mjs';

async function fixture(run) {
  const parent = await mkdtemp(join(tmpdir(), 'gacha-upload-test-'));
  const input = join(parent, 'download');
  const payload = index => ({ source: 'https://example.com/public', entries: [{ game: 'hk4e', lang: 'zh-cn', kind: 'item', item_id: String(index + 1), name: '测试', item_type: 'weapon', type: 'weapon', rank_type: '5' }] });
  try {
    const manifest = await downloadMetadata({ output: input, jobs: [0, 1, 2].map(index => ({ game: 'hk4e', lang: 'zh-cn', load: async () => payload(index) })) });
    await run(input, manifest);
  } finally { await rm(parent, { recursive: true, force: true }); }
}

test('CLI requires input and distinguishes remote default, local and dry run', () => {
  assert.throws(() => parseUploadOptions([]));
  assert.throws(() => parseUploadOptions(['--input', 'out', '--yes']));
  assert.throws(() => parseUploadOptions(['--input', 'out', '--local', '--local']));
  assert.deepEqual(parseUploadOptions(['--input', 'out']), { input: 'out', local: false, dryRun: false });
  assert.deepEqual(parseUploadOptions(['--input', 'out', '--local', '--dry-run']), { input: 'out', local: true, dryRun: true });
});

test('uploads sequential immutable snapshots with automatic confirmation and cleans them up', async () => {
  await fixture(async (input, manifest) => {
    const calls = [];
    const result = await uploadMetadata({ input }, async args => {
      calls.push(args);
      assert.deepEqual(args.slice(0, 4), ['d1', 'execute', 'gacha_meta', '--remote']);
      assert.equal(args.at(-1), '--yes');
      assert.notEqual(args[5], join(input, manifest.tasks[calls.length - 1].files[0].sql));
      assert.match(await readFile(args[5], 'utf8'), /INSERT INTO genshin_meta/);
      // Later input mutations must not change already validated snapshots.
      if (calls.length === 1) await writeFile(join(input, manifest.tasks[1].files[0].sql), 'DROP TABLE genshin_meta;');
    });
    assert.deepEqual(result, { batches: 3, rows: 3 });
    for (const args of calls) await assert.rejects(access(args[5]));
  });
});

test('preflight rejects later corrupted SQL, incomplete manifests and unsafe filenames before any writes', async () => {
  await fixture(async (input, manifest) => {
    let calls = 0;
    const execute = () => { calls++; };
    const sqlPath = join(input, manifest.tasks[2].files[0].sql);
    const original = await readFile(sqlPath, 'utf8');
    await writeFile(sqlPath, 'DROP TABLE personal_sync_records;');
    await assert.rejects(uploadMetadata({ input }, execute), /SQL differs/);
    await writeFile(sqlPath, original);
    manifest.complete = false;
    await writeFile(join(input, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(uploadMetadata({ input }, execute), /complete download/);
    manifest.complete = true;
    manifest.tasks[0].files[0].sql = '../outside.sql';
    await writeFile(join(input, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(uploadMetadata({ input }, execute), /filename/);
    assert.equal(calls, 0);
  });
});

test('dry run does not spawn Wrangler; failures stop later batches and clean snapshots', async () => {
  await fixture(async input => {
    let calls = 0, failedFile;
    await uploadMetadata({ input, dryRun: true }, () => { calls++; });
    assert.equal(calls, 0);
    await assert.rejects(uploadMetadata({ input, local: true }, args => {
      assert.equal(args[3], '--local');
      if (++calls === 2) { failedFile = args[5]; throw new Error('test failure'); }
    }), /Batch 2\/3 failed/);
    assert.equal(calls, 2);
    await assert.rejects(access(failedFile));
  });
});
