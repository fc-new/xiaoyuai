import { useState } from 'react';
import { api, type Order } from './api';
import { ErrorMessage, Busy } from './components';
export default function AdminRefund({ order, reload }: { order: Order; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  return <section className="voucher-delivery"><h3>卡密权益与售后</h3><p>已发放 {order.issuedCount} / {order.quantity} 张；履约请在「兑换与履约单」中操作。</p>{order.vouchers?.map(v => <p key={v.id}><code>{v.id}</code> · 第 {v.ordinal} 张 · {v.statusLabel}</p>)}
    {['paid', 'refund_pending'].includes(order.status) && <form className="form-stack" onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); const f = new FormData(e.currentTarget); try { if (order.status === 'paid') { const r = await api<{ message: string }>(`/admin/orders/${order.id}/refund-request`, { note: f.get('note') }); setNotice(r.message); } else { const r = await api<{ verified: boolean; message?: string }>(`/admin/orders/${order.id}/refund-check`, { reference: f.get('reference') }); setNotice(r.verified ? '退款结果已核验，卡密已作废。' : r.message || '退款尚未确认。'); } await reload(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>
      {order.status === 'paid' ? <><p>全额退款申请会冻结未交付权益并停止排队中的兑换。已处理或结果不明的履约需先核查。本操作不转移资金。</p><label>退款原因<input name="note" required minLength={2} maxLength={500}/></label><button className="button secondary" disabled={busy}>{busy ? <Busy/> : '申请退款并冻结权益'}</button></> : <><p>{order.paymentMode === 'demo' ? '演示订单不会退款扣款；填写 demo 验证演示状态流转。' : '请先在原商户后台办理全额退款，再填入商户退款单号（Stripe 使用退款 ID）。这里只查询结果。'}</p><label>商户退款单号<input name="reference" required maxLength={100} defaultValue={order.paymentMode === 'demo' ? 'demo' : ''}/></label><button className="button secondary" disabled={busy}>{busy ? <Busy/> : '查询并核验退款结果'}</button></>}
    </form>}{notice && <p role="status">{notice}</p>}<ErrorMessage message={error}/></section>;
}
