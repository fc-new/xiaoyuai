import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Store } from './store.js';
import type { OrderRow } from './db.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const now = () => new Date().toISOString();
export const identifier = (prefix: string) => prefix + randomBytes(12).toString('hex').toUpperCase();
export const voucherLabels = { available: '待兑换', reserved: '已占用', redeemed: '已兑换', frozen: '已冻结', void: '已作废', expired: '已过期' };
export type VoucherStatus = keyof typeof voucherLabels;
export interface PurchaseRow { order_id: string; quantity: number; unit_price: number; service_period: string; validity_days: number }
export interface VoucherRow { id: string; order_id: string; ordinal: number; code_hash: string; code_encrypted: string; key_version: number; status: VoucherStatus; created_at: string; expires_at: string }
export function normalizeCode(input: string) {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  return /^XY[AD][A-F0-9]{32}$/.test(code) ? code : '';
}
export function effectiveStatus(v: VoucherRow): VoucherStatus {
  return v.status === 'available' && v.expires_at <= now() ? 'expired' : v.status;
}
export async function audit(tx: Store, orderId: string, action: string, actor: string, message: string, voucherId: string | null = null, redemptionId: string | null = null) {
  await tx.prepare('INSERT INTO commerce_events(id,order_id,voucher_id,redemption_id,action,actor,message,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(identifier('EV'), orderId, voucherId, redemptionId, action, actor, message, now());
}
export class VoucherVault {
  private key: Buffer;
  constructor(secret: string) {
    if (!/^[a-fA-F0-9]{64}$/.test(secret)) throw new Error('VOUCHER_SECRET must be 32 random bytes encoded as 64 hex characters');
    this.key = Buffer.from(secret, 'hex');
  }
  async verifyKey(db: Store) {
    const fingerprint = digest(this.key.toString('hex'));
    await db.prepare('INSERT INTO voucher_keys(version,fingerprint) VALUES(1,?) ON CONFLICT(version) DO NOTHING').run(fingerprint);
    const saved = await db.prepare('SELECT fingerprint FROM voucher_keys WHERE version=1').get<{ fingerprint: string }>();
    if (saved?.fingerprint !== fingerprint) throw new Error('Restore the original VOUCHER_SECRET; it differs from this database key');
  }
  private encrypt(code: string, id: string) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`xiaoyu-v1:${id}`));
    const encrypted = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  decrypt(v: VoucherRow) {
    if (v.key_version !== 1) throw new Error('Unknown voucher encryption version');
    const bytes = Buffer.from(v.code_encrypted, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`xiaoyu-v1:${v.id}`)); decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  }
  // All callers hold the parent order lock. Issuance and audit commit together.
  async issue(tx: Store, order: OrderRow) {
    const purchase = await tx.prepare('SELECT * FROM purchase_orders WHERE order_id=?').get<PurchaseRow>(order.id);
    if (!purchase || order.status !== 'paid') return;
    const created = now();
    const expiry = new Date(Date.now() + purchase.validity_days * 86400000).toISOString();
    for (let ordinal = 1; ordinal <= purchase.quantity; ordinal++) {
      if (await tx.prepare('SELECT id FROM vouchers WHERE order_id=? AND ordinal=?').get(order.id, ordinal)) continue;
      let inserted = false;
      for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
        const id = identifier('VC');
        const code = `${order.payment_mode === 'demo' ? 'XYD' : 'XYA'}-${randomBytes(16).toString('hex').toUpperCase().match(/.{8}/g)!.join('-')}`;
        // ON CONFLICT works on PostgreSQL without aborting its transaction on a collision.
        inserted = Boolean(await tx.prepare('INSERT INTO vouchers(id,order_id,ordinal,code_hash,code_encrypted,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id')
          .get(id, order.id, ordinal, digest(normalizeCode(code)), this.encrypt(code, id), 'available', created, expiry));
        if (inserted) await audit(tx, order.id, 'issued', 'system', `第 ${ordinal} 张${order.payment_mode === 'demo' ? '演示' : ''}卡密已发放；兑换后进入履约队列。`, id);
      }
      if (!inserted) throw new Error('Could not allocate a unique voucher');
    }
  }
}
