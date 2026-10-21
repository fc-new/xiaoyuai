import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';

if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24+ is required.');
mkdirSync('data', { recursive: true });
mkdirSync('.local', { recursive: true, mode: 0o700 });
if (!existsSync('.env')) {
  const password = randomBytes(18).toString('base64url');
  const salt = randomBytes(16).toString('hex');
  const hash = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
  const template = readFileSync('.env.example', 'utf8').replace('ADMIN_PASSWORD_HASH=', `ADMIN_PASSWORD_HASH=${hash}`).replace('VOUCHER_SECRET=', `VOUCHER_SECRET=${randomBytes(32).toString('hex')}`);
  writeFileSync('.env', template, { mode: 0o600, flag: 'wx' });
  writeFileSync('.local/admin-credentials.txt', `Administrator login: /admin\nPassword: ${password}\nKeep this file private. This password is not a payment credential.\n`, { mode: 0o600, flag: 'wx' });
  console.log('Created local configuration. Administrator credentials are in .local/admin-credentials.txt (not printed).');
} else {
  if (!/^VOUCHER_SECRET=.+$/m.test(readFileSync('.env', 'utf8'))) {
    if (existsSync('data/xiaoyuai.sqlite')) {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync('data/xiaoyuai.sqlite', { readOnly: true });
      try {
        for (const table of ['activation_key_check', 'voucher_keys']) {
          if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) && db.prepare(`SELECT * FROM ${table} LIMIT 1`).get()) {
            throw new Error('Restore the original VOUCHER_SECRET from your backup before setup.');
          }
        }
      } finally { db.close(); }
    }
    appendFileSync('.env', `\nVOUCHER_SECRET=${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
    console.log('Added a private voucher encryption key; existing settings preserved.');
  } else console.log('Existing .env preserved.');
}
console.log('Setup complete. Run npm run dev. External-code activation portal enabled. Card purchases are disabled; generate or import codes in /admin.');
