import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, scryptSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../server/app.js';
import { testDatabase } from './database.js';

const origin = 'http://localhost:5173';
const password = 'activation-test-password';
const salt = 'activation-tests';
const adminPasswordHash = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
const secret = 'a1'.repeat(32);
const database = await testDatabase();
const config = { ...database.config, origin, mode: 'demo' as const, adminPasswordHash, voucherSecret: secret, purchasesEnabled: false };
const { app, db } = await createApp(config);
let server: Server; let base = ''; let cookie = ''; let realCode = ''; let demoCode = ''; let jobId = ''; let expiresJobId = '';
let key = 'a'.repeat(32);
const token = [Buffer.from('{"alg":"RS256"}').toString('base64url'), Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'localfixture_signature_not_a_real_token'].join('.');
const session = (email = 'owner@example.com', expires = new Date(Date.now() + 3600000).toISOString()) => JSON.stringify({ user: { email }, accessToken: token, expires, extraProfile: 'must-not-be-stored' });
async function request(path: string, body?: unknown, admin = false, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Origin: origin, ...(admin ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json(), response };
}
before(async () => {
  server = await new Promise<Server>(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cookie = (await request('/admin/login', { password })).response.headers.get('set-cookie')!.split(';')[0];
});
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); await database.cleanup(); });

test('external-code portal closes new storefront purchases and protects inventory', async () => {
  assert.equal((await request('/activation/config')).body.purchaseEnabled, false);
  assert.equal((await request('/orders', { planId: 'plus-month', email: 'a@example.com', contact: 'customer', consent: true })).status, 410);
  assert.equal((await request('/admin/activation/codes')).status, 401);
  assert.equal((await request('/admin/activation/jobs')).status, 401);
  assert.equal((await request('/admin/activation/codes/generate', { planId: 'plus-month', isDemo: true, source: 'test', count: 1 })).status, 401);
});
test('generated and imported codes are hashed; generated plaintext is returned only at creation', async () => {
  const generated = await request('/admin/activation/codes/generate', { planId: 'plus-month', isDemo: false, source: 'test-real', count: 2 }, true);
  assert.equal(generated.status, 201); realCode = generated.body.codes[0];
  const demos = await request('/admin/activation/codes/generate', { planId: 'plus-month', isDemo: true, source: 'test-demo', count: 2 }, true);
  demoCode = demos.body.codes[0];
  const rows = await db.prepare('SELECT * FROM activation_codes').all();
  assert.equal(rows.length, 4); assert.ok(rows.every(row => typeof row.code_hash === 'string' && row.code_hash.length === 64));
  assert.equal(JSON.stringify(rows).includes(realCode), false);
  assert.equal(JSON.stringify((await request('/admin/activation/codes', undefined, true)).body).includes(realCode), false);
  assert.equal((await request('/activation/check', { code: realCode.toLowerCase() })).body.redeemable, true);
});
test('batch import is atomic for duplicates, including differently formatted copies', async () => {
  const input = { planId: 'plus-month', isDemo: true, source: 'external-channel', codes: ['EXTERNAL-CODE-12345678', demoCode] };
  assert.equal((await request('/admin/activation/codes/import', input, true)).status, 409);
  assert.equal((await request('/activation/check', { code: input.codes[0] })).status, 404);
  assert.equal((await request('/admin/activation/codes/import', { ...input, codes: ['FORMAT-CODE-12345678', 'formatcode12345678'] }, true)).status, 409);
  assert.equal((await request('/admin/activation/codes/import', { ...input, codes: ['EXTERNAL-CODE-12345678'] }, true)).status, 201);
  assert.equal((await request('/activation/check', { code: input.codes[0] })).body.redeemable, true);
});
test('disabled and expired codes cannot be redeemed; malformed/expired sessions do not consume codes', async () => {
  assert.equal((await request('/activation/redeem', { code: realCode, session: '{}', consent: true, requestKey: key })).status, 400);
  assert.equal((await request('/activation/redeem', { code: realCode, session: session('owner@example.com', new Date(Date.now() - 1000).toISOString()), consent: true, requestKey: key })).status, 400);
  assert.equal((await request('/activation/check', { code: realCode })).body.redeemable, true);
  const inventory = (await request('/admin/activation/codes', undefined, true)).body.codes;
  const imported = inventory.find((c: { source: string }) => c.source === 'external-channel');
  assert.equal((await request(`/admin/activation/codes/${imported.id}`, { status: 'disabled' }, true, 'PATCH')).status, 200);
  assert.equal((await request('/activation/redeem', { code: 'EXTERNAL-CODE-12345678', session: 'DEMO_SESSION', consent: true, requestKey: key })).status, 409);
  await db.prepare('UPDATE activation_codes SET expires_at=? WHERE id=?').run(new Date(Date.now() - 10000).toISOString(), imported.id);
  await request(`/admin/activation/codes/${imported.id}`, { status: 'ready' }, true, 'PATCH');
  assert.equal((await request('/activation/check', { code: 'EXTERNAL-CODE-12345678' })).body.status, 'expired');
  assert.equal((await request('/activation/redeem', { code: 'EXTERNAL-CODE-12345678', session: 'DEMO_SESSION', consent: true, requestKey: key })).status, 409);
});
test('competing redeemers consume a card once; retries return the original task without disclosing session', async () => {
  const input = { code: realCode, session: session(), consent: true, requestKey: key };
  const responses = await Promise.all([request('/activation/redeem', input), request('/activation/redeem', { ...input, requestKey: 'b'.repeat(32) })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const winner = responses.find(r => r.status === 200)!;
  const winnerKey = responses[0].status === 200 ? key : 'b'.repeat(32);
  key = winnerKey;
  jobId = winner.body.job.id;
  assert.equal(winner.body.job.accountEmail, 'owner@example.com');
  assert.equal(JSON.stringify(winner.body).includes(token), false);
  const retry = await request('/activation/redeem', { ...input, requestKey: key, session: '{}' });
  assert.equal(retry.status, 200); assert.equal(retry.body.job.id, jobId);
  assert.equal((await request('/activation/recover', { code: realCode, requestKey: key })).body.job.id, jobId);
  assert.equal((await request('/activation/recover', { code: realCode, requestKey: 'f'.repeat(32) })).status, 404);
  assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM activation_jobs').get())!.n), 1);
  const row = (await db.prepare('SELECT * FROM activation_jobs WHERE id=?').get(jobId))!;
  assert.notEqual(row.session_ciphertext, token); assert.equal(JSON.stringify(row).includes(token), false);
  assert.equal(JSON.stringify(row).includes('must-not-be-stored'), false);
  assert.equal(row.access_hash, createHash('sha256').update(key).digest('hex'));
  assert.ok(Date.parse(String(row.session_expires_at)) <= Date.now() + 30 * 60000);
  assert.equal((await request('/activation/lookup', { id: jobId, accessCode: '0'.repeat(32) })).status, 404);
});
test('temporary credentials require a claimed task, fresh administrator password and leave an audit record', async () => {
  const path = `/admin/activation/jobs/${jobId}`;
  assert.equal((await request(`${path}/session`, { password }, true)).status, 409);
  assert.equal((await request(path, { status: 'completed', note: 'skip', confirmed: true, deliveryReference: 'receipt-fixture' }, true, 'PATCH')).status, 409);
  assert.equal((await request(path, { status: 'processing', note: '已领取授权履约任务。' }, true, 'PATCH')).status, 200);
  assert.equal((await request(`${path}/session`, { password: 'wrong' }, true)).status, 401);
  assert.equal((await request(`${path}/session`, { password })).status, 401);
  const reveal = await request(`${path}/session`, { password }, true);
  assert.equal(reveal.body.accessToken, token);
  const lookup = await request('/activation/lookup', { id: jobId, accessCode: key });
  assert.ok(lookup.body.job.events.some((e: { kind: string }) => e.kind === 'session_accessed'));
  assert.equal(JSON.stringify((await request('/admin/activation/jobs', undefined, true)).body).includes(token), false);
});
test('user deletion erases session, blocks processing until resubmission and forbids switching accounts', async () => {
  const receipt = { id: jobId, accessCode: key };
  const deleted = await request('/activation/delete-session', receipt);
  assert.equal(deleted.body.job.sessionAvailable, false); assert.equal(deleted.body.job.status, 'needs_session');
  assert.equal((await db.prepare('SELECT session_ciphertext FROM activation_jobs WHERE id=?').get(jobId))!.session_ciphertext, null);
  assert.equal((await request(`/admin/activation/jobs/${jobId}`, { status: 'processing', note: 'cannot process' }, true, 'PATCH')).status, 409);
  assert.equal((await request('/activation/session', { ...receipt, session: session('someoneelse@example.com'), consent: true })).status, 409);
  const updated = await request('/activation/session', { ...receipt, session: session(), consent: true });
  assert.equal(updated.body.job.status, 'queued'); assert.equal(updated.body.job.sessionAvailable, true);
});
test('completion requires official delivery reference and operator confirmation; terminal tasks erase credentials', async () => {
  const path = `/admin/activation/jobs/${jobId}`;
  await request(path, { status: 'processing', note: '继续处理授权任务。' }, true, 'PATCH');
  assert.equal((await request(path, { status: 'completed', note: 'done', confirmed: true }, true, 'PATCH')).status, 400);
  assert.equal((await request(path, { status: 'completed', note: 'done', deliveryReference: 'official-fixture' }, true, 'PATCH')).status, 400);
  const done = await request(path, { status: 'completed', note: '测试交付记录，不进行真实充值。', deliveryReference: 'official-fixture', confirmed: true }, true, 'PATCH');
  assert.equal(done.status, 200); assert.equal(done.body.job.status, 'completed'); assert.equal(done.body.job.sessionAvailable, false);
  assert.equal((await db.prepare('SELECT session_ciphertext FROM activation_jobs WHERE id=?').get(jobId))!.session_ciphertext, null);
  assert.equal((await request(`${path}/session`, { password }, true)).status, 409);
  assert.equal((await request(path, { status: 'processing', note: 'reopen' }, true, 'PATCH')).status, 409);
  assert.equal((await request('/activation/session', { id: jobId, accessCode: key, session: session(), consent: true })).status, 409);
});
test('demo codes reject real sessions, expired ciphertext is purged and failure is terminal', async () => {
  const input = { code: demoCode, session: session(), consent: true, requestKey: 'c'.repeat(32) };
  assert.equal((await request('/activation/redeem', input)).status, 400);
  const demo = await request('/activation/redeem', { ...input, session: 'DEMO_SESSION' });
  expiresJobId = demo.body.job.id;
  await db.prepare('UPDATE activation_jobs SET session_expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), expiresJobId);
  const expired = await request('/activation/lookup', { id: expiresJobId, accessCode: input.requestKey });
  assert.equal(expired.body.job.status, 'needs_session'); assert.equal(expired.body.job.sessionAvailable, false);
  assert.equal((await db.prepare('SELECT session_ciphertext FROM activation_jobs WHERE id=?').get(expiresJobId))!.session_ciphertext, null);
  const failed = await request(`/admin/activation/jobs/${expiresJobId}`, { status: 'failed', note: '演示任务结束，不进行真实充值。' }, true, 'PATCH');
  assert.equal(failed.status, 200);
  assert.equal((await request('/activation/redeem', { ...input, requestKey: 'd'.repeat(32), session: 'DEMO_SESSION' })).status, 409);
});
test('changing the encryption key cannot silently invalidate existing sessions', async () => {
  await assert.rejects(createApp({ ...config, voucherSecret: 'b2'.repeat(32) }), /Restore.*original/);
});

test('complete sessions up to one million characters survive redeem and update, including long tokens and multibyte JSON', async () => {
  const { MAX_SESSION_CHARACTERS, SESSION_LENGTH_ERROR } = await import('../shared/session-limits.js');
  const makeLargeSession = (suffix: string) => {
    const value = { ...JSON.parse(session()), accessToken: token + suffix.repeat(40000), padding: '' };
    const overhead = JSON.stringify(value).length;
    value.padding = '中'.repeat(MAX_SESSION_CHARACTERS - overhead);
    return JSON.stringify(value);
  };
  const large = makeLargeSession('x');
  assert.equal(large.length, MAX_SESSION_CHARACTERS);
  assert.ok(Buffer.byteLength(JSON.stringify({ session: large })) > 96 * 1024);
  const generated = await request('/admin/activation/codes/generate', { planId: 'plus-month', isDemo: false, source: 'large-session-regression', count: 1 }, true);
  const code = generated.body.codes[0];
  const input = { code, session: large, requestKey: 'e'.repeat(32), consent: true };
  const tooLarge = await request('/activation/redeem', { ...input, session: large + ' ' });
  assert.equal(tooLarge.status, 413); assert.equal(tooLarge.body.error, SESSION_LENGTH_ERROR);
  assert.equal((await request('/activation/check', { code })).body.redeemable, true);
  const created = await request('/activation/redeem', input);
  assert.equal(created.status, 200); assert.equal(created.body.job.accountEmail, 'owner@example.com');
  assert.equal(JSON.stringify(created.body).includes('中'), false);
  const receipt = { id: created.body.job.id, accessCode: input.requestKey };
  const original = (await db.prepare('SELECT session_ciphertext FROM activation_jobs WHERE id=?').get<{ session_ciphertext: string }>(receipt.id))!.session_ciphertext;
  assert.ok(original.length < large.length); // Unneeded profile text is not retained.
  const rejected = await request('/activation/session', { ...receipt, session: large + ' ', consent: true });
  assert.equal(rejected.status, 413); assert.equal(rejected.body.error, SESSION_LENGTH_ERROR);
  assert.equal((await db.prepare('SELECT session_ciphertext FROM activation_jobs WHERE id=?').get(receipt.id))!.session_ciphertext, original);
  const updated = await request('/activation/session', { ...receipt, session: makeLargeSession('y'), consent: true });
  assert.equal(updated.status, 200); assert.equal(updated.body.job.sessionAvailable, true);
  await request(`/admin/activation/jobs/${receipt.id}`, { status: 'processing', note: '大体积测试凭据，无实际充值。' }, true, 'PATCH');
  const revealed = await request(`/admin/activation/jobs/${receipt.id}/session`, { password }, true);
  assert.equal(revealed.body.accessToken, token + 'y'.repeat(40000));
  await request('/activation/delete-session', receipt);
});

test('unrelated endpoints retain their smaller body limit and oversized transport requests return JSON 413', async () => {
  const unrelated = await request('/activation/check', { code: 'INVALID-CODE-12345678', padding: 'x'.repeat(100 * 1024) });
  assert.equal(unrelated.status, 413); assert.equal(typeof unrelated.body.error, 'string');
  const tooLarge = await request('/activation/redeem', { session: 'x'.repeat(8 * 1024 * 1024 + 1) });
  assert.equal(tooLarge.status, 413); assert.equal(typeof tooLarge.body.error, 'string');
});
