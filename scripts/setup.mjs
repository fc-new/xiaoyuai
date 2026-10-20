import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';

if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24+ is required.');
mkdirSync('data', { recursive: true });
mkdirSync('.local', { recursive: true, mode: 0o700 });
if (!existsSync('.env')) {
  const password = randomBytes(18).toString('base64url');
  const salt = randomBytes(16).toString('hex');
  const hash = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
  const template = readFileSync('.env.example', 'utf8').replace('ADMIN_PASSWORD_HASH=', `ADMIN_PASSWORD_HASH=${hash}`);
  writeFileSync('.env', template, { mode: 0o600, flag: 'wx' });
  writeFileSync('.local/admin-credentials.txt', `Administrator login: /admin\nPassword: ${password}\nKeep this file private. This password is not a payment credential.\n`, { mode: 0o600, flag: 'wx' });
  console.log('Created local configuration. Administrator credentials are in .local/admin-credentials.txt (not printed).');
} else {
  console.log('Existing .env preserved.');
}
console.log('Setup complete. Run npm run dev. Default payment mode: merchant (WeChat / Alipay). Missing merchant configuration keeps ordering closed.');
