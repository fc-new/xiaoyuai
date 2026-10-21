import type { Express, RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { plans } from './catalog.js';
import type { Store } from './store.js';

export class ActivationError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const normalize = (value: string) => value.toUpperCase().replace(/[\s-]/g, '');
const codeInput = z.string().trim().max(120).refine(value => /^[A-Z0-9]{12,96}$/.test(normalize(value)));
const receiptInput = z.object({ id: z.string().max(64), accessCode: z.string().regex(/^[a-f0-9]{32,64}$/) });
const labels: Record<string, string> = { queued: '排队待处理', processing: '正在处理', needs_session: '请更新 session', needs_review: '待核实', completed: '已完成', failed: '未完成' };
interface Card { id: string; code_hash: string; code_suffix: string; plan_id: string; status: string; is_demo: number; source: string; expires_at: string | null; created_at: string }
interface Job { id: string; code_id: string; access_hash: string; account_email: string; status: string; session_ciphertext: string | null; session_expires_at: string | null; delivery_reference: string | null; created_at: string; updated_at: string; completed_at: string | null }

export async function registerActivations(app: Express, db: Store, options: {
  secret: string; adminAuth: RequestHandler; verifyPassword: (password: string) => boolean;
}) {
  if (options.secret.length < 32) throw new Error('VOUCHER_SECRET requires at least 32 characters');
  const key = createHash('sha256').update(`xiaoyu-activation-v1:${options.secret}`).digest();
  const fingerprint = hash(key.toString('hex'));
  await db.prepare('INSERT INTO activation_key_check(id,fingerprint) VALUES(1,?) ON CONFLICT(id) DO NOTHING').run(fingerprint);
  const stored = await db.prepare('SELECT fingerprint FROM activation_key_check WHERE id=1').get<{ fingerprint: string }>();
  if (stored?.fingerprint !== fingerprint) throw new Error('Restore original VOUCHER_SECRET: key differs from existing database');
  const seal = (value: string, id: string) => {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(id));
    const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
  };
  const unseal = (value: string, id: string) => {
    const bytes = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  };
  const event = (tx: Store, id: string, kind: string, message: string) => tx.prepare('INSERT INTO activation_events(id,job_id,kind,message,created_at) VALUES(?,?,?,?,?)').run(randomBytes(12).toString('hex'), id, kind, message, now());
  const getCard = (id: string, tx = db) => tx.prepare('SELECT * FROM activation_codes WHERE id=?').get<Card>(id);
  const getJob = (id: string, tx = db) => tx.prepare(`SELECT * FROM activation_jobs WHERE id=?${tx.dialect === 'postgres' && tx !== db ? ' FOR UPDATE' : ''}`).get<Job>(id);
  const serializeCard = (c: Card) => ({ id: c.id, suffix: c.code_suffix, planId: c.plan_id,
    planName: plans.find(p => p.id === c.plan_id)?.name || c.plan_id, status: c.status,
    isDemo: Boolean(c.is_demo), source: c.source, expiresAt: c.expires_at, createdAt: c.created_at });
  const serializeJob = async (job: Job) => {
    const card = (await getCard(job.code_id))!;
    return { id: job.id, accountEmail: job.account_email, status: job.status,
      statusLabel: job.status === 'completed' && card.is_demo ? '演示已完成' : labels[job.status],
      planId: card.plan_id, planName: plans.find(p => p.id === card.plan_id)?.name || card.plan_id,
      isDemo: Boolean(card.is_demo), codeSuffix: card.code_suffix,
      sessionAvailable: Boolean(job.session_ciphertext && job.session_expires_at && job.session_expires_at > now()),
      sessionExpiresAt: job.session_expires_at, deliveryReference: job.delivery_reference,
      createdAt: job.created_at, updatedAt: job.updated_at, completedAt: job.completed_at,
      events: await db.prepare('SELECT id,kind,message,created_at AS "createdAt" FROM activation_events WHERE job_id=? ORDER BY created_at,id').all(job.id) };
  };
  // Only retain the access token, not the complete session JSON, profile or cookies.
  function parseSession(value: string, demo: boolean) {
    if (demo) {
      if (value !== 'DEMO_SESSION') throw new ActivationError(400, '演示卡密请使用「填入演示 session」，不要提交真实登录凭据。');
      return { token: 'DEMO_SESSION', email: 'demo@example.com', expiresAt: new Date(Date.now() + 30 * 60000).toISOString() };
    }
    let session: unknown;
    try { session = JSON.parse(value); } catch { throw new ActivationError(400, '请粘贴完整的 session JSON。'); }
    const parsed = z.object({ accessToken: z.string().min(50).max(16000), expires: z.iso.datetime({ offset: true }), user: z.object({ email: z.email().max(254) }) }).safeParse(session);
    if (!parsed.success || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(parsed.data.accessToken)) throw new ActivationError(400, 'session 格式不正确，需要包含 accessToken、expires 和账号邮箱。');
    const expires = Date.parse(parsed.data.expires);
    if (expires < Date.now() + 60000) throw new ActivationError(400, 'session 已过期或即将过期，请重新获取。');
    return { token: parsed.data.accessToken, email: parsed.data.user.email.toLowerCase(), expiresAt: new Date(Math.min(expires, Date.now() + 30 * 60000)).toISOString() };
  }
  async function purge() {
    await db.transaction(async tx => {
      const expired = await tx.prepare('UPDATE activation_jobs SET session_ciphertext=NULL,updated_at=?,status=CASE WHEN status IN (\'queued\',\'processing\') THEN \'needs_session\' ELSE status END WHERE session_ciphertext IS NOT NULL AND session_expires_at<=? RETURNING id').all<{ id: string }>(now(), now());
      for (const job of expired) await event(tx, job.id, 'session_deleted', '临时 session 保存时间已到，已删除。需要继续处理时，请更新 session。');
    });
  }
  await purge();
  const timer = setInterval(() => { void purge().catch(() => console.error('Temporary session cleanup is pending; retrying on next request.')); }, 60000);
  timer.unref();
  app.use(['/api/activation', '/api/admin/activation'], async (_req, _res, next) => { try { await purge(); next(); } catch { next(new ActivationError(503, '暂时无法读取兑换状态，请稍后重试。')); } });
  const limit = rateLimit({ windowMs: 15 * 60000, limit: 60, message: { error: '请求较多，请稍后再试。' } });
  app.use('/api/activation', limit);
  app.get('/api/activation/config', (_req, res) => res.json({ brand: 'xiaoyu AI', workflow: 'external-code-session-v1', plans: plans.map(p => ({ id: p.id, name: p.name })), sessionRetentionMinutes: 30, fulfillmentMode: 'operator', purchaseEnabled: false }));
  const findCode = async (code: string) => {
    const card = await db.prepare('SELECT * FROM activation_codes WHERE code_hash=?').get<Card>(hash(normalize(code)));
    if (!card) throw new ActivationError(404, '卡密不存在，请确认已由商家导入本站。');
    return card;
  };
  app.post('/api/activation/check', async (req, res) => {
    const { code } = z.object({ code: codeInput }).strict().parse(req.body);
    const card = await findCode(code);
    const expired = Boolean(card.expires_at && card.expires_at <= now());
    res.json({ planName: plans.find(p => p.id === card.plan_id)?.name || card.plan_id, isDemo: Boolean(card.is_demo),
      status: expired && card.status === 'ready' ? 'expired' : card.status, redeemable: card.status === 'ready' && !expired });
  });
  app.post('/api/activation/recover', async (req, res) => {
    const input = z.object({ code: codeInput, requestKey: z.string().regex(/^[a-f0-9]{32,64}$/) }).strict().parse(req.body);
    const card = await findCode(input.code);
    const job = await db.prepare('SELECT * FROM activation_jobs WHERE code_id=? AND access_hash=?').get<Job>(card.id, hash(input.requestKey));
    if (!job) throw new ActivationError(404, '此浏览器没有可恢复的兑换申请，请使用已保存的查询凭据。');
    res.json({ job: await serializeJob(job) });
  });
  const authorize = async (body: unknown) => {
    const input = receiptInput.parse(body);
    const job = await getJob(input.id.toUpperCase());
    if (!job || job.access_hash !== hash(input.accessCode)) throw new ActivationError(404, '兑换编号或查询码不正确。');
    return job;
  };
  app.post('/api/activation/redeem', async (req, res) => {
    const input = z.object({ code: codeInput, session: z.string().min(1).max(32768), consent: z.literal(true), requestKey: z.string().regex(/^[a-f0-9]{32,64}$/) }).strict().parse(req.body);
    const card = await findCode(input.code);
    // Authenticate a retry before parsing its session, which may have expired since submission.
    const previous = await db.prepare('SELECT * FROM activation_jobs WHERE code_id=?').get<Job>(card.id);
    if (previous && previous.access_hash === hash(input.requestKey)) { res.json({ job: await serializeJob(previous) }); return; }
    const session = parseSession(input.session, Boolean(card.is_demo));
    const jobId = await db.transaction(async tx => {
      const claimed = await tx.prepare("UPDATE activation_codes SET status='redeemed' WHERE id=? AND status='ready' AND (expires_at IS NULL OR expires_at>?) RETURNING id").get(card.id, now());
      if (!claimed) {
        const duplicate = await tx.prepare('SELECT * FROM activation_jobs WHERE code_id=?').get<Job>(card.id);
        if (duplicate?.access_hash === hash(input.requestKey)) return duplicate.id;
        throw new ActivationError(409, '卡密已兑换、已禁用或已过期，请使用原兑换凭据查询。');
      }
      const id = `XR${randomBytes(10).toString('hex').toUpperCase()}`;
      const time = now();
      await tx.prepare('INSERT INTO activation_jobs(id,code_id,access_hash,account_email,status,session_ciphertext,session_expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, card.id, hash(input.requestKey), session.email, 'queued', seal(session.token, id), session.expiresAt, time, time);
      await event(tx, id, 'queued', card.is_demo ? '演示卡密已兑换，进入测试队列，不进行实际扣款或开通。' : '卡密已兑换，进入履约队列。session 仅完成格式检查，账号资格和实际开通结果待核实。');
      return id;
    });
    res.json({ job: await serializeJob((await getJob(jobId))!) });
  });
  app.post('/api/activation/lookup', async (req, res) => res.json({ job: await serializeJob(await authorize(req.body)) }));
  app.post('/api/activation/session', async (req, res) => {
    const input = receiptInput.extend({ session: z.string().min(1).max(32768), consent: z.literal(true) }).strict().parse(req.body);
    const authorized = await authorize(input);
    const card = (await getCard(authorized.code_id))!;
    const session = parseSession(input.session, Boolean(card.is_demo));
    await db.transaction(async tx => {
      const current = (await getJob(authorized.id, tx))!;
      if (['completed', 'failed'].includes(current.status)) throw new ActivationError(409, '此任务已结束，不能更新 session。');
      if (session.email !== current.account_email) throw new ActivationError(409, '更新的 session 必须属于原账号，请核对邮箱。');
      await tx.prepare("UPDATE activation_jobs SET session_ciphertext=?,session_expires_at=?,status=CASE WHEN status='needs_session' THEN 'queued' ELSE status END,updated_at=? WHERE id=?")
        .run(seal(session.token, current.id), session.expiresAt, now(), current.id);
      await event(tx, current.id, 'session_updated', '用户已更新临时 session，等待继续处理。');
    });
    res.json({ job: await serializeJob((await getJob(authorized.id))!) });
  });
  app.post('/api/activation/delete-session', async (req, res) => {
    const job = await authorize(req.body);
    await db.transaction(async tx => {
      const current = (await getJob(job.id, tx))!;
      if (!current.session_ciphertext) return;
      await tx.prepare("UPDATE activation_jobs SET session_ciphertext=NULL,status=CASE WHEN status IN ('queued','processing') THEN 'needs_session' ELSE status END,updated_at=? WHERE id=?").run(now(), job.id);
      await event(tx, job.id, 'session_deleted', '用户已删除本站保存的临时 session。');
    });
    res.json({ job: await serializeJob((await getJob(job.id))!) });
  });
  app.use('/api/admin/activation', options.adminAuth);
  app.get('/api/admin/activation/codes', async (req, res) => {
    const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
    const cards = await db.prepare('SELECT * FROM activation_codes ORDER BY created_at DESC,id LIMIT 30 OFFSET ?').all<Card>((page - 1) * 30);
    const stats = (await db.prepare("SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN status='ready' THEN 1 ELSE 0 END),0) AS ready,COALESCE(SUM(CASE WHEN status='redeemed' THEN 1 ELSE 0 END),0) AS redeemed FROM activation_codes").get())!;
    res.json({ codes: cards.map(serializeCard), stats: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, Number(v)])), page });
  });
  const batchInput = z.object({ planId: z.string(), isDemo: z.boolean(), source: z.string().trim().min(1).max(80), expiresAt: z.iso.datetime({ offset: true }).nullable().optional() });
  async function addCodes(codes: string[], input: z.infer<typeof batchInput>) {
    if (!plans.some(p => p.id === input.planId)) throw new ActivationError(400, '套餐不存在。');
    if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) throw new ActivationError(400, '卡密到期时间必须晚于当前时间。');
    const canonical = codes.map(normalize);
    if (new Set(canonical).size !== canonical.length) throw new ActivationError(409, '本批次存在重复卡密，未导入任何记录。');
    await db.transaction(async tx => {
      for (const code of canonical) {
        if (await tx.prepare('SELECT id FROM vouchers WHERE code_hash=?').get(hash(code))) throw new ActivationError(409, '卡密已存在于历史购买系统，不能重复导入。');
        const inserted = await tx.prepare("INSERT INTO activation_codes(id,code_hash,code_suffix,plan_id,status,is_demo,source,expires_at,created_at) VALUES(?,?,?,?,'ready',?,?,?,?) ON CONFLICT(code_hash) DO NOTHING RETURNING id")
          .get(`XC${randomBytes(10).toString('hex').toUpperCase()}`, hash(code), code.slice(-4), input.planId, input.isDemo ? 1 : 0, input.source, input.expiresAt ? new Date(input.expiresAt).toISOString() : null, now());
        if (!inserted) throw new ActivationError(409, '存在已导入的卡密，整批未写入。请去重后重试。');
      }
    });
  }
  app.post('/api/admin/activation/codes/import', async (req, res) => {
    const input = batchInput.extend({ codes: z.array(codeInput).min(1).max(500) }).strict().parse(req.body);
    await addCodes(input.codes, input); res.status(201).json({ imported: input.codes.length });
  });
  app.post('/api/admin/activation/codes/generate', async (req, res) => {
    const input = batchInput.extend({ count: z.number().int().min(1).max(500) }).strict().parse(req.body);
    const codes = Array.from({ length: input.count }, () => `${input.isDemo ? 'XYD' : 'XYA'}-${randomBytes(16).toString('hex').toUpperCase().match(/.{8}/g)!.join('-')}`);
    await addCodes(codes, input); res.status(201).json({ codes });
  });
  app.patch('/api/admin/activation/codes/:id', async (req, res) => {
    const { status } = z.object({ status: z.enum(['ready', 'disabled']) }).strict().parse(req.body);
    const changed = await db.prepare("UPDATE activation_codes SET status=? WHERE id=? AND status IN ('ready','disabled') RETURNING id").get(status, String(req.params.id));
    if (!changed) throw new ActivationError(409, '已兑换卡密不能禁用或恢复，请在履约任务中处理。');
    res.json({ ok: true });
  });
  app.get('/api/admin/activation/jobs', async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
    const jobs = await db.prepare("SELECT * FROM activation_jobs WHERE (?='' OR status=?) ORDER BY created_at DESC LIMIT 30 OFFSET ?").all<Job>(status, status, (page - 1) * 30);
    const raw = await db.prepare('SELECT status,COUNT(*) AS count FROM activation_jobs GROUP BY status').all<{ status: string; count: number | string }>();
    const total = Number((await db.prepare("SELECT COUNT(*) AS total FROM activation_jobs WHERE (?='' OR status=?)").get(status, status))!.total);
    res.json({ jobs: await Promise.all(jobs.map(serializeJob)), total, page, stats: Object.fromEntries(raw.map(r => [r.status, Number(r.count)])) });
  });
  app.get('/api/admin/activation/jobs/:id', async (req, res) => {
    const job = await getJob(String(req.params.id)); if (!job) throw new ActivationError(404, '任务不存在。');
    res.json({ job: await serializeJob(job) });
  });
  app.post('/api/admin/activation/jobs/:id/session', rateLimit({ windowMs: 15 * 60000, limit: 10, message: { error: '重新验证次数较多，请稍后再试。' } }), async (req, res) => {
    const { password } = z.object({ password: z.string().min(1).max(256) }).strict().parse(req.body);
    if (!options.verifyPassword(password)) throw new ActivationError(401, '请重新验证管理密码。');
    const token = await db.transaction(async tx => {
      const job = await getJob(String(req.params.id), tx);
      if (!job || !['processing', 'needs_review'].includes(job.status)) throw new ActivationError(409, '请先领取任务并开始处理。');
      if (!job.session_ciphertext || !job.session_expires_at || job.session_expires_at <= now()) throw new ActivationError(409, '临时 session 已删除或过期，请让用户更新。');
      await event(tx, job.id, 'session_accessed', '管理员重新验证身份后读取了临时 session，用于本次授权履约。');
      return { accessToken: unseal(job.session_ciphertext, job.id), expiresAt: job.session_expires_at };
    });
    res.json(token);
  });
  app.patch('/api/admin/activation/jobs/:id', async (req, res) => {
    const input = z.object({ status: z.enum(['processing', 'needs_review', 'completed', 'failed']), note: z.string().trim().min(2).max(1000), deliveryReference: z.string().trim().max(120).optional(), confirmed: z.boolean().optional() }).strict().parse(req.body);
    await db.transaction(async tx => {
      const job = await getJob(String(req.params.id), tx);
      if (!job) throw new ActivationError(404, '任务不存在。');
      const allowed: Record<string, string[]> = { queued: ['processing', 'needs_review', 'failed'], processing: ['processing', 'needs_review', 'completed', 'failed'], needs_review: ['processing', 'needs_review', 'failed'], needs_session: ['needs_review', 'failed'], completed: [], failed: [] };
      if (!allowed[job.status]?.includes(input.status)) throw new ActivationError(409, '状态已变化或任务已结束，请刷新。');
      if (input.status === 'processing' && (!job.session_ciphertext || !job.session_expires_at || job.session_expires_at <= now())) throw new ActivationError(409, '请先让用户更新有效期内的 session。');
      if (input.status === 'completed' && !input.confirmed) throw new ActivationError(400, '请确认已核实官方结算和实际交付结果。');
      if (input.status === 'completed' && (!input.deliveryReference || input.deliveryReference.length < 4)) throw new ActivationError(400, '确认完成需要填写官方订单号或交付凭据编号。');
      const terminal = ['completed', 'failed'].includes(input.status);
      await tx.prepare('UPDATE activation_jobs SET status=?,updated_at=?,delivery_reference=?,completed_at=?,session_ciphertext=? WHERE id=?')
        .run(input.status, now(), input.status === 'completed' ? input.deliveryReference! : job.delivery_reference,
          input.status === 'completed' ? now() : null, terminal ? null : job.session_ciphertext, job.id);
      await event(tx, job.id, input.status, input.note);
      if (terminal) await event(tx, job.id, 'session_deleted', '任务已结束，本站保存的临时 session 已删除。');
    });
    res.json({ job: await serializeJob((await getJob(String(req.params.id)))!) });
  });
  return () => clearInterval(timer);
}
