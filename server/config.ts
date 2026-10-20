import { randomBytes, scryptSync } from 'node:crypto';

export function runtimeConfig(env: NodeJS.ProcessEnv) {
  const production = env.NODE_ENV === 'production';
  const render = env.RENDER === 'true';
  const mode = env.PAYMENT_MODE || 'merchant';
  if (mode !== 'demo' && mode !== 'stripe' && mode !== 'merchant') throw new Error('PAYMENT_MODE must be merchant, demo or stripe');
  const origin = new URL(env.APP_ORIGIN || env.RENDER_EXTERNAL_URL || 'http://localhost:5173').origin;
  if (production && !origin.startsWith('https://')) throw new Error('Production requires an HTTPS APP_ORIGIN or RENDER_EXTERNAL_URL');
  if ((render || env.REQUIRE_DATABASE_URL === '1') && !env.DATABASE_URL) throw new Error('DATABASE_URL is required; cloud deployments cannot fall back to ephemeral SQLite');
  let adminPasswordHash = env.ADMIN_PASSWORD_HASH;
  if (adminPasswordHash && env.ADMIN_PASSWORD) throw new Error('Configure only one of ADMIN_PASSWORD_HASH and ADMIN_PASSWORD');
  if (!adminPasswordHash && env.ADMIN_PASSWORD) {
    if (env.ADMIN_PASSWORD.length < 16 || env.ADMIN_PASSWORD.length > 256) throw new Error('ADMIN_PASSWORD must contain 16 to 256 characters');
    const salt = randomBytes(16).toString('hex');
    adminPasswordHash = `${salt}:${scryptSync(env.ADMIN_PASSWORD, salt, 64).toString('hex')}`;
  }
  if (!adminPasswordHash || !/^[^:]+:[a-f0-9]{128}$/.test(adminPasswordHash)) throw new Error('Configure ADMIN_PASSWORD_HASH or a strong ADMIN_PASSWORD before starting');
  const port = Number(env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port');
  const trustProxyHops = Number(env.TRUST_PROXY_HOPS || (render ? 1 : 0));
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 10) throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 10');
  return { production, mode: mode as 'demo' | 'stripe' | 'merchant', origin, adminPasswordHash, port, trustProxyHops,
    voucherSecret: env.VOUCHER_SECRET,
    databasePath: env.DATABASE_PATH || './data/xiaoyuai.sqlite', databaseUrl: env.DATABASE_URL };
}
