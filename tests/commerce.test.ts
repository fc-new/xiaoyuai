import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { testDatabase } from './database.js';
import { migrateCommerce } from '../server/migrations.js';
import { openStore } from '../server/store.js';
import { VoucherVault, type VoucherRow } from '../server/vouchers.js';

const origin = 'http://localhost:5173', password = 'commerce-test-password';
const adminPasswordHash = `commerce:${scryptSync(password, 'commerce', 64).toString('hex')}`;
async function fixture(options: { noKey?: boolean; mode?: 'demo' | 'merchant' } = {}) {
  const database = await testDatabase();
  const config = { ...database.config, origin, mode: options.mode || 'demo' as const, adminPasswordHash, ...(options.noKey ? { voucherSecret: undefined } : {}) };
  const instance = await createApp(config);
  const server = await new Promise<Server>(resolve => { const s = instance.app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  let cookie = '';
  async function request(path: string, body?: unknown, admin = false, method = body === undefined ? 'GET' : 'POST', requestOrigin = origin) {
    const r = await fetch(base + path, { method, headers: { Origin: requestOrigin, 'Content-Type': 'application/json', ...(admin ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await r.json(); return { status: r.status, data, headers: r.headers };
  }
  const login = await request('/admin/login', { password }); cookie = login.headers.get('set-cookie')!.split(';')[0];
  async function buy(quantity = 1, paid = true) {
    const created = await request('/orders', { planId: 'plus-month', email: 'buyer@example.com', contact: 'buyer-test', consent: true, quantity, amount: 1 });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const receipt = { orderId: created.data.order.id, accessCode: created.data.accessCode };
    if (paid) assert.equal((await request('/orders/demo-pay', receipt)).status, 200);
    return { receipt, order: created.data.order, codes: paid ? (await request('/orders/vouchers', receipt)).data.vouchers : [] };
  }
  const redeem = (code: string, key = randomBytes(32).toString('hex')) => ({ code, targetEmail: 'target@example.com', contact: 'target-contact', consent: true, requestKey: key });
  const patch = (id: string, status: string, expectedStatus: string, extra = {}) => request(`/admin/redemptions/${id}`, { status, expectedStatus, note: '核实后的客户可见记录', ...extra }, true, 'PATCH');
  return { ...instance, config, request, buy, redeem, patch, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await instance.db.close(); await database.cleanup(); } };
}

test('new purchase uses server quantity/price, gates unpaid codes and exposes secrets only to authorized reveal', async () => {
  const f = await fixture(); try {
    const { receipt, order } = await f.buy(3, false); assert.equal(order.amount, 50400); assert.equal(order.flow, 'voucher');
    assert.deepEqual((await f.request('/orders/vouchers', receipt)).data.vouchers, []);
    assert.equal((await f.request('/orders/demo-pay', receipt)).status, 200);
    const lookup = (await f.request('/orders/lookup', receipt)).data.order;
    assert.equal(lookup.issuedCount, 3); assert.equal(JSON.stringify(lookup).includes('XYD-'), false);
    assert.equal((await f.request('/orders/vouchers', { ...receipt, accessCode: 'wrong' })).status, 404);
    const codes = (await f.request('/orders/vouchers', receipt)).data.vouchers;
    assert.equal(new Set(codes.map((v: any) => v.code)).size, 3);
    const stored = await f.db.prepare('SELECT * FROM vouchers WHERE order_id=?').all<VoucherRow>(order.id);
    assert.equal(JSON.stringify(stored).includes(codes[0].code), false);
    assert.equal(stored.every(v => v.code_encrypted && v.code_hash.length === 64), true);
    const admin = await f.request('/admin/commerce?kind=vouchers', undefined, true);
    assert.equal(JSON.stringify(admin.data).includes('XYD-'), false);
    assert.equal((await f.request('/admin/commerce')).status, 401);
    assert.equal((await f.request('/orders', { planId: 'plus-month', email: 'a@b.com', contact: 'test', consent: true, quantity: 0 })).status, 400);
    assert.equal((await f.request('/orders', { planId: 'plus-month', email: 'a@b.com', contact: 'test', consent: true, quantity: 11 })).status, 400);
  } finally { await f.close(); }
});

test('concurrent payment and repeated compensation issue each purchased entitlement once', async () => {
  const f = await fixture(); try {
    const { receipt } = await f.buy(4, false);
    const outcomes = await Promise.all([f.request('/orders/demo-pay', receipt), f.request('/orders/demo-pay', receipt)]);
    assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 409]);
    await Promise.all([f.compensate(), f.compensate(), f.compensate()]);
    assert.equal(Number((await f.db.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE order_id=?').get<{ n: number }>(receipt.orderId))!.n), 4);
  } finally { await f.close(); }
});

test('interrupted issuance rolls back all codes while payment persists, and compensation recovers', async () => {
  const f = await fixture(); try {
    const { receipt } = await f.buy(2, false);
    const original = VoucherVault.prototype.issue;
    VoucherVault.prototype.issue = async function (tx, order) { await original.call(this, tx, order); throw new Error('injected issuance interruption'); };
    try { assert.equal((await f.request('/orders/demo-pay', receipt)).status, 200); } finally { VoucherVault.prototype.issue = original; }
    assert.equal((await f.request('/orders/lookup', receipt)).data.order.status, 'paid');
    assert.equal((await f.request('/orders/vouchers', receipt)).data.vouchers.length, 0);
    assert.equal((await f.compensate()).repaired, 1);
    assert.equal((await f.request('/orders/vouchers', receipt)).data.vouchers.length, 2);
  } finally { await f.close(); }
});

test('same redemption retry returns original result, another key cannot take over, and no partial commit loses entitlement', async () => {
  const f = await fixture(); try {
    const b = await f.buy(), input = f.redeem(b.codes[0].code);
    const failedTx = f.db.transaction.bind(f.db);
    let injected = true;
    f.db.transaction = async work => failedTx(async tx => { const result = await work(tx); if (injected && (await tx.prepare('SELECT id FROM redemptions').get())) { injected = false; throw new Error('injected rollback'); } return result; });
    assert.equal((await f.request('/vouchers/redeem', input)).status, 500);
    assert.equal((await f.request('/vouchers/check', { code: input.code })).data.redeemable, true);
    f.db.transaction = failedTx;
    const results = await Promise.all([f.request('/vouchers/redeem', input), f.request('/vouchers/redeem', input)]);
    assert.deepEqual(results.map(r => r.status), [200, 200]); assert.equal(results[0].data.redemption.id, results[1].data.redemption.id);
    assert.equal((await f.request('/vouchers/redeem', f.redeem(input.code))).status, 409);
    const id = results[0].data.redemption.id;
    const recovered = await f.request('/redemptions/recover', { code: input.code, accessCode: input.requestKey });
    assert.equal(recovered.data.redemption.id, id);
    assert.equal((await f.request('/redemptions/recover', { code: input.code, accessCode: randomBytes(32).toString('hex') })).status, 404);
    assert.equal((await f.request('/redemptions/lookup', { id, accessCode: randomBytes(32).toString('hex') })).status, 404);
    const publicResult = (await f.request('/redemptions/lookup', { id, accessCode: input.requestKey })).data.redemption;
    assert.equal(publicResult.targetEmail, 't***@example.com'); assert.equal(publicResult.contact, undefined);
    assert.equal((await f.request('/vouchers/redeem', { ...input, accessToken: 'should-not-be-accepted' })).status, 400);
  } finally { await f.close(); }
});

test('competing redeemers create exactly one reservation and one task', async () => {
  const f = await fixture(); try {
    const b = await f.buy();
    const r = await Promise.all([f.request('/vouchers/redeem', f.redeem(b.codes[0].code)), f.request('/vouchers/redeem', f.redeem(b.codes[0].code))]);
    assert.deepEqual(r.map(v => v.status).sort(), [200, 409]);
    assert.equal(Number((await f.db.prepare('SELECT COUNT(*) AS n FROM redemptions').get<{ n: number }>())!.n), 1);
  } finally { await f.close(); }
});

test('invalid, frozen, void and expired codes cannot redeem; freeze actions require auth and origin', async () => {
  const f = await fixture(); try {
    assert.equal((await f.request('/vouchers/check', { code: 'XYA-invalid' })).status, 404);
    const b = await f.buy(3);
    const freeze = { action: 'freeze', note: '待核实来源' };
    assert.equal((await f.request(`/admin/vouchers/${b.codes[0].id}`, freeze, false, 'PATCH')).status, 401);
    assert.equal((await f.request(`/admin/vouchers/${b.codes[0].id}`, freeze, true, 'PATCH', 'https://attacker.example')).status, 403);
    assert.equal((await f.request(`/admin/vouchers/${b.codes[0].id}`, freeze, true, 'PATCH')).status, 200);
    await f.request(`/admin/vouchers/${b.codes[1].id}`, { action: 'void', note: '客户取消使用' }, true, 'PATCH');
    await f.db.prepare('UPDATE vouchers SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', b.codes[2].id);
    for (const v of b.codes) assert.equal((await f.request('/vouchers/redeem', f.redeem(v.code))).status, 409);
    assert.equal((await f.request(`/admin/vouchers/${b.codes[0].id}`, { action: 'unfreeze', note: '核实无误' }, true, 'PATCH')).status, 200);
    assert.equal((await f.request('/vouchers/redeem', f.redeem(b.codes[0].code))).status, 200);
  } finally { await f.close(); }
});

test('fulfillment requires assignment, sequential states and evidence; unknown results cannot blindly retry', async () => {
  const f = await fixture(); try {
    const b = await f.buy(), input = f.redeem(b.codes[0].code), r = (await f.request('/vouchers/redeem', input)).data.redemption;
    assert.equal((await f.request(`/admin/orders/${b.order.id}`, { status: 'processing', note: 'bypass' }, true, 'PATCH')).status, 409);
    assert.equal((await f.patch(r.id, 'completed', 'pending')).status, 409);
    assert.equal((await f.patch(r.id, 'processing', 'pending')).status, 400);
    assert.equal((await f.patch(r.id, 'processing', 'pending', { assignee: 'operator-1' })).status, 200);
    assert.equal((await f.patch(r.id, 'review', 'processing')).status, 200);
    assert.equal((await f.patch(r.id, 'pending', 'review')).status, 409);
    assert.equal((await f.patch(r.id, 'failed', 'review')).status, 400);
    assert.equal((await f.patch(r.id, 'failed', 'review', { confirmed: true, deliveryReference: 'DEMO-NOT-CHARGED' })).status, 200);
    assert.equal((await f.patch(r.id, 'pending', 'failed')).status, 200);
    assert.equal((await f.patch(r.id, 'processing', 'pending', { assignee: 'operator-1' })).status, 200);
    assert.equal((await f.patch(r.id, 'completed', 'processing')).status, 400);
    assert.equal((await f.patch(r.id, 'completed', 'processing', { confirmed: true, deliveryReference: 'DEMO-DELIVERY-1' })).status, 200);
    assert.equal((await f.patch(r.id, 'pending', 'completed')).status, 409);
    assert.equal((await f.request('/vouchers/check', { code: input.code })).data.status, 'redeemed');
    assert.equal((await f.request('/orders/lookup', b.receipt)).data.order.status, 'paid');
    assert.equal((await f.request(`/admin/orders/${b.order.id}/refund-request`, { note: 'full refund' }, true)).status, 409);
  } finally { await f.close(); }
});

test('refund races with redemption safely, preserves freeze through late payment and voids only on confirmation', async () => {
  const f = await fixture(); try {
    const b = await f.buy(2), input = f.redeem(b.codes[0].code);
    const r = await Promise.all([f.request('/vouchers/redeem', input), f.request(`/admin/orders/${b.order.id}/refund-request`, { note: '客户申请全额退款' }, true)]);
    assert.equal(r[1].status, 200); assert.ok([200, 409].includes(r[0].status));
    assert.equal((await f.request('/orders/lookup', b.receipt)).data.order.status, 'refund_pending');
    await f.compensate();
    for (const c of b.codes) { assert.equal((await f.request('/vouchers/check', { code: c.code })).data.redeemable, false); }
    if (r[0].status === 200) assert.equal((await f.patch(r[0].data.redemption.id, 'processing', 'pending', { assignee: 'operator' })).status, 409);
    assert.equal((await f.request(`/admin/vouchers/${b.codes[0].id}`, { action: 'unfreeze', note: 'bad attempt' }, true, 'PATCH')).status, 409);
    const verified = await f.request(`/admin/orders/${b.order.id}/refund-check`, { reference: 'demo' }, true);
    assert.equal(verified.data.verified, true);
    assert.equal((await f.request('/orders/lookup', b.receipt)).data.order.status, 'refunded');
    assert.equal((await f.request('/vouchers/check', { code: b.codes[1].code })).data.status, 'void');
    assert.equal((await f.request('/orders/vouchers', b.receipt)).data.vouchers.length, 0);
  } finally { await f.close(); }
});

test('demo codes cannot be redeemed after switching to merchant mode', async () => {
  const f = await fixture(); let other: Awaited<ReturnType<typeof createApp>> | undefined, server: Server | undefined;
  try {
    const b = await f.buy(); other = await createApp({ ...f.config, mode: 'merchant' });
    server = await new Promise<Server>(resolve => { const s = other!.app.listen(0, '127.0.0.1', () => resolve(s)); });
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/vouchers/redeem`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(f.redeem(b.codes[0].code)) });
    assert.equal(r.status, 409);
  } finally { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); if (other) await other.db.close(); await f.close(); }
});

test('migration is repeatable and preserves legacy order fulfillment and credentials; missing/wrong key fails safely', async () => {
  const f = await fixture(); try {
    const b = await f.buy(1, false);
    // Represents an order created by the previous release, before purchase_orders existed.
    await f.db.prepare('DELETE FROM purchase_orders WHERE order_id=?').run(b.order.id);
    await migrateCommerce(f.db); await migrateCommerce(f.db);
    assert.equal((await f.request('/orders/lookup', b.receipt)).data.order.flow, 'legacy');
    await f.request('/orders/demo-pay', b.receipt);
    assert.equal((await f.request(`/admin/orders/${b.order.id}`, { status: 'processing', note: '旧订单正常处理' }, true, 'PATCH')).status, 200);
    const reopened = await openStore({ path: f.config.databasePath, url: f.config.databaseUrl });
    assert.equal((await reopened.prepare('SELECT status FROM orders WHERE id=?').get<{ status: string }>(b.order.id))!.status, 'processing'); await reopened.close();
    await assert.rejects(() => createApp({ ...f.config, voucherSecret: 'b2'.repeat(32) }), /VOUCHER_SECRET/);
  } finally { await f.close(); }
  const missing = await fixture({ noKey: true }); try { assert.equal((await missing.request('/catalog')).data.paymentReady, false); assert.equal((await missing.request('/orders', { planId: 'plus-month', email: 'a@b.com', contact: 'test', consent: true })).status, 503); } finally { await missing.close(); }
});
