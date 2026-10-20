import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, generateKeyPairSync, scryptSync, sign, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AlipaySdk } from 'alipay-sdk';
import { createApp } from '../server/app.js';
import { testDatabase } from './database.js';
import { loadMerchantConfig, MerchantPayments, yuanToCents, type MerchantConfig } from '../server/merchant.js';

// Locally generated synthetic keys; no real merchant or network is used.
const keypair = () => generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const merchantKeys = keypair();
const platformKeys = keypair();
const origin = 'https://merchant.example';
const apiV3Key = '12345678901234567890123456789012';
const salt = 'merchant-fixture';
const password = 'merchant-fixture-password';
const adminPasswordHash = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
const merchantConfig: MerchantConfig = {
  origin,
  wechat: { appId: 'wx-fixture-app', mchId: 'fixture-mch', certSerial: 'fixture-serial', privateKey: merchantKeys.privateKey,
    apiV3Key, platformKeyId: 'PUB_KEY_ID_fixture', platformPublicKey: platformKeys.publicKey },
  alipay: { appId: 'fixture-alipay-app', sellerId: 'fixture-seller', privateKey: merchantKeys.privateKey, publicKey: platformKeys.publicKey },
  statuses: ['wechat', 'alipay'].map(provider => ({ provider: provider as 'wechat' | 'alipay', label: provider, configured: true, missing: [], notifyUrl: `${origin}/api/payments/${provider}/notify` })),
};
function wechatHeaders(body: string, stale = false) {
  const timestamp = String(Math.floor(Date.now() / 1000) - (stale ? 600 : 0));
  const nonce = 'fixture-nonce';
  return { 'wechatpay-serial': 'PUB_KEY_ID_fixture', 'wechatpay-timestamp': timestamp, 'wechatpay-nonce': nonce,
    'wechatpay-signature': sign('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${body}\n`), platformKeys.privateKey).toString('base64') };
}
function wechatNotice(orderId: string, amount = 16800, transactionId = 'wx-fixture-trade', appId = 'wx-fixture-app') {
  const nonce = 'fixture12345';
  const aad = 'transaction';
  const transaction = { appid: appId, mchid: 'fixture-mch', out_trade_no: orderId, transaction_id: transactionId, trade_state: 'SUCCESS', amount: { total: amount, currency: 'CNY' } };
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(transaction)), cipher.final(), cipher.getAuthTag()]).toString('base64');
  return JSON.stringify({ id: `fixture-${transactionId}`, event_type: 'TRANSACTION.SUCCESS', resource: { algorithm: 'AEAD_AES_256_GCM', original_type: 'transaction', ciphertext, nonce, associated_data: aad } });
}
function alipayNotice(orderId: string, overrides: Record<string, string> = {}) {
  const fields: Record<string, string> = { app_id: 'fixture-alipay-app', seller_id: 'fixture-seller', out_trade_no: orderId,
    trade_no: 'alipay-fixture-trade', total_amount: '168.00', trade_status: 'TRADE_SUCCESS', sign_type: 'RSA2', ...overrides };
  const message = Object.keys(fields).filter(k => k !== 'sign_type' && k !== 'sign').sort().map(k => `${k}=${fields[k]}`).join('&');
  fields.sign = sign('RSA-SHA256', Buffer.from(message), platformKeys.privateKey).toString('base64');
  return new URLSearchParams(fields).toString();
}

async function fixture(mode: 'merchant' | 'demo' = 'merchant') {
  let queryPaid = false;
  let badSignature = false;
  let signedRequests = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const target = new URL(String(input));
    assert.equal(target.origin, 'https://api.mch.weixin.qq.com');
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization')!;
    const timestamp = /timestamp="([^"]+)"/.exec(auth)![1];
    const nonce = /nonce_str="([^"]+)"/.exec(auth)![1];
    const signature = /signature="([^"]+)"/.exec(auth)![1];
    const body = String(init?.body || '');
    assert.equal(verify('RSA-SHA256', Buffer.from(`${init?.method}\n${target.pathname}${target.search}\n${timestamp}\n${nonce}\n${body}\n`), merchantKeys.publicKey, Buffer.from(signature, 'base64')), true);
    signedRequests++;
    if (body) { const payload = JSON.parse(body); assert.equal(payload.amount.total, 16800); assert.equal(payload.notify_url, `${origin}/api/payments/wechat/notify`); }
    const response = init?.method === 'POST' ? { code_url: 'weixin://wxpay/bizpayurl?pr=fixture' } : {
      appid: 'wx-fixture-app', mchid: 'fixture-mch', out_trade_no: target.pathname.split('/').at(-1), transaction_id: 'wx-query-trade',
      trade_state: queryPaid ? 'SUCCESS' : 'NOTPAY', amount: { total: 16800, currency: 'CNY' },
    };
    const text = JSON.stringify(response);
    const responseHeaders = wechatHeaders(text);
    if (badSignature) responseHeaders['wechatpay-signature'] = 'invalid';
    return new Response(text, { status: 200, headers: responseHeaders });
  };
  const sdk = new AlipaySdk({ appId: merchantConfig.alipay!.appId, privateKey: merchantKeys.privateKey, alipayPublicKey: platformKeys.publicKey, keyType: 'PKCS8', signType: 'RSA2', camelcase: false });
  sdk.exec = async (method, params, options) => {
    assert.equal(method, 'alipay.trade.query'); assert.equal(options?.validateSign, true);
    return { code: '10000', msg: 'Success', out_trade_no: params?.bizContent?.outTradeNo, trade_no: 'alipay-query-trade', total_amount: '168.00', trade_status: queryPaid ? 'TRADE_SUCCESS' : 'WAIT_BUYER_PAY' };
  };
  const service = new MerchantPayments(merchantConfig, fetcher, sdk);
  const database = await testDatabase();
  const { app, db } = await createApp({ ...database.config, origin, mode, adminPasswordHash, merchantPayments: service });
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const request = async (path: string, body?: unknown, method = 'POST', cookie = '') => {
    const res = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : method, headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { res, data: await res.json() };
  };
  const order = async () => {
    const { res, data } = await request('/orders', { planId: 'plus-month', email: 'merchant@example.com', contact: 'fixture-customer', consent: true });
    assert.equal(res.status, 201); return { orderId: data.order.id as string, accessCode: data.accessCode as string };
  };
  return { base, db, request, order, get signedRequests() { return signedRequests; }, set queryPaid(value: boolean) { queryPaid = value; }, set badSignature(value: boolean) { badSignature = value; },
    close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); await database.cleanup(); } };
}

test('merchant configuration never enables missing credentials, unreadable files or a non-HTTPS site', () => {
  const folder = mkdtempSync(join(tmpdir(), 'xiaoyuai-keys-'));
  try {
    const missing = loadMerchantConfig({}, 'http://localhost:5173');
    assert.equal(missing.statuses.every(s => !s.configured && s.missing.includes('APP_ORIGIN（可公开访问的 HTTPS 域名）')), true);
    writeFileSync(join(folder, 'private.pem'), merchantKeys.privateKey, { mode: 0o600 });
    writeFileSync(join(folder, 'public.pem'), platformKeys.publicKey, { mode: 0o600 });
    const env = { ALIPAY_APP_ID: 'fixture-app', ALIPAY_SELLER_ID: 'fixture-seller', ALIPAY_PRIVATE_KEY_PATH: join(folder, 'private.pem'), ALIPAY_PUBLIC_KEY_PATH: join(folder, 'public.pem') };
    assert.equal(loadMerchantConfig(env, origin).statuses.find(s => s.provider === 'alipay')!.configured, true);
    assert.equal(loadMerchantConfig({ ...env, ALIPAY_PRIVATE_KEY_PATH: join(folder, 'missing.pem') }, origin).statuses.find(s => s.provider === 'alipay')!.configured, false);
    assert.equal(yuanToCents('168.10'), 16810); assert.equal(yuanToCents('168'), 16800); assert.throws(() => yuanToCents('168.001')); assert.throws(() => yuanToCents('1e2'));
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('WeChat official Native request is signed; callbacks reject tampering and amount/account mismatches and are idempotent', async () => {
  const f = await fixture();
  try {
    const receipt = await f.order();
    const checkout = await f.request('/orders/checkout', { ...receipt, channel: 'wechat' });
    assert.equal(checkout.res.status, 200); assert.match(checkout.data.qrCode, /^weixin:/); assert.equal(f.signedRequests, 1);
    assert.equal((await f.request('/orders/checkout', { ...receipt, channel: 'alipay' })).res.status, 409);
    assert.equal((await f.request('/orders/demo-pay', receipt)).res.status, 404);
    const notify = async (raw: string, headers = wechatHeaders(raw)) => fetch(`${f.base}/payments/wechat/notify`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: raw });
    const raw = wechatNotice(receipt.orderId);
    assert.equal((await notify(raw, { ...wechatHeaders(raw), 'wechatpay-signature': 'invalid' })).status, 400);
    assert.equal((await notify(raw, wechatHeaders(raw, true))).status, 400);
    assert.equal((await notify(wechatNotice(receipt.orderId, 1))).status, 400);
    assert.equal((await notify(wechatNotice(receipt.orderId, 16800, 'wx-fixture-trade', 'foreign-app'))).status, 400);
    assert.equal((await f.request('/orders/lookup', receipt)).data.order.status, 'pending_payment');
    assert.equal((await notify(raw)).status, 204); assert.equal((await notify(raw)).status, 204);
    const paid = (await f.request('/orders/lookup', receipt)).data.order;
    assert.equal(paid.status, 'paid'); assert.equal(paid.events.length, 2); assert.equal(paid.paymentChannel, 'wechat');
    const other = await f.order(); await f.request('/orders/checkout', { ...other, channel: 'wechat' });
    assert.equal((await notify(wechatNotice(other.orderId))).status, 400);
    assert.equal((await f.request('/orders/lookup', other)).data.order.status, 'pending_payment');
    const login = await f.request('/admin/login', { password }); const cookie = login.res.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await f.request('/admin/orders', undefined, 'GET', cookie)).data.stats.revenue, 16800);
  } finally { await f.close(); }
});

test('Alipay PagePay URL contains a verifiable RSA2 signature; only authentic matching notifications mark an order paid', async () => {
  const f = await fixture();
  try {
    const receipt = await f.order();
    const { data, res } = await f.request('/orders/checkout', { ...receipt, channel: 'alipay' });
    assert.equal(res.status, 200);
    const url = new URL(data.url); assert.equal(url.hostname, 'openapi.alipay.com');
    const signed = Object.fromEntries(url.searchParams);
    const message = Object.keys(signed).filter(k => k !== 'sign').sort().map(k => `${k}=${signed[k]}`).join('&');
    assert.equal(verify('RSA-SHA256', Buffer.from(message), merchantKeys.publicKey, Buffer.from(signed.sign, 'base64')), true);
    assert.equal(JSON.parse(signed.biz_content).total_amount, '168.00');
    assert.equal(signed.notify_url, `${origin}/api/payments/alipay/notify`);
    assert.equal((await f.request('/orders/lookup', receipt)).data.order.status, 'pending_payment');
    const notify = async (body: string) => fetch(`${f.base}/payments/alipay/notify`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    assert.equal((await notify(alipayNotice(receipt.orderId, { total_amount: '1.00' }))).status, 400);
    assert.equal((await notify(alipayNotice(receipt.orderId, { seller_id: 'foreign-seller' }))).status, 400);
    assert.equal((await notify(alipayNotice(receipt.orderId).replace('sign=', 'sign=invalid'))).status, 400);
    const success = await notify(alipayNotice(receipt.orderId)); assert.equal(success.status, 200); assert.equal(await success.text(), 'success');
    assert.equal((await notify(alipayNotice(receipt.orderId))).status, 200);
    const paid = (await f.request('/orders/lookup', receipt)).data.order; assert.equal(paid.status, 'paid'); assert.equal(paid.events.length, 2);
  } finally { await f.close(); }
});

test('active reconciliation verifies official responses and cannot turn an unsigned response into payment', async () => {
  const f = await fixture();
  try {
    const receipt = await f.order(); await f.request('/orders/checkout', { ...receipt, channel: 'wechat' });
    assert.equal((await f.request('/orders/payment-status', receipt)).data.order.status, 'pending_payment');
    f.queryPaid = true; f.badSignature = true;
    assert.equal((await f.request('/orders/payment-status', receipt)).res.status, 400);
    assert.equal((await f.request('/orders/lookup', receipt)).data.order.status, 'pending_payment');
    f.badSignature = false;
    assert.equal((await f.request('/orders/payment-status', receipt)).data.order.status, 'paid');
    const alipayOrder = await f.order(); await f.request('/orders/checkout', { ...alipayOrder, channel: 'alipay' });
    assert.equal((await f.request('/orders/payment-status', alipayOrder)).data.order.status, 'paid');
  } finally { await f.close(); }
});

test('merchant mode with absent configuration closes new orders and never exposes a fake checkout', async () => {
  const database = await testDatabase();
  const { app, db } = await createApp({ ...database.config, origin: 'http://localhost:5173', mode: 'merchant', adminPasswordHash });
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  try {
    const catalog = await fetch(`${base}/catalog`).then(r => r.json()); assert.equal(catalog.paymentReady, false); assert.deepEqual(catalog.paymentChannels, []);
    const create = await fetch(`${base}/orders`, { method: 'POST', headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }, body: JSON.stringify({ planId: 'plus-month', email: 'fixture@example.com', contact: 'fixture-user', consent: true }) });
    assert.equal(create.status, 503); assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM orders').get<{ n: number }>())!.n), 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); await database.cleanup(); }
});

test('concurrent verified merchant callbacks credit an order once', async () => {
  const f = await fixture();
  try {
    const receipt = await f.order();
    await f.request('/orders/checkout', { ...receipt, channel: 'wechat' });
    const body = wechatNotice(receipt.orderId);
    const responses = await Promise.all(Array.from({ length: 4 }, () => fetch(`${f.base}/payments/wechat/notify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...wechatHeaders(body) }, body,
    })));
    assert.deepEqual(responses.map(r => r.status), [204, 204, 204, 204]);
    const result = (await f.request('/orders/lookup', receipt)).data.order;
    assert.equal(result.status, 'paid');
    assert.equal(result.events.filter((event: { status: string }) => event.status === 'paid').length, 1);
  } finally { await f.close(); }
});

test('simultaneous checkout requests cannot reserve different payment channels', async () => {
  const f = await fixture();
  try {
    const receipt = await f.order();
    const responses = await Promise.all(['wechat', 'alipay'].map(channel => f.request('/orders/checkout', { ...receipt, channel })));
    assert.deepEqual(responses.map(r => r.res.status).sort(), [200, 409]);
    const winner = responses.find(r => r.res.status === 200)!.data.channel;
    assert.equal((await f.request('/orders/lookup', receipt)).data.order.paymentChannel, winner);
  } finally { await f.close(); }
});

test('refund reconciliation checks signed WeChat replies, transaction binding and full amount; never creates a refund', async () => {
  let reply = { out_trade_no: 'XYREFUND', transaction_id: 'tx-original', out_refund_no: 'refund-request', refund_id: 'wx-refund', status: 'SUCCESS', amount: { total: 16800, refund: 16800, currency: 'CNY' } };
  let invalid = false;
  const service = new MerchantPayments(merchantConfig, async (url, init) => {
    assert.equal(init?.method, 'GET'); assert.match(String(url), /\/v3\/refund\/domestic\/refunds\/refund-request$/);
    const body = JSON.stringify(reply), headers = wechatHeaders(body);
    if (invalid) headers['wechatpay-signature'] = 'invalid';
    return new Response(body, { headers });
  });
  const order = { id: 'XYREFUND', amount: 16800, plan_name: 'Plus 月度', created_at: new Date().toISOString() };
  assert.equal((await service.queryRefund('wechat', order, 'tx-original', 'refund-request'))?.amount, 16800);
  invalid = true; await assert.rejects(() => service.queryRefund('wechat', order, 'tx-original', 'refund-request'), /签名/); invalid = false;
  reply = { ...reply, transaction_id: 'wrong-transaction' };
  await assert.rejects(() => service.queryRefund('wechat', order, 'tx-original', 'refund-request'), /不匹配/);
  reply = { ...reply, transaction_id: 'tx-original', status: 'PROCESSING' };
  assert.equal(await service.queryRefund('wechat', order, 'tx-original', 'refund-request'), null);
});

test('Alipay refund lookup requires signed responses, matching transaction and successful refund status', async () => {
  const sdk = new AlipaySdk({ appId: merchantConfig.alipay!.appId, privateKey: merchantKeys.privateKey, alipayPublicKey: platformKeys.publicKey, keyType: 'PKCS8', signType: 'RSA2', camelcase: false });
  let trade = 'ali-trade', status = 'REFUND_SUCCESS';
  sdk.exec = async (method, params, options) => {
    assert.equal(method, 'alipay.trade.fastpay.refund.query'); assert.equal(options?.validateSign, true);
    assert.equal(params?.bizContent?.outRequestNo, 'refund-ref');
    return { code: '10000', msg: 'Success', out_trade_no: 'XYREFUND', trade_no: trade, out_request_no: 'refund-ref', total_amount: '168.00', refund_amount: '168.00', refund_status: status };
  };
  const service = new MerchantPayments(merchantConfig, fetch, sdk);
  const order = { id: 'XYREFUND', amount: 16800, plan_name: 'Plus 月度', created_at: new Date().toISOString() };
  assert.equal((await service.queryRefund('alipay', order, trade, 'refund-ref'))?.amount, 16800);
  trade = 'another'; await assert.rejects(() => service.queryRefund('alipay', order, 'ali-trade', 'refund-ref'), /不匹配/);
  status = 'WAITING'; assert.equal(await service.queryRefund('alipay', order, trade, 'refund-ref'), null);
});
