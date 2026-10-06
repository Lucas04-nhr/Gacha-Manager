import { spawn } from 'node:child_process';

// Local macOS development must use the operator's canonical Homebrew Wrangler.
const executable = process.platform === 'darwin' ? '/opt/homebrew/bin/wrangler' : 'wrangler';
const child = spawn(executable, ['dev', ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('error', () => {
  console.error('Unable to start Wrangler development server.');
  process.exitCode = 1;
});
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
