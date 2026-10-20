import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Stripe from 'stripe';
import { createApp } from '../server/app.js';
import { openStore } from '../server/store.js';
import { testDatabase } from './database.js';

const origin = 'http://localhost:5173';
const password = 'integration-test-password';
const salt = 'test-only-salt';
const adminPasswordHash = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
const database = await testDatabase();
const { app, db } = await createApp({ ...database.config, origin, mode: 'demo', adminPasswordHash });
let server: Server;
let base = '';
let credentials: { orderId: string; accessCode: string };
let cookie = '';
async function request(route: string, body?: unknown, options: { method?: string; cookie?: string; origin?: string } = {}) {
  const response = await fetch(`${base}/api${route}`, {
    method: options.method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', Origin: options.origin || origin, ...(options.cookie ? { Cookie: options.cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, body: await response.json() };
}
before(async () => {
  server = await new Promise<Server>(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); await database.cleanup();
});

test('health and catalog exercise the database and expose the configured plans', async () => {
  assert.equal((await request('/health')).body.database, 'ok');
  const { body } = await request('/catalog');
  assert.equal(body.plans.length, 3); assert.equal(body.paymentMode, 'demo'); assert.equal(body.paymentReady, true);
});
test('rejects forged origins and incomplete orders', async () => {
  assert.equal((await request('/orders', {}, { origin: 'https://attacker.example' })).response.status, 403);
  assert.equal((await request('/orders', { planId: 'plus-month', email: 'bad' })).response.status, 400);
  assert.equal((await request('/orders', { planId: 'fake', email: 'test@example.com', contact: 'test-user', consent: true })).response.status, 400);
});
test('loopback browser addresses reach order authorization rather than failing Origin validation', async () => {
  const { response, body } = await request('/orders/lookup', { orderId: 'missing', accessCode: 'missing' }, { origin: 'http://127.0.0.1:5173' });
  assert.equal(response.status, 404); assert.match(body.error, /订单号或查询码/);
});
test('creates an order with a server-owned price and stores only a hash of the access code', async () => {
  const { response, body } = await request('/orders', { planId: 'plus-month', email: 'Test@example.com', contact: 'test-user', consent: true, amount: 1 });
  assert.equal(response.status, 201); assert.equal(body.order.amount, 16800); assert.equal(body.order.status, 'pending_payment');
  assert.equal(body.order.email, 'test@example.com'); assert.equal(body.accessCode.length, 16);
  credentials = { orderId: body.order.id, accessCode: body.accessCode };
  const row = (await db.prepare('SELECT access_hash FROM orders WHERE id=?').get<{ access_hash: string }>(credentials.orderId))!;
  assert.notEqual(row.access_hash, credentials.accessCode); assert.equal(row.access_hash.length, 64);
  assert.equal(body.order.access_hash, undefined);
});
test('does not disclose an order with a wrong query code', async () => {
  assert.equal((await request('/orders/lookup', { ...credentials, accessCode: 'wrong' })).response.status, 404);
  const { body } = await request('/orders/lookup', credentials); assert.equal(body.order.id, credentials.orderId);
});
test('simulated payment is explicit and cannot pay twice', async () => {
  assert.equal((await request('/orders/checkout', credentials)).body.mode, 'demo');
  const { body } = await request('/orders/demo-pay', credentials); assert.equal(body.order.status, 'paid');
  assert.match(body.order.events.at(-1).message, /未实际扣款/);
  assert.equal((await request('/orders/demo-pay', credentials)).response.status, 409);
});
test('simultaneous payment requests produce only one paid event', async () => {
  const created = await request('/orders', { planId: 'plus-month', email: 'race@example.com', contact: 'race-test', consent: true });
  const receipt = { orderId: created.body.order.id, accessCode: created.body.accessCode };
  const responses = await Promise.all([request('/orders/demo-pay', receipt), request('/orders/demo-pay', receipt)]);
  assert.deepEqual(responses.map(r => r.response.status).sort(), [200, 409]);
  const lookup = await request('/orders/lookup', receipt);
  assert.equal(lookup.body.order.events.length, 2);
  assert.equal(lookup.body.order.status, 'paid');
});
test('administration requires authentication and uses a protected session cookie', async () => {
  assert.equal((await request('/admin/orders')).response.status, 401);
  assert.equal((await request('/admin/login', { password: 'wrong' })).response.status, 401);
  const { response } = await request('/admin/login', { password }); assert.equal(response.status, 200);
  const fullCookie = response.headers.get('set-cookie')!;
  assert.match(fullCookie, /HttpOnly/i); assert.match(fullCookie, /SameSite=Strict/i);
  cookie = fullCookie.split(';')[0];
});
test('paid orders require sequential fulfillment and expose customer-visible notes', async () => {
  const invalid = await request(`/admin/orders/${credentials.orderId}`, { status: 'completed', note: 'skip ahead' }, { method: 'PATCH', cookie });
  assert.equal(invalid.response.status, 409);
  for (const [status, note] of [['processing', '已联系客户，正在核实官方开通条件。'], ['completed', '已完成演示交付，未实际开通订阅。']]) {
    if (status === 'completed') {
      const milestone = await request(`/admin/orders/${credentials.orderId}`, { status: 'processing', note: '已记录本阶段交付，继续跟进下一阶段。' }, { method: 'PATCH', cookie });
      assert.equal(milestone.response.status, 200); assert.equal(milestone.body.order.status, 'processing');
    }
    const { body, response } = await request(`/admin/orders/${credentials.orderId}`, { status, note }, { method: 'PATCH', cookie });
    assert.equal(response.status, 200); assert.equal(body.order.status, status);
  }
  const { body } = await request('/orders/lookup', credentials);
  assert.equal(body.order.events.length, 5); assert.match(body.order.events.at(-1).message, /演示交付/);
});
test('search is parameterized, paginated, and demo payments are excluded from real revenue', async () => {
  const { body } = await request('/admin/orders?status=completed&search=test%40example.com&page=1', undefined, { cookie });
  assert.equal(body.total, 1); assert.equal(body.stats.revenue, 0); assert.equal(body.orders.length, 1);
  assert.equal((await request('/admin/orders?search=%27%20OR%201%3D1--', undefined, { cookie })).body.total, 0);
});
test('order persistence survives reopening the database', async () => {
  const reopened = await openStore({ path: database.config.databasePath, url: database.config.databaseUrl });
  const row = (await reopened.prepare('SELECT status FROM orders WHERE id=?').get<{ status: string }>(credentials.orderId))!;
  assert.equal(row.status, 'completed'); await reopened.close();
});
test('logout revokes the session', async () => {
  assert.equal((await request('/admin/logout', {}, { cookie })).response.status, 200);
  assert.equal((await request('/admin/orders', undefined, { cookie })).response.status, 401);
});
test('Stripe mode rejects demo payments, invalid signatures, and mismatched amounts; valid webhooks are idempotent', async () => {
  const webhookSecret = 'whsec_local_test_fixture';
  const stripeDatabase = await testDatabase();
  const real = await createApp({ ...stripeDatabase.config, origin, mode: 'stripe', adminPasswordHash,
    stripeSecret: 'sk_test_local_fixture_not_a_real_credential', stripeWebhookSecret: webhookSecret });
  const remote = await new Promise<Server>(resolve => { const instance = real.app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const remoteBase = `http://127.0.0.1:${(remote.address() as AddressInfo).port}/api`;
  try {
    const created = await fetch(`${remoteBase}/orders`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ planId: 'plus-month', email: 'stripe@example.com', contact: 'test-user', consent: true }) });
    const { order, accessCode } = await created.json();
    await real.db.prepare('UPDATE orders SET stripe_session=? WHERE id=?').run('cs_test_fixture', order.id);
    const login = await fetch(`${remoteBase}/admin/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    const realCookie = login.headers.get('set-cookie')!.split(';')[0];
    const cancel = await fetch(`${remoteBase}/admin/orders/${order.id}`, { method: 'PATCH', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: realCookie }, body: JSON.stringify({ status: 'cancelled', note: 'payment race test' }) });
    assert.equal(cancel.status, 409);
    const demo = await fetch(`${remoteBase}/orders/demo-pay`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: order.id, accessCode }) });
    assert.equal(demo.status, 404);
    const sendWebhook = async (amount: number, signature = true) => {
      const payload = JSON.stringify({ id: 'evt_test_fixture', type: 'checkout.session.completed', data: { object: { id: 'cs_test_fixture', payment_status: 'paid', amount_total: amount, currency: 'cny', metadata: { orderId: order.id } } } });
      const header = signature ? Stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret }) : 'invalid';
      return fetch(`${remoteBase}/payments/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': header }, body: payload });
    };
    assert.equal((await sendWebhook(16800, false)).status, 400);
    assert.equal((await sendWebhook(1)).status, 500);
    assert.equal((await sendWebhook(16800)).status, 200);
    assert.equal((await sendWebhook(16800)).status, 200);
    assert.equal((await real.db.prepare('SELECT status FROM orders WHERE id=?').get<{ status: string }>(order.id))!.status, 'paid');
    assert.equal(Number((await real.db.prepare('SELECT COUNT(*) AS n FROM order_events WHERE order_id=?').get<{ n: number }>(order.id))!.n), 2);
  } finally { await new Promise<void>(resolve => remote.close(() => resolve())); await real.db.close(); await stripeDatabase.cleanup(); }
});
