import { useState } from 'react';
import { Copy, ArrowRight } from 'lucide-react';
import { api, date, type Order, type Receipt } from './api';
import { Busy, ErrorMessage } from './components';

export default function VoucherDelivery({ order, receipt }: { order: Order; receipt: Receipt }) {
  const [codes, setCodes] = useState<{ id: string; ordinal: number; code: string; expiresAt: string }[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  async function reveal() {
    setBusy(true); setError('');
    try { setCodes((await api<{ vouchers: typeof codes }>('/orders/vouchers', receipt)).vouchers); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="voucher-delivery" aria-label="订单卡密"><div className="eyebrow">YOUR SERVICE VOUCHERS</div><h3>你的卡密 · {order.issuedCount || 0} / {order.quantity}</h3>
    <p>每张对应 {order.planName} · 服务周期 {order.servicePeriod}。卡密有效期为发放后 {order.validityDays} 天；兑换提交后才进入履约队列。</p>
    {order.status === 'paid' && (order.issuedCount || 0) < (order.quantity || 1) && <p role="status">付款已确认，卡密正在发放。系统会自动重试，请稍后刷新订单。</p>}
    {order.vouchers?.map(v => <div className="voucher-row" key={v.id}><div><strong>第 {v.ordinal} 张</strong><span className="status-badge">{v.statusLabel}</span><small>兑换截止 {date(v.expiresAt)}</small></div>{codes.find(c => c.id === v.id) && v.status === 'available' && <div className="voucher-code"><code>{codes.find(c => c.id === v.id)!.code}</code><button className="text-link" onClick={async () => { try { await navigator.clipboard.writeText(codes.find(c => c.id === v.id)!.code); setNotice('卡密已复制，请妥善保管。'); } catch { setNotice('请手动复制卡密。'); } }}><Copy size={16}/>复制卡密</button></div>}</div>)}
    {order.status === 'paid' && <div className="order-actions"><button className="button secondary" disabled={busy} onClick={reveal}>{busy ? <Busy/> : '查看可兑换卡密'}</button><a className="button primary" href="/redeem">前往兑换<ArrowRight size={16}/></a></div>}
    {notice && <p role="status">{notice}</p>}<ErrorMessage message={error}/>
    <p className="form-footnote">卡密是本站服务凭证，请勿转发给无关人员。已提交的卡密请使用兑换查询码查看履约结果。</p>
  </section>;
}
