import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateMetadata } from '../src/metadata.mjs';
import { metadataSql } from './metadata-sql.mjs';

const catalog = JSON.parse(await readFile(new URL('../src/catalog.json', import.meta.url), 'utf8'));

// Run the same source adapters as the Worker, with Node's memory/CPU budget.
async function loadJobs(languages) {
  const source = (await readFile(new URL('../src/upstream.ts', import.meta.url), 'utf8'))
    .replace("import catalog from './catalog.json';", `const catalog = ${JSON.stringify(catalog)};`);
  const compiled = stripTypeScriptTypes(source);
  const { upstreamJobs } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
  return upstreamJobs({ UPSTREAM_SYNC_ENABLED: 'true', UPSTREAM_LANGUAGES: JSON.stringify(languages) });
}

export function splitPayload(payload) {
  validateMetadata(payload);
  const batches = [];
  let entries = [];
  for (const row of payload.entries) {
    const candidate = { source: payload.source, entries: [...entries, row] };
    if (entries.length && (candidate.entries.length > 500 || Buffer.byteLength(JSON.stringify(candidate)) > 900 * 1024
      || Buffer.byteLength(metadataSql(candidate)) > 900 * 1024)) {
      batches.push({ source: payload.source, entries });
      entries = [];
    }
    entries.push(row);
  }
  if (entries.length) batches.push({ source: payload.source, entries });
  for (const batch of batches) {
    if (Buffer.byteLength(JSON.stringify(batch)) > 900 * 1024 || Buffer.byteLength(metadataSql(batch)) > 900 * 1024)
      throw new Error('A metadata row exceeds the batch size limit.');
  }
  return batches;
}

// Only adapter errors carry reviewed text. Other exceptions may embed raw URLs or
// payloads, so report just their class and transport error code.
function failureDetail(error) {
  if (error?.name === 'UpstreamError') return error.message;
  const name = error instanceof Error ? error.name : 'UnknownError';
  const code = error?.cause?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? `${name} (${code})` : name;
}

export async function downloadMetadata({ output, languages = catalog.languages, games = Object.keys(catalog.games), jobs }) {
  // Require a fresh directory: reruns cannot accidentally mix stale SQL files.
  await mkdir(output, { recursive: false });
  const manifest = { complete: false, createdAt: new Date().toISOString(), languages, games, tasks: [] };
  try {
    jobs ??= await loadJobs(languages);
    for (const [index, job] of jobs.entries()) {
      if (!games.includes(job.game)) continue;
      const task = { game: job.game, language: job.lang, status: 'failed', rows: 0, files: [] };
      manifest.tasks.push(task);
      console.log(`Downloading ${job.game} / ${job.lang} (source ${index + 1})…`);
      let stage = 'download';
      try {
        const payload = await job.load();
        if (payload === null) {
          task.status = 'skipped';
          task.reason = 'No resolved translations; existing database rows must be preserved.';
          continue;
        }
        stage = 'validation';
        const batches = splitPayload(payload);
        task.source = payload.source;
        stage = 'output';
        for (const [batchIndex, batch] of batches.entries()) {
          const stem = `${String(index + 1).padStart(2, '0')}-${job.game}-${job.lang}-${String(batchIndex + 1).padStart(3, '0')}`;
          const jsonFile = `${stem}.json`;
          const sqlFile = `${stem}.sql`;
          await writeFile(resolve(output, jsonFile), JSON.stringify(batch, null, 2) + '\n', { flag: 'wx' });
          await writeFile(resolve(output, sqlFile), metadataSql(batch, manifest.createdAt), { flag: 'wx' });
          task.files.push({ json: jsonFile, sql: sqlFile, rows: batch.entries.length });
        }
        task.rows = payload.entries.length;
        task.status = 'success';
        console.log(`Validated ${task.rows} rows in ${batches.length} batches.`);
      } catch (error) {
        task.reason = 'Source download, parsing, validation or output failed; no database was modified.';
        task.stage = stage;
        task.detail = failureDetail(error);
        console.error(`Failed: ${job.game} / ${job.lang} (source ${index + 1}) during ${stage}: ${task.detail}.`);
      }
    }
    manifest.complete = manifest.tasks.length > 0 && manifest.tasks.every(task => task.status !== 'failed');
  } finally {
    await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  }
  return manifest;
}

function annotation(level, title, message) {
  const escaped = message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  console.log(`::${level} title=${title}::${escaped}`);
}

// Report task outcomes and return the exit code. A partial run passes only when
// explicitly allowed and at least one source produced rows to upload.
export async function reportDownload(manifest, { allowPartial = false, env = process.env } = {}) {
  const failed = manifest.tasks.filter(task => task.status === 'failed');
  const usable = manifest.tasks.some(task => task.status === 'success');
  const exitCode = manifest.complete || (allowPartial && usable) ? 0 : 1;
  if (env.GITHUB_ACTIONS === 'true') {
    for (const task of failed)
      annotation(exitCode ? 'error' : 'warning', 'Metadata source failed', `${task.game} / ${task.language} during ${task.stage}: ${task.detail}`);
  }
  if (env.GITHUB_STEP_SUMMARY) {
    const rows = manifest.tasks.map(task => `| ${task.game} | ${task.language} | ${task.status} | ${task.rows} | ${task.detail ?? task.reason ?? ''} |`);
    const summary = ['## Public metadata download', '', `${failed.length} of ${manifest.tasks.length} sources failed.`, '',
      '| Game | Language | Status | Rows | Detail |', '| --- | --- | --- | --- | --- |', ...rows, ''].join('\n');
    // The manifest and logs still hold these results if the summary cannot be written.
    await appendFile(env.GITHUB_STEP_SUMMARY, summary).catch(() => console.error('Could not write the step summary.'));
  }
  if (!manifest.complete) {
    if (exitCode) console.error('Download incomplete. Inspect failed/skipped tasks before importing; rerun into a new directory.');
    else console.warn(`Download partial: ${failed.length} of ${manifest.tasks.length} sources failed. Existing database rows for those sources are preserved.`);
  }
  return exitCode;
}

export function parseOptions(args) {
  const options = { output: '', languages: catalog.languages, games: Object.keys(catalog.games), allowPartial: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const usage = 'Usage: npm run metadata:download -- --output <new-directory> [--games hk4e,hkrpg,nap,hk4e_ugc] [--languages en-us,zh-cn,zh-tw,ja-jp] [--allow-partial]';
    if (seen.has(flag)) throw new Error(usage);
    seen.add(flag);
    if (flag === '--allow-partial') {
      options.allowPartial = true;
      continue;
    }
    const value = args[++index];
    if (!['--output', '--languages', '--games'].includes(flag) || !value || value.startsWith('--'))
      throw new Error(usage);
    if (flag === '--output') options.output = resolve(value);
    else {
      const key = flag.slice(2);
      const values = value.split(',');
      const allowed = key === 'games' ? Object.keys(catalog.games) : catalog.languages;
      if (values.some(entry => !allowed.includes(entry)) || new Set(values).size !== values.length)
        throw new Error(`Invalid ${flag}.`);
      options[key] = values;
    }
  }
  if (!options.output) throw new Error('--output must name a new directory with an existing parent.');
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const manifest = await downloadMetadata(options);
    console.log(`Manifest: ${resolve(options.output, 'manifest.json')}. No database was modified.`);
    process.exitCode = await reportDownload(manifest, { allowPartial: options.allowPartial });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
