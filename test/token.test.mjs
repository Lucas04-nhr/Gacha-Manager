import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isValidToken } from '../src/token.mjs';

const valid = 'Aa1!' + 'x'.repeat(28);
test('token policy accepts inclusive boundaries and rejects each missing character class', () => {
  for (const length of [32, 64]) assert.equal(isValidToken('Aa1!' + 'x'.repeat(length - 4)), true);
  for (const value of [undefined, null, 123, '', valid.slice(1), valid + 'x'.repeat(33),
    'aa1!' + 'x'.repeat(28), 'AA1!' + 'X'.repeat(28), 'Aaa!' + 'x'.repeat(28),
    'Aa12' + 'x'.repeat(28), valid.slice(0, -1) + ' ', valid.slice(0, -1) + '\n',
    valid.slice(0, -1) + 'é']) assert.equal(isValidToken(value), false);
});
test('deployment rejects either invalid token without echoing its value or invoking Wrangler', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gacha-token-test-'));
  try {
    for (const name of ['METADATA_UPDATE_TOKEN', 'PERSONAL_SYNC_TOKEN']) {
      const secret = 'private-invalid-token';
      const result = spawnSync(process.execPath, [resolve('scripts/deploy.mjs')], {
        cwd, encoding: 'utf8', env: { ...process.env, METADATA_UPDATE_TOKEN: valid, PERSONAL_SYNC_TOKEN: valid, [name]: secret },
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`${name}.*deployment refused`));
      assert.equal(result.stderr.includes(secret), false);
      assert.equal(result.stdout, '');
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
