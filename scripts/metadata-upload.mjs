import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateMetadata } from '../src/metadata.mjs';
import { metadataSql } from './metadata-sql.mjs';

export async function prepareUpload(input) {
  const directory = resolve(input);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.complete !== true || !Array.isArray(manifest.tasks) || !manifest.tasks.length
    || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt)))
    throw new Error('A complete download manifest with a valid creation time is required.');
  const batches = [];
  const seen = new Set();
  for (const task of manifest.tasks) {
    if (!['success', 'skipped'].includes(task.status) || !Array.isArray(task.files)
      || !Number.isSafeInteger(task.rows) || task.rows < 0)
      throw new Error('Manifest contains an invalid or failed task.');
    if (task.status === 'skipped') {
      if (task.files.length || task.rows) throw new Error('Skipped tasks must contain no records.');
      continue;
    }
    if (!task.files.length) throw new Error('Successful tasks must contain batches.');
    let rows = 0;
    for (const file of task.files) {
      for (const [key, extension] of [['json', 'json'], ['sql', 'sql']]) {
        if (typeof file[key] !== 'string' || !new RegExp(`^[a-zA-Z0-9_-]+\\.${extension}$`).test(file[key]) || seen.has(file[key]))
          throw new Error('Manifest contains an invalid or duplicate batch filename.');
        seen.add(file[key]);
      }
      const payload = JSON.parse(await readFile(join(directory, file.json), 'utf8'));
      validateMetadata(payload, 500);
      if (payload.entries.length !== file.rows || payload.entries.some(row => row.game !== task.game || row.lang !== task.language))
        throw new Error(`Batch does not match manifest: ${file.json}.`);
      const sql = metadataSql(payload, manifest.createdAt);
      if (Buffer.byteLength(JSON.stringify(payload)) > 900 * 1024 || Buffer.byteLength(sql) > 900 * 1024)
        throw new Error(`Batch exceeds the size limit: ${file.json}.`);
      if (await readFile(join(directory, file.sql), 'utf8') !== sql)
        throw new Error(`SQL differs from validated metadata: ${file.sql}. Regenerate the download.`);
      batches.push({ name: file.sql, sql, rows: file.rows });
      rows += file.rows;
    }
    if (rows !== task.rows) throw new Error('Task row count does not match its batches.');
  }
  if (!batches.length) throw new Error('No metadata batches to upload.');
  return batches;
}

function execute(args) {
  const executable = process.platform === 'darwin' ? '/opt/homebrew/bin/wrangler' : 'wrangler';
  const result = spawnSync(executable, args, { stdio: 'inherit', shell: false });
  if (result.error) throw new Error('Could not start Wrangler. Check installation and Cloudflare login.');
  if (result.status !== 0) throw new Error(`Wrangler stopped (${result.signal ?? result.status}).`);
}

export async function uploadMetadata({ input, local = false, dryRun = false }, run = execute) {
  // Validate every batch before the first database operation, then upload
  // immutable temporary copies of the validated SQL rather than mutable inputs.
  const batches = await prepareUpload(input);
  const rows = batches.reduce((sum, batch) => sum + batch.rows, 0);
  console.log(`Validated ${batches.length} batches / ${rows} rows for ${local ? 'local' : 'remote'} D1 gacha_meta.`);
  if (dryRun) {
    console.log('Dry run complete. No database was modified.');
    return { batches: batches.length, rows };
  }
  const temporary = await mkdtemp(join(tmpdir(), 'gacha-metadata-upload-'));
  try {
    for (const batch of batches) await writeFile(join(temporary, batch.name), batch.sql, { flag: 'wx' });
    for (const [index, batch] of batches.entries()) {
      console.log(`Uploading ${index + 1}/${batches.length}: ${batch.name} (${batch.rows} rows)…`);
      try {
        await run(['d1', 'execute', 'gacha_meta', local ? '--local' : '--remote', '--file', join(temporary, batch.name), '--yes']);
      } catch (error) {
        throw new Error(`Batch ${index + 1}/${batches.length} failed. ${error.message} Earlier batches may already be committed; rerunning these upserts is supported.`);
      }
    }
    console.log('Metadata import complete.');
    return { batches: batches.length, rows };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export function parseUploadOptions(args) {
  const options = { input: '', local: false, dryRun: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}.`);
    seen.add(flag);
    if (flag === '--local') options.local = true;
    else if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--input' && args[index + 1] && !args[index + 1].startsWith('--')) options.input = args[++index];
    else throw new Error('Usage: npm run metadata:upload -- --input <download-directory> [--local] [--dry-run]');
  }
  if (!options.input) throw new Error('--input is required. Upload targets remote D1 by default; use --local for local verification.');
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await uploadMetadata(parseUploadOptions(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
