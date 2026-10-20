import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import Stripe from 'stripe';
import { z } from 'zod';
import type { OrderRow } from './db.js';
import { openStore } from './store.js';
import { plans, statusLabels, type OrderStatus } from './catalog.js';
import { loadMerchantConfig, MerchantPayments, PaymentError, type MerchantChannel, type VerifiedPayment } from './merchant.js';
import { allowedOrigins } from './origins.js';
import { migrateCommerce } from './migrations.js';
import { VoucherVault } from './vouchers.js';
import { commerceService } from './commerce.js';
import { HttpError } from './http.js';

export interface Config {
  databasePath: string; origin: string; mode: 'demo' | 'stripe' | 'merchant'; adminPasswordHash: string;
  stripeSecret?: string; stripeWebhookSecret?: string; production?: boolean; serveStatic?: boolean;
  merchantPayments?: MerchantPayments;
  developmentApiPort?: number;
  databaseUrl?: string;
  trustProxyHops?: number;
  voucherSecret?: string;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();


export async function createApp(config: Config) {
  const db = await openStore({ path: config.databasePath, url: config.databaseUrl, production: config.production });
  let vault: VoucherVault | null = null;
  try {
    await migrateCommerce(db);
    vault = config.voucherSecret ? new VoucherVault(config.voucherSecret) : null;
    if (vault) await vault.verifyKey(db);
  } catch (error) { await db.close(); throw error; }
  const commerce = commerceService(db, vault, config.mode);
  // A failure to issue never erases a confirmed payment. The persistent queue retries it.
  const deliver = async (id: string) => { try { await commerce.issue(id); } catch { console.error('Voucher issuance deferred; compensation will retry.'); } };
  const app = express();
  if (config.trustProxyHops) app.set('trust proxy', config.trustProxyHops);
  const stripe = config.mode === 'stripe' && config.stripeSecret ? new Stripe(config.stripeSecret, { maxNetworkRetries: 2, timeout: 15000 }) : null;
  const merchant = config.merchantPayments || new MerchantPayments(loadMerchantConfig({}, config.origin));
  const paymentReady = config.mode === 'demo' || (config.mode === 'stripe' ? Boolean(stripe && config.stripeWebhookSecret) : merchant.channels.length > 0);
  const origin = new URL(config.origin).origin;
  const acceptedOrigins = allowedOrigins(origin, Boolean(config.production), config.developmentApiPort);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: config.production ? undefined : false, strictTransportSecurity: config.production ? undefined : false }));
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use('/api', rateLimit({ windowMs: 60000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: '请求较多，请稍后再试。' } }));

  const getOrder = (id: string) => db.prepare('SELECT * FROM orders WHERE id = ?').get<OrderRow>(id);
  const addEvent = (id: string, status: string, message: string, store = db) => store.prepare('INSERT INTO order_events(order_id,status,message,created_at) VALUES(?,?,?,?)').run(id, status, message, now());
  const merchantPayment = (id: string, store = db) => store.prepare('SELECT * FROM merchant_payments WHERE order_id=?').get<{ channel: MerchantChannel; transaction_id: string | null; qr_code: string | null }>(id);
  const serialize = async (row: OrderRow) => ({
    ...await commerce.summary(row.id),
    id: row.id, email: row.email, contact: row.contact, planId: row.plan_id, planName: row.plan_name,
    amount: row.amount, currency: row.currency, status: row.status, statusLabel: statusLabels[row.status],
    paymentMode: row.payment_mode, createdAt: row.created_at, updatedAt: row.updated_at,
    paymentChannel: (await merchantPayment(row.id))?.channel || null,
    events: await db.prepare('SELECT id,status,message,created_at AS "createdAt" FROM order_events WHERE order_id=? ORDER BY id').all(row.id),
  });

  const confirmMerchantPayment = async (payment: VerifiedPayment) => { await db.transaction(async tx => {
    const row = await tx.lockOrder(payment.orderId);
    const stored = row && await merchantPayment(row.id, tx);
    if (!row || row.payment_mode !== 'merchant' || !stored || stored.channel !== payment.channel || row.amount !== payment.amount || row.currency !== 'cny') throw new PaymentError('支付结果与订单金额或渠道不匹配。', 400);
    if (stored.transaction_id && stored.transaction_id !== payment.transactionId) throw new PaymentError('订单已有其他付款记录，请由运营核实。', 409);
    if (['cancelled', 'expired'].includes(row.status)) throw new PaymentError('已取消订单收到付款，请由运营核实。', 409);
    await tx.prepare('UPDATE merchant_payments SET transaction_id=? WHERE order_id=?').run(payment.transactionId, row.id);
    if (row.status === 'pending_payment') {
      await tx.prepare('UPDATE orders SET status=?,updated_at=? WHERE id=?').run('paid', now(), row.id);
      await addEvent(row.id, 'paid', `${payment.channel === 'wechat' ? '微信支付' : '支付宝'}付款已确认，卡密订单将自动发码；旧订单继续等待专人联系。`, tx);
    }
  }); await deliver(payment.orderId); };

  // Official merchant callbacks authenticate themselves; they do not use browser Origin/CSRF cookies.
  app.post('/api/payments/wechat/notify', express.raw({ type: 'application/json', limit: '64kb' }), async (req, res) => {
    if (config.mode !== 'merchant') { res.status(503).json({ code: 'FAIL', message: '收款通道未开放' }); return; }
    try {
      const headers = new Headers();
      for (const name of ['wechatpay-timestamp', 'wechatpay-nonce', 'wechatpay-signature', 'wechatpay-serial']) {
        if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name] as string);
      }
      const payment = merchant.verifyWechatNotification(req.body.toString('utf8'), headers);
      if (payment) await confirmMerchantPayment(payment);
      res.status(204).end();
    } catch (error) { res.status(error instanceof PaymentError ? error.status : 400).json({ code: 'FAIL', message: '通知校验或订单确认失败' }); }
  });
  app.post('/api/payments/alipay/notify', express.urlencoded({ extended: false, limit: '32kb', parameterLimit: 100 }), async (req, res) => {
    if (config.mode !== 'merchant') { res.status(503).send('failure'); return; }
    try {
      const payment = merchant.verifyAlipayNotification(req.body);
      if (payment) await confirmMerchantPayment(payment);
      res.type('text/plain').send('success');
    } catch (error) { res.status(error instanceof PaymentError ? error.status : 400).type('text/plain').send('failure'); }
  });

  // The webhook must receive the exact raw body before express.json().
  app.post('/api/payments/webhook', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
    if (!stripe || !config.stripeWebhookSecret) { res.status(503).json({ error: '支付回调尚未配置。' }); return; }
    let event: Stripe.Event;
    try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'] as string, config.stripeWebhookSecret); }
    catch { res.status(400).json({ error: '支付回调签名无效。' }); return; }
    try {
      await db.transaction(async tx => {
        const claimed = await tx.prepare('INSERT INTO webhook_events(id,created_at) VALUES(?,?) ON CONFLICT(id) DO NOTHING RETURNING id').get(event.id, now());
        if (!claimed) return;
        if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
          const session = event.data.object as Stripe.Checkout.Session;
          const row = await tx.lockOrder(session.metadata?.orderId || '');
          if (session.payment_status === 'paid') {
            if (!row || row.payment_mode !== 'stripe' || row.stripe_session !== session.id || session.amount_total !== row.amount || session.currency !== row.currency) {
              throw new Error('Payment does not match the stored order');
            }
            if (row.status === 'pending_payment') {
              await tx.prepare('UPDATE orders SET status=?,updated_at=? WHERE id=?').run('paid', now(), row.id);
              await addEvent(row.id, 'paid', '付款已确认，卡密订单将自动发码；旧订单继续等待专人联系。', tx);
            }
          }
        }
      });
      if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.metadata?.orderId) await deliver(session.metadata.orderId);
      }
      res.json({ received: true });
    } catch (error) {
      console.error('Webhook processing failed:', error instanceof Error ? error.message : 'unknown error');
      res.status(500).json({ error: '回调处理未完成，等待支付服务重试。' });
    }
  });

  app.use(express.json({ limit: '16kb' }));
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      // All browser mutations, including cookie-authenticated admin actions, require our configured origin.
      if (!req.headers.origin || !acceptedOrigins.has(req.headers.origin)) { next(new HttpError(403, '请求来源无效。')); return; }
    }
    next();
  });
  app.get('/api/health', async (_req, res) => {
    await db.prepare('SELECT 1').get();
    res.json({ status: 'ok', database: 'ok', databaseType: db.dialect, paymentMode: config.mode,
      paymentReady, voucherReady: Boolean(vault) });
  });
  app.get('/api/catalog', (_req, res) => res.json({ plans, paymentMode: config.mode, paymentReady: paymentReady && Boolean(vault), voucherReady: Boolean(vault), maxQuantity: 10, voucherValidityDays: 365, paymentChannels: config.mode === 'merchant' ? merchant.channels : [], currency: 'CNY' }));

  const createLimit = rateLimit({ windowMs: 15 * 60000, limit: 15, message: { error: '创建订单过于频繁，请稍后再试。' } });
  app.post('/api/orders', createLimit, async (req, res) => {
    const input = z.object({ planId: z.string(), email: z.email().max(254), contact: z.string().trim().min(2).max(100), consent: z.literal(true), quantity: z.number().int().min(1).max(10).default(1) }).parse(req.body);
    const plan = plans.find(p => p.id === input.planId);
    if (!plan) throw new HttpError(400, '套餐不存在，请重新选择。');
    if (!vault) throw new HttpError(503, '卡密服务尚未配置，请稍后购买。');
    if (!paymentReady) throw new HttpError(503, '收款配置尚未完成，暂时不能创建订单。');
    const id = `XY${new Date().toISOString().slice(0, 10).replaceAll('-', '')}${randomBytes(5).toString('hex').toUpperCase()}`;
    const accessCode = randomBytes(8).toString('hex').toUpperCase();
    const time = now();
    await db.transaction(async tx => {
      await tx.prepare('INSERT INTO orders(id,access_hash,email,contact,plan_id,plan_name,amount,payment_mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, hash(accessCode), input.email.toLowerCase(), input.contact, plan.id, plan.name, plan.price * input.quantity, config.mode, time, time);
      await tx.prepare('INSERT INTO purchase_orders(order_id,quantity,unit_price,service_period,validity_days,created_at) VALUES(?,?,?,?,?,?)').run(id, input.quantity, plan.price, plan.period, 365, time);
      await addEvent(id, 'pending_payment', config.mode === 'demo' ? '演示订单已创建，模拟付款不会扣款，也不会实际开通订阅。' : '订单已创建，请完成付款。', tx);
    });
    res.status(201).json({ order: await serialize((await getOrder(id))!), accessCode });
  });

  const lookupLimit = rateLimit({ windowMs: 15 * 60000, limit: 50, message: { error: '查询尝试过多，请稍后再试。' } });
  const authenticateOrder = async (body: unknown) => {
    const input = z.object({ orderId: z.string().max(64), accessCode: z.string().min(1).max(64) }).parse(body);
    const row = await getOrder(input.orderId.toUpperCase());
    if (!row || !timingSafeEqual(Buffer.from(row.access_hash, 'hex'), Buffer.from(hash(input.accessCode.toUpperCase()), 'hex'))) {
      throw new HttpError(404, '订单号或查询码不正确，请检查后重试。');
    }
    return row;
  };
  app.post('/api/orders/lookup', lookupLimit, async (req, res) => res.json({ order: await serialize(await authenticateOrder(req.body)) }));
  app.post('/api/orders/checkout', lookupLimit, async (req, res) => {
    const row = await authenticateOrder(req.body);
    if (row.status !== 'pending_payment') throw new HttpError(409, '当前订单无需再次付款。');
    if (Date.now() - Date.parse(row.created_at) > 24 * 60 * 60000) throw new HttpError(409, '订单已超时，请重新下单。');
    if (row.payment_mode !== config.mode) throw new HttpError(409, '当前收款方式已调整，请重新创建订单。');
    if (row.payment_mode === 'demo') { res.json({ mode: 'demo' }); return; }
    if (row.payment_mode === 'merchant') {
      const { channel } = z.object({ channel: z.enum(['wechat', 'alipay']) }).parse(req.body);
      if (!merchant.channels.some(c => c.id === channel)) throw new PaymentError('所选支付方式尚未开通。');
      const stored = await db.transaction(async tx => {
        const current = await tx.lockOrder(row.id);
        if (current?.status !== 'pending_payment') throw new HttpError(409, '订单状态已变化，请刷新后重试。');
        const pinned = await merchantPayment(row.id, tx);
        if (pinned && pinned.channel !== channel) throw new HttpError(409, '此订单已发起其他渠道付款，请继续使用原支付方式，避免重复付款。');
        await tx.prepare('INSERT INTO merchant_payments(order_id,channel,created_at) VALUES(?,?,?) ON CONFLICT(order_id) DO NOTHING').run(row.id, channel, now());
        return pinned;
      });
      if (stored?.qr_code) { res.json({ mode: 'merchant', channel, qrCode: stored.qr_code }); return; }
      const checkout = await merchant.checkout(channel, row);
      if (checkout.qrCode) await db.prepare('UPDATE merchant_payments SET qr_code=? WHERE order_id=?').run(checkout.qrCode, row.id);
      res.json(checkout); return;
    }
    if (!stripe || !config.stripeWebhookSecret) throw new HttpError(503, '支付服务尚未配置完成。');
    if (row.stripe_session) {
      const previous = await stripe.checkout.sessions.retrieve(row.stripe_session);
      if (previous.status === 'open') { res.json({ mode: 'stripe', url: previous.url }); return; }
      if (previous.status === 'complete') throw new HttpError(409, '支付结果正在确认，请稍后刷新订单。');
    }
    // Reserve before the network call so an administrator cannot cancel while a
    // payable session is being created. An interrupted request reuses its key.
    const attempt = await db.transaction(async tx => {
      const current = await tx.lockOrder(row.id);
      if (current?.status !== 'pending_payment') throw new HttpError(409, '订单状态已变化，请刷新后重试。');
      if (current.stripe_session && current.stripe_session !== row.stripe_session) throw new HttpError(409, '支付会话正在更新，请稍后重试。');
      const nextAttempt = current.stripe_session ? current.payment_attempt + 1 : Math.max(1, current.payment_attempt);
      await tx.prepare('UPDATE orders SET payment_attempt=?,stripe_session=NULL,checkout_url=NULL WHERE id=?').run(nextAttempt, row.id);
      return nextAttempt;
    });
    const session = await stripe.checkout.sessions.create({
      mode: 'payment', payment_method_types: ['card'], customer_email: row.email,
      client_reference_id: row.id, metadata: { orderId: row.id },
      line_items: [{ quantity: 1, price_data: { currency: row.currency, unit_amount: row.amount, product_data: { name: `xiaoyu AI · ${row.plan_name}开通协助` } } }],
      success_url: `${origin}/?payment=success&order=${encodeURIComponent(row.id)}`,
      cancel_url: `${origin}/?payment=cancelled&order=${encodeURIComponent(row.id)}`,
    }, { idempotencyKey: `${row.id}-attempt-${attempt}` });
    await db.prepare('UPDATE orders SET stripe_session=?,checkout_url=?,payment_attempt=? WHERE id=? AND status=?')
      .run(session.id, session.url, attempt, row.id, 'pending_payment');
    res.json({ mode: 'stripe', url: session.url });
  });
  app.post('/api/orders/demo-pay', lookupLimit, async (req, res) => {
    const row = await authenticateOrder(req.body);
    if (config.mode !== 'demo' || row.payment_mode !== 'demo') throw new HttpError(404, '此功能仅用于演示。');
    await db.transaction(async tx => {
      const current = await tx.lockOrder(row.id);
      if (current?.status !== 'pending_payment') throw new HttpError(409, '订单已付款或已取消。');
      if (Date.now() - Date.parse(current.created_at) > 86400000) throw new HttpError(409, '订单已过期，请重新下单。');
      await tx.prepare('UPDATE orders SET status=?,updated_at=? WHERE id=?').run('paid', now(), row.id);
      await addEvent(row.id, 'paid', '模拟付款成功（未实际扣款）。等待管理员演示处理。', tx);
    });
    await deliver(row.id);
    res.json({ order: await serialize((await getOrder(row.id))!) });
  });
  app.post('/api/orders/payment-status', rateLimit({ windowMs: 60000, limit: 20, message: { error: '查询过于频繁，请稍后刷新。' } }), async (req, res) => {
    const row = await authenticateOrder(req.body);
    const stored = await merchantPayment(row.id);
    if (config.mode === 'merchant' && row.payment_mode === 'merchant' && row.status === 'pending_payment' && stored) {
      const payment = await merchant.query(stored.channel, row.id);
      if (payment) await confirmMerchantPayment(payment);
    }
    res.json({ order: await serialize((await getOrder(row.id))!) });
  });

  commerce.publicRoutes(app, authenticateOrder);

  const adminAuth = async (req: Request, _res: Response, next: NextFunction) => {
    const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('xy_admin='))?.slice(9);
    await db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(Date.now());
    if (!token || !await db.prepare('SELECT token_hash FROM admin_sessions WHERE token_hash=? AND expires_at>?').get(hash(token), Date.now())) {
      next(new HttpError(401, '请先登录管理后台。')); return;
    }
    next();
  };
  app.post('/api/admin/login', rateLimit({ windowMs: 15 * 60000, limit: 8, message: { error: '登录尝试过多，请稍后再试。' } }), async (req, res) => {
    const { password } = z.object({ password: z.string().min(1).max(256) }).parse(req.body);
    const [salt, expected] = config.adminPasswordHash.split(':');
    if (!salt || !expected || !/^[0-9a-f]{128}$/.test(expected)) throw new HttpError(503, '请先运行 npm run setup 配置管理员。');
    if (!timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(expected, 'hex'))) throw new HttpError(401, '管理密码不正确。');
    const token = randomBytes(32).toString('hex');
    await db.prepare('INSERT INTO admin_sessions(token_hash,expires_at) VALUES(?,?)').run(hash(token), Date.now() + 8 * 60 * 60000);
    res.cookie('xy_admin', token, { httpOnly: true, sameSite: 'strict', secure: Boolean(config.production), maxAge: 8 * 60 * 60000, path: '/api/admin' });
    res.json({ ok: true });
  });
  app.use('/api/admin', adminAuth);
  commerce.adminRoutes(app, async (order, reference) => {
    if (order.payment_mode === 'merchant') {
      const stored = await merchantPayment(order.id);
      if (!stored?.transaction_id) throw new HttpError(409, '缺少原支付交易号。');
      return merchant.queryRefund(stored.channel, order, stored.transaction_id, reference);
    }
    if (order.payment_mode === 'stripe' && stripe && order.stripe_session) {
      const session = await stripe.checkout.sessions.retrieve(order.stripe_session);
      const refund = await stripe.refunds.retrieve(reference);
      if (refund.status !== 'succeeded') return null;
      const intent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
      if (!intent || refund.payment_intent !== intent || refund.currency !== order.currency) throw new HttpError(409, '退款交易与原订单不匹配。');
      return { orderId: order.id, amount: refund.amount, reference: `stripe:${refund.id}` };
    }
    throw new HttpError(503, '对应退款查询通道不可用，权益将保持冻结。');
  });
  app.get('/api/admin/payment-settings', (_req, res) => res.json({ mode: config.mode, ready: paymentReady,
    channels: merchant.config.statuses, verification: 'configuration-only',
    note: '配置齐全仅代表可发起真实支付；商户签约、回调公网可达性与真实到账仍需联调验证。' }));
  app.post('/api/admin/logout', async (req, res) => {
    const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('xy_admin='))?.slice(9);
    if (token) await db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(hash(token));
    res.clearCookie('xy_admin', { path: '/api/admin', httpOnly: true, sameSite: 'strict', secure: Boolean(config.production) });
    res.json({ ok: true });
  });
  app.get('/api/admin/orders', async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 100).trim() : '';
    const page = Math.max(1, Math.min(10000, Math.floor(Number(req.query.page) || 1)));
    const filter = z.object({ plan: z.string().max(40).default(''), from: z.string().default(''), to: z.string().default('') }).parse(req.query);
    const since = filter.from ? z.iso.date().parse(filter.from) + 'T00:00:00.000Z' : '';
    const until = filter.to ? z.iso.date().parse(filter.to) + 'T23:59:59.999Z' : '';
    const where = `WHERE (?='' OR status=?) AND (?='' OR lower(id) LIKE ? ESCAPE '!' OR lower(email) LIKE ? ESCAPE '!') AND (?='' OR plan_id=?) AND (?='' OR created_at>=?) AND (?='' OR created_at<=?)`;
    const pattern = `%${search.toLowerCase().replace(/[!%_]/g, '!$&')}%`;
    const args = [status, status, search, pattern, pattern, filter.plan, filter.plan, since, since, until, until];
    const rows = await db.prepare(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT 20 OFFSET ?`).all<OrderRow>(...args, (page - 1) * 20);
    const total = Number((await db.prepare(`SELECT COUNT(*) AS count FROM orders ${where}`).get(...args))!.count);
    const rawStats = (await db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) AS waiting,
      SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END) AS processing,
      COALESCE(SUM(CASE WHEN payment_mode IN ('stripe','merchant') AND status IN ('paid','processing','completed','refund_pending') THEN amount ELSE 0 END),0) AS revenue FROM orders`).get())!;
    const stats = Object.fromEntries(Object.entries(rawStats).map(([key, value]) => [key, Number(value || 0)]));
    res.json({ orders: await Promise.all(rows.map(serialize)), total, page, stats });
  });
  app.patch('/api/admin/orders/:id', async (req, res) => {
    const input = z.object({ status: z.enum(['processing', 'completed', 'cancelled']), note: z.string().trim().min(2).max(1000) }).parse(req.body);
    const id = String(req.params.id);
    await db.transaction(async tx => {
      const row = await tx.lockOrder(id);
      if (!row) throw new HttpError(404, '订单不存在。');
      if (await commerce.purchase(row.id, tx) && input.status !== 'cancelled') throw new HttpError(409, '请在兑换单中处理履约，支付订单不能直接完成开通。');
      const transitions: Record<OrderStatus, string[]> = { pending_payment: ['cancelled'], paid: ['processing'], processing: ['processing', 'completed'], completed: [], cancelled: [], expired: [], refund_pending: [], refunded: [] };
      if (!transitions[row.status].includes(input.status)) throw new HttpError(409, '当前状态不允许此操作，请刷新订单。');
      if (input.status === 'cancelled' && (row.stripe_session || row.payment_attempt > 0 || await merchantPayment(row.id, tx))) throw new HttpError(409, '已发起支付会话的订单不能直接取消，请先在支付服务商后台处理。');
      await tx.prepare('UPDATE orders SET status=?,updated_at=? WHERE id=?').run(input.status, now(), row.id);
      await addEvent(row.id, input.status, input.note, tx);
    });
    res.json({ order: await serialize((await getOrder(id))!) });
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在。' }));
  if (config.serveStatic && existsSync(resolve('dist/index.html'))) {
    app.use(express.static(resolve('dist'), { maxAge: '1h', index: false }));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
  }
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) { res.status(400).json({ error: '请检查填写内容：邮箱、联系方式和服务条款为必填项。' }); return; }
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof PaymentError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof SyntaxError && 'body' in error) { res.status(400).json({ error: '请求格式不正确。' }); return; }
    console.error('Request failed; sensitive request and database details suppressed.');
    res.status(500).json({ error: '服务暂时不可用，请稍后重试。' });
  });
  return { app, db, compensate: commerce.compensate };
}
