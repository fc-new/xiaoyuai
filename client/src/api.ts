export interface Plan {
  id: string; name: string; subtitle: string; price: number; period: string; tag: string;
  featured: boolean; tier: string; features: string[];
}
export type Status = 'pending_payment' | 'paid' | 'processing' | 'completed' | 'cancelled' | 'expired' | 'refund_pending' | 'refunded';
export interface Order {
  flow?: 'legacy' | 'voucher'; quantity?: number; issuedCount?: number; servicePeriod?: string; validityDays?: number; vouchers?: VoucherSummary[];
  id: string; email: string; contact: string; planId: string; planName: string; amount: number;
  currency: string; status: Status; statusLabel: string; paymentMode: string; createdAt: string; updatedAt: string;
  paymentChannel?: 'wechat' | 'alipay' | null;
  events: { id: number; status: string; message: string; createdAt: string }[];
}
export interface Catalog {
  plans: Plan[];
  paymentMode: 'demo' | 'stripe' | 'merchant';
  paymentReady: boolean;
  voucherReady?: boolean;
  paymentChannels: { id: 'wechat' | 'alipay'; label: string }[];
}
export interface Receipt { orderId: string; accessCode: string }
export async function api<T>(path: string, data?: unknown, method = 'POST'): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, data === undefined ? { credentials: 'same-origin' } : {
      method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
  } catch { throw new Error('暂时无法连接服务，请稍后重试。'); }
  let body;
  try { body = await res.json(); }
  catch { throw new Error('服务响应异常，请刷新页面后重试。'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('服务响应异常，请刷新页面后重试。');
  if (!res.ok) throw new Error(body.error || '请求失败，请稍后重试。');
  if (typeof body.error === 'string' && body.error) throw new Error(body.error);
  return body;
}
export const money = (amount: number) => (amount / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
export const date = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

export interface VoucherSummary { id: string; ordinal: number; status: string; statusLabel: string; expiresAt: string }
export interface Redemption {
  id: string; orderId: string; voucherId: string; planName: string; servicePeriod: string; paymentMode: string;
  targetEmail: string; contact?: string; assignee?: string; deliveryReference?: string; status: string; statusLabel: string;
  createdAt: string; updatedAt: string; events: { id: string; action: string; message: string; createdAt: string }[];
}
export interface RedemptionReceipt { id: string; accessCode: string }
