import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { runtimeConfig } from '../server/config.js';

const password = 'configuration-test-password';
const hosted = { VOUCHER_SECRET: 'a1'.repeat(32), NODE_ENV: 'production', RENDER: 'true', RENDER_EXTERNAL_URL: 'https://fixture.onrender.com',
  DATABASE_URL: 'postgresql://fixture:fixture@db.example/fixture?sslmode=require', ADMIN_PASSWORD: password };

test('Render uses its assigned HTTPS URL, durable database and bounded proxy trust', () => {
  const config = runtimeConfig(hosted);
  assert.equal(config.origin, hosted.RENDER_EXTERNAL_URL);
  assert.equal(config.databaseUrl, hosted.DATABASE_URL);
  assert.equal(config.trustProxyHops, 1);
  assert.equal(config.mode, 'merchant');
  const [salt, digest] = config.adminPasswordHash.split(':');
  assert.equal(scryptSync(password, salt, 64).toString('hex'), digest);
  assert.equal('ADMIN_PASSWORD' in config, false);
});
test('cloud startup refuses ephemeral SQLite even in explicitly selected demo mode', () => {
  assert.throws(() => runtimeConfig({ ...hosted, PAYMENT_MODE: 'demo', DATABASE_URL: '' }), /DATABASE_URL/);
  assert.throws(() => runtimeConfig({ ...hosted, RENDER: '', REQUIRE_DATABASE_URL: '1', DATABASE_URL: '' }), /DATABASE_URL/);
});
test('production requires HTTPS and an explicitly configured strong administrator password', () => {
  assert.throws(() => runtimeConfig({ ...hosted, APP_ORIGIN: 'http://fixture.example' }), /HTTPS/);
  assert.throws(() => runtimeConfig({ ...hosted, ADMIN_PASSWORD: '' }), /ADMIN_PASSWORD/);
  assert.throws(() => runtimeConfig({ ...hosted, ADMIN_PASSWORD: '123456' }), /16 to 256/);
  assert.throws(() => runtimeConfig({ ...hosted, ADMIN_PASSWORD_HASH: 'invalid' }), /only one/);
});
test('a custom domain replaces the provider domain and invalid proxy/port settings fail closed', () => {
  assert.equal(runtimeConfig({ ...hosted, APP_ORIGIN: 'https://xiaoyuai.example/' }).origin, 'https://xiaoyuai.example');
  assert.throws(() => runtimeConfig({ ...hosted, TRUST_PROXY_HOPS: 'true' }), /TRUST_PROXY_HOPS/);
  assert.throws(() => runtimeConfig({ ...hosted, PORT: 'invalid' }), /PORT/);
});

test('voucher encryption requires a stable private key', () => {
  assert.throws(() => runtimeConfig({ ...hosted, VOUCHER_SECRET: '' }), /VOUCHER_SECRET/);
  assert.throws(() => runtimeConfig({ ...hosted, VOUCHER_SECRET: 'short' }), /VOUCHER_SECRET/);
});
