import type { Express, Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Store } from './store.js';
import type { OrderRow } from './db.js';
import { HttpError } from './http.js';
import { audit, digest, effectiveStatus, identifier, normalizeCode, now, VoucherVault, voucherLabels, type VoucherRow, type PurchaseRow } from './vouchers.js';
import { fulfillmentInfo, fulfillmentTransitions, redemptionLabels, type RedemptionStatus } from './fulfillment.js';

export interface RedemptionRow { id: string; voucher_id: string; order_id: string; access_hash: string; target_email: string; contact: string; status: RedemptionStatus; assignee: string | null; delivery_reference: string | null; created_at: string; updated_at: string }
export interface RefundProof { reference: string; amount: number; orderId: string }
const actor = (req: Request) => 'admin:' + digest(req.headers.cookie || '').slice(0, 12);
const maskEmail = (email: string) => email.replace(/^(.).*(@.*)$/, '$1***$2');
const noteSchema = z.string().trim().min(2).max(500);
const credentialsSchema = z.object({ id: z.string().min(1).max(64), accessCode: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const redeemSchema = z.object({ code: z.string().min(1).max(100), targetEmail: z.email().max(254), contact: z.string().trim().min(2).max(100), consent: z.literal(true), requestKey: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export function commerceService(db: Store, vault: VoucherVault | null, mode: string) {
  const purchase = (id: string, tx = db) => tx.prepare('SELECT * FROM purchase_orders WHERE order_id=?').get<PurchaseRow>(id);
  const voucher = (id: string, tx = db) => tx.prepare('SELECT * FROM vouchers WHERE id=?').get<VoucherRow>(id);
  const redemption = (id: string, tx = db) => tx.prepare('SELECT * FROM redemptions WHERE id=?').get<RedemptionRow>(id);
  async function findCode(body: unknown) {
    const { code } = z.object({ code: z.string().min(1).max(100) }).parse(body);
    const normalized = normalizeCode(code);
    const row = normalized && await db.prepare('SELECT * FROM vouchers WHERE code_hash=?').get<VoucherRow>(digest(normalized));
    if (!row) throw new HttpError(404, '卡密无效，请检查后重试。');
    return row;
  }
  function assertMode(order: OrderRow) {
    if ((order.payment_mode === 'demo') !== (mode === 'demo')) throw new HttpError(409, '演示与真实服务互相隔离，请使用对应环境。');
  }
  async function serializeRedemption(r: RedemptionRow, admin = false) {
    const order = (await db.prepare('SELECT * FROM orders WHERE id=?').get<OrderRow>(r.order_id))!;
    const p = await purchase(r.order_id);
    return { id: r.id, orderId: r.order_id, voucherId: r.voucher_id, targetEmail: admin ? r.target_email : maskEmail(r.target_email),
      ...(admin ? { contact: r.contact, assignee: r.assignee } : {}), status: r.status, statusLabel: redemptionLabels[r.status as RedemptionStatus],
      planId: order.plan_id, planName: order.plan_name, servicePeriod: p?.service_period, paymentMode: order.payment_mode,
      deliveryReference: r.delivery_reference, createdAt: r.created_at, updatedAt: r.updated_at,
      events: await db.prepare("SELECT id,action,message,created_at AS \"createdAt\" FROM commerce_events WHERE redemption_id=? AND action NOT LIKE 'view_%' ORDER BY created_at,id").all(r.id) };
  }
  async function summary(orderId: string) {
    const p = await purchase(orderId);
    if (!p) return { flow: 'legacy' as const };
    const vs = await db.prepare('SELECT * FROM vouchers WHERE order_id=? ORDER BY ordinal').all<VoucherRow>(orderId);
    return { flow: 'voucher' as const, quantity: p.quantity, servicePeriod: p.service_period, validityDays: p.validity_days,
      issuedCount: vs.length, vouchers: vs.map(v => ({ id: v.id, ordinal: v.ordinal, status: effectiveStatus(v), statusLabel: voucherLabels[effectiveStatus(v)], expiresAt: v.expires_at })) };
  }
  async function issue(orderId: string) {
    if (!vault) return false;
    await db.transaction(async tx => { const order = await tx.lockOrder(orderId); if (order) await vault.issue(tx, order); });
    return true;
  }
  async function compensate() {
    const rows = await db.prepare("SELECT o.id FROM orders o JOIN purchase_orders p ON p.order_id=o.id WHERE o.status='paid' AND (SELECT COUNT(*) FROM vouchers v WHERE v.order_id=o.id)<p.quantity ORDER BY o.created_at LIMIT 50").all<{ id: string }>();
    let repaired = 0;
    for (const row of rows) { try { if (await issue(row.id)) repaired++; } catch { /* Paid order remains queued; next run retries. */ } }
    const expiring = await db.prepare("SELECT * FROM vouchers WHERE status='available' AND expires_at<=? LIMIT 100").all<VoucherRow>(now());
    for (const candidate of expiring) await db.transaction(async tx => {
      await tx.lockOrder(candidate.order_id);
      const v = (await voucher(candidate.id, tx))!;
      if (v.status !== 'available' || v.expires_at > now()) return;
      await tx.prepare("UPDATE vouchers SET status='expired' WHERE id=?").run(v.id);
      await audit(tx, v.order_id, 'expired', 'system', '未兑换卡密已超过兑换有效期。', v.id);
    });
    // Only expire orders for which no payable external session was ever created.
    await db.transaction(async tx => {
      const pending = await tx.prepare("SELECT o.id FROM orders o JOIN purchase_orders p ON o.id=p.order_id WHERE o.status='pending_payment' AND o.created_at<? AND o.payment_attempt=0 AND o.stripe_session IS NULL AND NOT EXISTS(SELECT 1 FROM merchant_payments m WHERE m.order_id=o.id) LIMIT 50").all<{ id: string }>(new Date(Date.now() - 86400000).toISOString());
      for (const p of pending) {
        const row = await tx.lockOrder(p.id);
        if (!row || row.status !== 'pending_payment' || row.payment_attempt || row.stripe_session || await tx.prepare('SELECT order_id FROM merchant_payments WHERE order_id=?').get(row.id)) continue;
        await tx.prepare("UPDATE orders SET status='expired',updated_at=? WHERE id=?").run(now(), row.id);
        await tx.prepare('INSERT INTO order_events(order_id,status,message,created_at) VALUES(?,?,?,?)').run(row.id, 'expired', '未发起支付的订单已过期，请重新购买。', now());
      }
    });
    return { examined: rows.length, repaired, pending: rows.length - repaired };
  }
  function publicRoutes(app: Express, authenticateOrder: (body: unknown) => Promise<OrderRow>) {
    const limit = rateLimit({ windowMs: 15 * 60000, limit: 60, message: { error: '卡密或兑换查询过于频繁，请稍后再试。' } });
    app.post('/api/orders/vouchers', limit, async (req, res) => {
      const authenticated = await authenticateOrder(req.body);
      if (!vault) throw new HttpError(503, '卡密展示服务暂不可用，请稍后重试。');
      const codes = await db.transaction(async tx => {
        const order = (await tx.lockOrder(authenticated.id))!;
        const rows = await tx.prepare('SELECT * FROM vouchers WHERE order_id=? ORDER BY ordinal').all<VoucherRow>(order.id);
        if (order.status !== 'paid') return [];
        const available = rows.filter(v => effectiveStatus(v) === 'available');
        await audit(tx, order.id, 'view_codes', 'customer', '客户通过订单凭据查看可兑换卡密。');
        return available.map(v => ({ id: v.id, ordinal: v.ordinal, code: vault.decrypt(v), expiresAt: v.expires_at }));
      });
      res.json({ vouchers: codes });
    });
    app.post('/api/vouchers/check', limit, async (req, res) => {
      const v = await findCode(req.body);
      const order = (await db.prepare('SELECT * FROM orders WHERE id=?').get<OrderRow>(v.order_id))!;
      assertMode(order);
      const p = (await purchase(order.id))!;
      res.json({ planName: order.plan_name, servicePeriod: p.service_period, paymentMode: order.payment_mode,
        status: effectiveStatus(v), statusLabel: voucherLabels[effectiveStatus(v)], expiresAt: v.expires_at,
        redeemable: order.status === 'paid' && effectiveStatus(v) === 'available' });
    });
    app.post('/api/vouchers/redeem', limit, async (req, res) => {
      const input = redeemSchema.parse(req.body), found = await findCode(input);
      const r = await db.transaction(async tx => {
        const order = (await tx.lockOrder(found.order_id))!;
        assertMode(order);
        const existing = await tx.prepare('SELECT * FROM redemptions WHERE voucher_id=?').get<RedemptionRow>(found.id);
        if (existing) {
          if (existing.access_hash === digest(input.requestKey) && existing.target_email === input.targetEmail.toLowerCase() && existing.contact === input.contact) return existing;
          throw new HttpError(409, '此卡密已提交兑换，请使用原兑换凭据查询。');
        }
        const v = (await voucher(found.id, tx))!;
        if (order.status !== 'paid' || effectiveStatus(v) !== 'available') throw new HttpError(409, '当前卡密不可兑换，请查看卡密状态或联系售后。');
        const id = identifier('XR'), time = now();
        await tx.prepare('INSERT INTO redemptions(id,voucher_id,order_id,access_hash,target_email,contact,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(id, v.id, order.id, digest(input.requestKey), input.targetEmail.toLowerCase(), input.contact, 'pending', time, time);
        await tx.prepare("UPDATE vouchers SET status='reserved' WHERE id=?").run(v.id);
        await audit(tx, order.id, 'pending', 'customer', order.payment_mode === 'demo' ? '演示兑换已提交，进入人工演示队列；不会开通真实订阅。' : '兑换申请已提交，进入人工履约队列，尚未完成开通。', v.id, id);
        return (await redemption(id, tx))!;
      });
      res.json({ redemption: await serializeRedemption(r) });
    });
    app.post('/api/redemptions/recover', limit, async (req, res) => {
      const input = z.object({ code: z.string().min(1).max(100), accessCode: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body);
      const v = await findCode(input);
      const r = await db.prepare('SELECT * FROM redemptions WHERE voucher_id=? AND access_hash=?').get<RedemptionRow>(v.id, digest(input.accessCode));
      if (!r) throw new HttpError(404, '没有找到与本次请求凭据关联的兑换单。');
      res.json({ redemption: await serializeRedemption(r) });
    });
    app.post('/api/redemptions/lookup', limit, async (req, res) => {
      const input = credentialsSchema.parse(req.body);
      const r = await db.prepare('SELECT * FROM redemptions WHERE id=? AND access_hash=?').get<RedemptionRow>(input.id.toUpperCase(), digest(input.accessCode));
      if (!r) throw new HttpError(404, '兑换编号或查询码不正确。');
      res.json({ redemption: await serializeRedemption(r) });
    });
  }
  function adminRoutes(app: Express, verifyRefund: (order: OrderRow, reference: string) => Promise<RefundProof | null>) {
    app.get('/api/admin/fulfillment-settings', (_req, res) => res.json({ ...fulfillmentInfo, voucherReady: Boolean(vault), missing: vault ? [] : ['VOUCHER_SECRET（64 位十六进制随机密钥）'] }));
    app.post('/api/admin/vouchers/compensate', async (_req, res) => { if (!vault) throw new HttpError(503, '请先配置 VOUCHER_SECRET。'); res.json(await compensate()); });
    app.get('/api/admin/commerce', async (req, res) => {
      const input = z.object({ kind: z.enum(['vouchers', 'redemptions']).default('redemptions'), search: z.string().max(100).default(''), status: z.string().max(30).default(''), plan: z.string().max(40).default(''), from: z.string().default(''), to: z.string().default(''), page: z.coerce.number().int().min(1).max(10000).default(1) }).parse(req.query);
      const { kind, status, plan, page } = input;
      const since = input.from ? z.iso.date().parse(input.from) + 'T00:00:00.000Z' : '';
      const until = input.to ? z.iso.date().parse(input.to) + 'T23:59:59.999Z' : '';
      const pattern = `%${input.search.toLowerCase().replace(/[!%_]/g, '!$&')}%`;
      const selectStatus = kind === 'vouchers' ? `CASE WHEN t.status='available' AND t.expires_at<='${now()}' THEN 'expired' ELSE t.status END` : 't.status';
      const where = `WHERE (?='' OR ${selectStatus}=?) AND (?='' OR o.plan_id=?) AND (?='' OR t.created_at>=?) AND (?='' OR t.created_at<=?) AND (?='' OR lower(t.id) LIKE ? ESCAPE '!' OR lower(o.id) LIKE ? ESCAPE '!')`;
      const args = [status, status, plan, plan, since, since, until, until, input.search, pattern, pattern];
      // kind is an enum, all user-supplied filter values are bound parameters.
      const total = Number((await db.prepare(`SELECT COUNT(*) AS n FROM ${kind} t JOIN orders o ON o.id=t.order_id ${where}`).get<{ n: number }>(...args))!.n);
      const rows = await db.prepare(`SELECT t.*,o.plan_name,o.plan_id,o.payment_mode FROM ${kind} t JOIN orders o ON o.id=t.order_id ${where} ORDER BY t.created_at DESC,t.id LIMIT 20 OFFSET ?`).all<(VoucherRow | RedemptionRow) & { plan_name: string; plan_id: string; payment_mode: string }>(...args, (page - 1) * 20);
      res.json({ total, page, items: rows.map(r => ({ id: r.id, orderId: r.order_id, planId: r.plan_id, planName: r.plan_name, paymentMode: r.payment_mode, createdAt: r.created_at,
        ...(kind === 'vouchers' ? { status: effectiveStatus(r as VoucherRow), statusLabel: voucherLabels[effectiveStatus(r as VoucherRow)], ordinal: (r as VoucherRow).ordinal, expiresAt: (r as VoucherRow).expires_at } : { status: r.status, statusLabel: redemptionLabels[r.status as RedemptionStatus], targetEmail: maskEmail((r as RedemptionRow).target_email), voucherId: (r as RedemptionRow).voucher_id }) })) });
    });
    app.get('/api/admin/commerce/:kind/:id', async (req, res) => {
      const kind = z.enum(['vouchers', 'redemptions']).parse(req.params.kind), id = String(req.params.id);
      if (kind === 'redemptions') {
        const r = await redemption(id); if (!r) throw new HttpError(404, '兑换单不存在。');
        await audit(db, r.order_id, 'view_redemption', actor(req), '管理员查看履约联系信息。', r.voucher_id, id);
        res.json({ item: await serializeRedemption(r, true) });
      } else {
        const v = await voucher(id); if (!v) throw new HttpError(404, '卡密不存在。');
        const r = await db.prepare('SELECT id FROM redemptions WHERE voucher_id=?').get<{ id: string }>(id);
        res.json({ item: { id, orderId: v.order_id, status: effectiveStatus(v), statusLabel: voucherLabels[effectiveStatus(v)], expiresAt: v.expires_at, redemptionId: r?.id || null,
          events: await db.prepare('SELECT action,actor,message,created_at AS "createdAt" FROM commerce_events WHERE voucher_id=? ORDER BY created_at,id').all(id) } });
      }
    });
    app.patch('/api/admin/vouchers/:id', async (req, res) => {
      const input = z.object({ action: z.enum(['freeze', 'unfreeze', 'void']), note: noteSchema }).strict().parse(req.body);
      const found = await voucher(String(req.params.id)); if (!found) throw new HttpError(404, '卡密不存在。');
      await db.transaction(async tx => {
        const order = (await tx.lockOrder(found.order_id))!;
        const v = (await voucher(found.id, tx))!;
        if (order.status !== 'paid') throw new HttpError(409, '该订单当前不允许修改卡密。');
        if (await tx.prepare('SELECT id FROM redemptions WHERE voucher_id=?').get(v.id)) throw new HttpError(409, '已有兑换记录的卡密不能重新激活，请处理原兑换单或退款。');
        const status = effectiveStatus(v);
        const allowed = input.action === 'freeze' ? ['available'] : input.action === 'unfreeze' ? ['frozen'] : ['available', 'frozen', 'expired'];
        if (!allowed.includes(status)) throw new HttpError(409, '已占用或已交付的权益不能作废或重新激活，请处理对应兑换单。');
        const next = input.action === 'void' ? 'void' : input.action === 'freeze' ? 'frozen' : v.expires_at <= now() ? 'expired' : 'available';
        await tx.prepare('UPDATE vouchers SET status=? WHERE id=?').run(next, v.id);
        await audit(tx, v.order_id, input.action, actor(req), input.note, v.id);
      });
      res.json({ ok: true });
    });
    app.patch('/api/admin/redemptions/:id', async (req, res) => {
      const input = z.object({ status: z.enum(['pending', 'processing', 'completed', 'failed', 'review', 'cancelled']), expectedStatus: z.enum(['pending', 'processing', 'completed', 'failed', 'review', 'cancelled']), note: noteSchema, assignee: z.string().trim().max(80).optional(), deliveryReference: z.string().trim().max(160).optional(), confirmed: z.boolean().optional() }).strict().parse(req.body);
      const found = await redemption(String(req.params.id)); if (!found) throw new HttpError(404, '兑换单不存在。');
      await db.transaction(async tx => {
        const order = (await tx.lockOrder(found.order_id))!;
        assertMode(order);
        const r = (await redemption(found.id, tx))!, v = (await voucher(r.voucher_id, tx))!;
        if (order.status !== 'paid' || v.status !== 'reserved' || r.status !== input.expectedStatus || !fulfillmentTransitions[r.status].includes(input.status)) throw new HttpError(409, '状态已变化或不允许此操作，请刷新后重试。');
        if (input.status === 'processing' && !input.assignee?.trim() && !r.assignee) throw new HttpError(400, '开始处理时需填写负责人。');
        if ((input.status === 'completed' || (r.status === 'review' && input.status === 'failed')) && (!input.confirmed || !input.deliveryReference?.trim())) throw new HttpError(400, '请核实外部处理结果并填写可追溯的凭据编号。');
        const time = now();
        await tx.prepare('UPDATE redemptions SET status=?,assignee=?,delivery_reference=?,updated_at=? WHERE id=?')
          .run(input.status, input.assignee || r.assignee, input.deliveryReference || r.delivery_reference, time, r.id);
        if (input.status === 'completed') await tx.prepare("UPDATE vouchers SET status='redeemed' WHERE id=?").run(v.id);
        if (input.status === 'cancelled') await tx.prepare("UPDATE vouchers SET status='frozen' WHERE id=?").run(v.id);
        await audit(tx, order.id, input.status, actor(req), input.note, v.id, r.id);
      });
      res.json({ redemption: await serializeRedemption((await redemption(found.id))!, true) });
    });
    app.post('/api/admin/orders/:id/refund-request', async (req, res) => {
      const { note } = z.object({ note: noteSchema }).strict().parse(req.body);
      const id = String(req.params.id);
      await db.transaction(async tx => {
        const order = await tx.lockOrder(id);
        if (!order || !await purchase(id, tx)) throw new HttpError(409, '仅新卡密订单支持此退款流程，旧订单请人工对账。');
        assertMode(order);
        if (order.status === 'refund_pending') return;
        if (order.status !== 'paid') throw new HttpError(409, '当前订单不能申请退款。');
        if (await tx.prepare("SELECT id FROM redemptions WHERE order_id=? AND status IN ('processing','review','completed')").get(id)) throw new HttpError(409, '有处理中、待核查或已交付的权益，请先核查履约；部分退款由运营另行对账。');
        await tx.prepare("UPDATE orders SET status='refund_pending',updated_at=? WHERE id=?").run(now(), id);
        await tx.prepare("UPDATE vouchers SET status='frozen' WHERE order_id=? AND status NOT IN ('void','expired')").run(id);
        const rs = await tx.prepare("SELECT * FROM redemptions WHERE order_id=? AND status IN ('pending','failed')").all<RedemptionRow>(id);
        for (const r of rs) {
          await tx.prepare("UPDATE redemptions SET status='cancelled',updated_at=? WHERE id=?").run(now(), r.id);
          await audit(tx, id, 'cancelled', actor(req), '订单申请退款，履约已停止，等待支付渠道确认。', r.voucher_id, r.id);
        }
        await tx.prepare('INSERT INTO refund_requests(order_id,requested_at) VALUES(?,?)').run(id, now());
        await audit(tx, id, 'refund_pending', actor(req), note);
        await tx.prepare('INSERT INTO order_events(order_id,status,message,created_at) VALUES(?,?,?,?)').run(id, 'refund_pending', '权益已冻结。退款需在原支付渠道办理，尚未确认退款到账。', now());
      });
      res.json({ ok: true, message: '权益已冻结；请在原商户后台办理全额退款后查询结果。本操作未发起资金划转。' });
    });
    app.post('/api/admin/orders/:id/refund-check', async (req, res) => {
      const { reference } = z.object({ reference: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/) }).strict().parse(req.body);
      const id = String(req.params.id), order = await db.prepare('SELECT * FROM orders WHERE id=?').get<OrderRow>(id);
      if (!order || !['refund_pending', 'refunded'].includes(order.status)) throw new HttpError(409, '请先申请退款并冻结权益。');
      if (order.status === 'refunded') { res.json({ verified: true }); return; }
      const proof = order.payment_mode === 'demo' && mode === 'demo' ? { reference: `demo:${id}`, amount: order.amount, orderId: id } : await verifyRefund(order, reference);
      if (!proof) { res.json({ verified: false, message: '支付渠道尚未确认全额退款成功，权益继续冻结。' }); return; }
      if (proof.orderId !== id || proof.amount !== order.amount) throw new HttpError(409, '退款凭据与原订单或全额金额不匹配，请人工核查。');
      await db.transaction(async tx => {
        const current = (await tx.lockOrder(id))!;
        if (current.status === 'refunded') return;
        if (current.status !== 'refund_pending') throw new HttpError(409, '退款状态已变化。');
        await tx.prepare('UPDATE refund_requests SET external_reference=?,verified_reference=?,verified_at=? WHERE order_id=?').run(reference, proof.reference, now(), id);
        await tx.prepare("UPDATE orders SET status='refunded',updated_at=? WHERE id=?").run(now(), id);
        await tx.prepare("UPDATE vouchers SET status='void' WHERE order_id=?").run(id);
        await audit(tx, id, 'refunded', 'provider', '全额退款结果已核验，全部卡密已作废。');
        await tx.prepare('INSERT INTO order_events(order_id,status,message,created_at) VALUES(?,?,?,?)').run(id, 'refunded', order.payment_mode === 'demo' ? '演示退款完成，未发生真实资金划转。' : '原支付渠道已确认全额退款成功。', now());
      });
      res.json({ verified: true });
    });
  }
  return { summary, purchase, issue, compensate, publicRoutes, adminRoutes };
}
