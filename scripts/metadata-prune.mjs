import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const tables = ['genshin_meta', 'genshin_ugc_meta', 'starrail_meta', 'zenless_meta'];
const languages = ['en-us', 'zh-cn', 'zh-tw', 'ja-jp'];

// Fixed public table/locale allowlists: no personal storage or request-provided SQL.
export function pruneSql() {
  return tables.map(table => `DELETE FROM ${table} WHERE lang NOT IN (${languages.map(lang => `'${lang}'`).join(', ')});`).join('\n');
}

export function pruneMetadata({ local = false, dryRun = false } = {}) {
  console.log(`Keep only ${languages.join(', ')} in four public metadata tables (${local ? 'local' : 'remote'} D1).`);
  if (dryRun) { console.log('Dry run: no database was modified.'); return; }
  const executable = process.platform === 'darwin' ? '/opt/homebrew/bin/wrangler' : 'wrangler';
  const result = spawnSync(executable, ['d1', 'execute', 'gacha_meta', local ? '--local' : '--remote', '--command', pruneSql(), '--yes'], { stdio: 'inherit', shell: false });
  if (result.error || result.status !== 0) throw new Error('Language cleanup failed. Check Wrangler output and credentials.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--local', '--dry-run'].includes(arg)) || new Set(args).size !== args.length)
      throw new Error('Usage: npm run metadata:prune -- [--local] [--dry-run]');
    pruneMetadata({ local: args.includes('--local'), dryRun: args.includes('--dry-run') });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
