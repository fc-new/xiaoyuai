import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localDir = join(root, '.local');
const noOpen = process.argv.includes('--no-open');
const installOnly = process.argv.includes('--prepare-only');
const childEnvironment = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}` };
const minimumNode = process.versions.node.split('.').map(Number);
if (minimumNode[0] < 24 || (minimumNode[0] === 24 && minimumNode[1] < 13)) {
  console.error('Node.js 24.13+ is required. Install Node.js 24 LTS from https://nodejs.org/en/download and start again.');
  process.exit(1);
}
mkdirSync(localDir, { recursive: true, mode: 0o700 });

function runNpm(args) {
  return new Promise((done, reject) => {
    const cli = [process.env.npm_execpath,
      join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ].find(path => path && existsSync(path));
    let command; let commandArgs;
    if (cli && existsSync(cli)) {
      command = process.execPath; commandArgs = [cli, ...args];
    } else if (process.platform === 'win32') {
      // Only fixed, internal npm arguments are passed to cmd; no user input or filesystem paths are interpolated.
      command = process.env.ComSpec || 'cmd.exe'; commandArgs = ['/d', '/s', '/c', `npm ${args.join(' ')}`];
    } else {
      command = 'npm'; commandArgs = args;
    }
    const child = spawn(command, commandArgs, { cwd: root, env: childEnvironment, stdio: 'inherit', windowsHide: true });
    child.once('error', () => reject(new Error('Could not start npm. Install Node.js 24 LTS (including npm), then reopen this launcher.')));
    child.once('exit', code => code === 0 ? done() : reject(new Error(`npm ${args[0]} failed. Check your network connection and the message above, then run the launcher again.`)));
  });
}

// A lockfile change refreshes dependencies on the next launch; interrupted installs cannot be marked complete.
const lockHash = createHash('sha256').update(readFileSync(join(root, 'package-lock.json'))).digest('hex');
const stampPath = join(localDir, 'local-dependencies.sha256');
const installedHash = existsSync(stampPath) ? readFileSync(stampPath, 'utf8').trim() : '';
if (!existsSync(join(root, 'node_modules/tsx/dist/loader.mjs')) || installedHash !== lockHash) {
  console.log('First launch: installing locked dependencies. Internet access is required; please wait.');
  await runNpm(['ci', '--include=dev', '--no-audit', '--no-fund', '--cache', '.local/npm-cache']);
  writeFileSync(stampPath, lockHash, { mode: 0o600 });
}
if (!existsSync(join(root, 'dist/index.html'))) {
  console.log('Preparing the local website...');
  await runNpm(['run', 'build']);
}

const configPath = join(localDir, 'preview-config.json');
let preview;
if (existsSync(configPath)) {
  preview = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(preview.adminPasswordHash || '')) throw new Error('Invalid local preview configuration. Restore .local/preview-config.json from your backup.');
} else {
  const password = randomBytes(15).toString('base64url');
  const salt = randomBytes(16).toString('hex');
  preview = { adminPasswordHash: `${salt}:${scryptSync(password, salt, 64).toString('hex')}` };
  // The secret is generated on the user's computer, never shipped in the ZIP or printed to logs.
  writeFileSync(join(localDir, 'preview-admin.txt'), `XiaoyuAI local preview\nAdmin page: /admin\nPassword: ${password}\nThis is only for the local demo. Keep this file private.\n`, { mode: 0o600, flag: 'wx' });
  writeFileSync(configPath, JSON.stringify(preview, null, 2), { mode: 0o600, flag: 'wx' });
}
if (!preview.voucherSecret) {
  const previewDatabase = join(localDir, 'preview.sqlite');
  if (existsSync(previewDatabase)) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(previewDatabase, { readOnly: true });
    try {
      for (const table of ['activation_key_check', 'voucher_keys']) {
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) && db.prepare(`SELECT * FROM ${table} LIMIT 1`).get()) throw new Error('Restore the original preview voucherSecret from your backup.');
      }
    } finally { db.close(); }
  }
  preview.voucherSecret = randomBytes(32).toString('hex');
  writeFileSync(configPath, JSON.stringify(preview, null, 2), { mode: 0o600 });
}
if (installOnly) { console.log('Local preview prepared. No service was started.'); process.exit(0); }

async function choosePort() {
  for (let port = 17860; port < 17880; port++) {
    const available = await new Promise(done => {
      const probe = createServer();
      probe.once('error', () => done(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)));
    });
    if (available) return port;
  }
  throw new Error('Local preview ports 17860-17879 are occupied. Close an earlier preview window and try again.');
}
const port = await choosePort();
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'server/index.ts')], {
  cwd: root, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true, detached: process.platform !== 'win32',
  env: { ...childEnvironment, NODE_ENV: 'development', PORT: String(port), BIND_ADDRESS: '127.0.0.1', APP_ORIGIN: origin,
    VOUCHER_SECRET: preview.voucherSecret, PAYMENT_MODE: 'demo', XIAOYUAI_LOCAL_PREVIEW: '1', DATABASE_PATH: join(localDir, 'preview.sqlite'), ADMIN_PASSWORD_HASH: preview.adminPasswordHash,
    DATABASE_URL: '', REQUIRE_DATABASE_URL: '', ADMIN_PASSWORD: '', RENDER: 'false', TRUST_PROXY_HOPS: '0' },
});
let stopped = false;
let childExited = false;
child.on('error', () => { childExited = true; console.error('Local server could not start. Check that dependencies are installed.'); process.exitCode = 1; });
child.on('exit', code => {
  childExited = true;
  if (!stopped && code !== 0) { console.error('The local server stopped unexpectedly. Review the message above and restart the launcher.'); process.exitCode = code || 1; }
});
function stop() {
  if (stopped) return;
  stopped = true;
  if (child.connected) child.send({ type: 'xiaoyuai-local-stop' }, error => { if (error && !childExited) child.kill('SIGTERM'); });
  else child.kill('SIGTERM');
  const timer = setTimeout(() => { if (!childExited) child.kill('SIGKILL'); }, 5000); timer.unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

let ready = false;
for (let attempt = 0; attempt < 60 && !childExited && !stopped; attempt++) {
  try {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
    const body = await response.json();
    if (body.status === 'ok' && body.paymentMode === 'demo') { ready = true; break; }
  } catch { /* Wait for the server, not for a fixed startup delay. */ }
  await new Promise(done => setTimeout(done, 250));
}
if (!ready) {
  if (!stopped) { console.error('The preview did not become ready. See the startup messages above.'); process.exitCode = 1; }
  stop();
}
else {
  console.log(`\nXiaoyuAI is ready on YOUR computer: ${origin}`);
  console.log(`Admin: ${origin}/admin`);
  console.log('Admin password: open .local/preview-admin.txt (not printed here).');
  console.log('LOCAL DEMO ONLY. Simulated payment does not charge money or activate subscriptions.');
  console.log('Keep this window open. Press Ctrl+C to stop.\n');
  if (!noOpen) {
    let browserCommand; let browserArgs;
    if (process.platform === 'win32') { browserCommand = 'rundll32.exe'; browserArgs = ['url.dll,FileProtocolHandler', origin]; }
    else if (process.platform === 'darwin') { browserCommand = 'open'; browserArgs = [origin]; }
    else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) { browserCommand = 'xdg-open'; browserArgs = [origin]; }
    if (browserCommand) {
      const browser = spawn(browserCommand, browserArgs, { detached: true, stdio: 'ignore', windowsHide: true });
      browser.on('error', () => console.log(`Open your browser and enter: ${origin}`)); browser.unref();
    }
  }
}
