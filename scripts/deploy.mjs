import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import { isValidToken, tokenRequirement } from '../src/token.mjs';

// Only upload the exact values validated here; never reuse unreadable remote secrets.
let directory;
try {
  const args = process.argv.slice(2);
  if (args.length) throw new Error('Deployment arguments are not supported. Use npm run deploy.');
  let local = {};
  try {
    local = parseEnv(await readFile('.dev.vars', 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('Unable to read .dev.vars.');
  }
  const secrets = {};
  for (const name of ['METADATA_UPDATE_TOKEN', 'PERSONAL_SYNC_TOKEN']) {
    const value = process.env[name] ?? local[name];
    if (!isValidToken(value)) throw new Error(`${name} must contain ${tokenRequirement}; deployment refused.`);
    secrets[name] = value;
  }
  directory = await mkdtemp(join(tmpdir(), 'gacha-deploy-'));
  const file = join(directory, 'secrets.json');
  await writeFile(file, JSON.stringify(secrets), { mode: 0o600 });
  const executable = process.platform === 'darwin' ? '/opt/homebrew/bin/wrangler' : 'wrangler';
  const result = spawnSync(executable, ['deploy', '--secrets-file', file], { stdio: 'inherit' });
  if (result.error) throw new Error('Unable to start Wrangler.');
  process.exitCode = result.status ?? 1;
} catch (error) {
  // All intentional messages contain only fixed instructions and secret names.
  console.error(error instanceof Error && /^(METADATA_UPDATE_TOKEN|PERSONAL_SYNC_TOKEN|Deployment arguments|Unable to)/.test(error.message)
    ? error.message : 'Deployment failed.');
  process.exitCode = 1;
} finally {
  if (directory) await rm(directory, { recursive: true, force: true });
}
