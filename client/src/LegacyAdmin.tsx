import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, Clock3, CreditCard, LogOut, Package, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { api, date, money, type Order, type Status } from './api';
import AdminCommerce from './AdminCommerce';
import AdminRefund from './AdminRefund';
import { Busy, ErrorMessage, Logo, Modal } from './components';

interface Dashboard { orders: Order[]; total: number; page: number; stats: { total: number; waiting: number; processing: number; revenue: number } }
interface PaymentSettings { mode: string; ready: boolean; note: string; channels: { provider: string; label: string; configured: boolean; missing: string[]; notifyUrl: string | null }[] }
const statuses: { value: Status | ''; label: string }[] = [
  { value: '', label: '全部订单' }, { value: 'pending_payment', label: '待付款' }, { value: 'paid', label: '已付款' },
  { value: 'expired', label: '已过期' }, { value: 'refund_pending', label: '退款处理中' }, { value: 'refunded', label: '已退款' },
  { value: 'processing', label: '开通中' }, { value: 'completed', label: '已完成' }, { value: 'cancelled', label: '已取消' },
];
export default function Admin() {
  const [authenticated, setAuthenticated] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [paymentSettings, setPaymentSettings] = useState<PaymentSettings | null>(null);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [orderFilters, setOrderFilters] = useState({ plan: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Order | null>(null);
  const close = useCallback(() => { setSelected(null); setActionError(''); }, []);
  const load = useCallback(async () => {
    setError('');
    try {
      const result = await api<Dashboard>(`/admin/orders?status=${encodeURIComponent(status)}&search=${encodeURIComponent(search)}&page=${page}&${new URLSearchParams(orderFilters)}`);
      setDashboard(result); setAuthenticated(true);
      const settings = await api<PaymentSettings>('/admin/payment-settings'); setPaymentSettings(settings);
    } catch (e) {
      const message = (e as Error).message;
      if (message.includes('登录')) setAuthenticated(false); else setError(message);
    } finally { setInitializing(false); }
  }, [status, search, page, orderFilters]);
  useEffect(() => { void load(); }, [load]);
  async function login(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setError('');
    try { await api('/admin/login', { password: new FormData(e.currentTarget).get('password') }); await load(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function logout() {
    setError('');
    try { await api('/admin/logout', {}); setAuthenticated(false); setDashboard(null); }
    catch (e) { setError((e as Error).message); }
  }
  async function update(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (!selected) return; setBusy(true); setActionError('');
    const form = new FormData(e.currentTarget);
    try {
      const { order } = await api<{ order: Order }>(`/admin/orders/${selected.id}`, { status: form.get('status'), note: form.get('note') }, 'PATCH');
      setSelected(order); await load();
    } catch (e) { setActionError((e as Error).message); } finally { setBusy(false); }
  }
  return <div className="admin-page"><header className="admin-header container"><Logo/><a className="text-link" href="/"><ArrowLeft size={15}/>返回前台</a>{authenticated && <button className="text-link" onClick={logout}><LogOut size={15}/>退出登录</button>}</header>
    {initializing ? <div className="admin-login"><Busy label="加载工作台"/></div> : !authenticated ? <main className="admin-login"><div className="admin-login-icon"><ShieldCheck size={28}/></div><div className="eyebrow">XIAOYUAI WORKSPACE</div><h1>认真服务，从这里开始。</h1><p>登录xiaoyu AI 订单管理工作台</p><form className="form-stack" onSubmit={login}><label>管理密码<input type="password" name="password" autoComplete="current-password" required placeholder="输入管理员密码" maxLength={256}/></label><ErrorMessage message={error}/><button className="button primary full" disabled={busy}>{busy ? <Busy label="登录"/> : <>进入工作台<ArrowRight size={17}/></>}</button></form><p className="form-footnote">初始密码由安装脚本生成，保存在服务器的<br/><code>.local/admin-credentials.txt</code> 中。</p></main> : <main className="container admin-main">
      <div className="section-heading"><div><div className="eyebrow">A LITTLE CARE, EVERY ORDER</div><h1>xiaoyu AI 工作台<span className="orange-dot">。</span></h1><p>查看购买订单、管理卡密，处理兑换与履约。</p></div><button className="button secondary" onClick={load}><RefreshCw size={16}/>刷新数据</button></div>
      <ErrorMessage message={error}/>
      {paymentSettings?.mode === 'merchant' && <section className="merchant-settings" aria-label="商户收款配置"><div className="merchant-settings-heading"><div><h2>微信 · 支付宝收款</h2><p>{paymentSettings.ready ? '已配置的通道可以发起支付，真实到账仍需联调确认。' : '商户资料尚未补全，当前不接受新付款订单。'}</p></div><span className={`status-badge ${paymentSettings.ready ? 'paid' : 'pending_payment'}`}>{paymentSettings.ready ? '配置已齐全' : '等待商户配置'}</span></div><div className="merchant-channel-grid">{paymentSettings.channels.map(channel => <article key={channel.provider}><h3>{channel.label}<small>{channel.configured ? '本地配置已齐全' : '待配置'}</small></h3>{channel.missing.length > 0 && <ul>{channel.missing.map(name => <li key={name}>{name}</li>)}</ul>}<p>通知地址：{channel.notifyUrl || '配置正式 HTTPS 域名后生成'}</p></article>)}</div><p className="form-footnote">请在服务器私有配置中补充商户资料和密钥文件，不要通过聊天发送私钥或银行卡信息。{paymentSettings.note}</p></section>}
      <AdminCommerce/><div className="section-heading"><h2>购买订单与旧订单</h2></div><div className="stats-grid">{[
        { label: '全部订单', value: dashboard?.stats.total || 0, icon: <Package/> },
        { label: '已付款订单', value: dashboard?.stats.waiting || 0, icon: <Clock3/> },
        { label: '协助开通中', value: dashboard?.stats.processing || 0, icon: <CheckCircle2/> },
        { label: '真实支付收款', value: `¥${money(dashboard?.stats.revenue || 0)}`, icon: <CreditCard/> },
      ].map(s => <div className="stat-card" key={s.label}>{s.icon}<span>{s.label}</span><strong>{s.value}</strong></div>)}</div>
      <form className="commerce-filters" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); setOrderFilters({ plan: String(f.get('plan')), from: String(f.get('from')), to: String(f.get('to')) }); setPage(1); }}><label>购买套餐<select name="plan"><option value="">全部套餐</option><option value="plus-month">Plus 月度</option><option value="plus-quarter">Plus 季度</option><option value="pro-month">Pro 月度</option></select></label><label>下单起始日期（UTC）<input name="from" type="date"/></label><label>下单结束日期（UTC）<input name="to" type="date"/></label><button className="button secondary">筛选购买订单</button></form><div className="admin-table-card"><div className="admin-toolbar"><div className="filter-tabs">{statuses.map(s => <button key={s.value} className={status === s.value ? 'selected' : ''} onClick={() => { setStatus(s.value); setPage(1); }}>{s.label}</button>)}</div><form className="admin-search" onSubmit={e => { e.preventDefault(); setSearch(String(new FormData(e.currentTarget).get('search')).trim()); setPage(1); }}><input aria-label="搜索订单号或邮箱" name="search" placeholder="搜索订单号 / 邮箱"/><button className="icon-button" aria-label="搜索"><Search size={17}/></button></form></div>
        <div className="table-scroll"><table><thead><tr><th>订单 / 创建时间</th><th>客户 / 套餐</th><th>金额</th><th>状态</th><th>操作</th></tr></thead><tbody>{dashboard?.orders.map(o => <tr key={o.id}><td><code>{o.id}</code><small>{date(o.createdAt)} {o.paymentMode === 'demo' && <span className="demo-tag">演示</span>}</small></td><td>{o.email}<small>{o.planName}</small></td><td>¥{money(o.amount)}</td><td><span className={`status-badge ${o.status}`}>{o.statusLabel}</span></td><td><button className="text-link" onClick={() => { setSelected(o); setActionError(''); }}>查看详情<ArrowRight size={14}/></button></td></tr>)}</tbody></table></div>
        {dashboard?.orders.length === 0 && <div className="empty-state"><Package size={32}/><h3>这里还没有订单</h3><p>客户下单后，就会出现在这里。</p></div>}
        <div className="pagination"><span>共 {dashboard?.total || 0} 笔 · 第 {page} 页</span><div><button className="button secondary small" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</button><button className="button secondary small" disabled={page * 20 >= (dashboard?.total || 0)} onClick={() => setPage(p => p + 1)}>下一页</button></div></div>
      </div><p className="form-footnote">演示订单不会计入真实支付收款。真实付款以支付回调为准；本后台不提供手工确认收款。退款请在支付服务商后台处理并联系客户。</p>
    </main>}
    {selected && <Modal title="每一笔订单，认真对待。" eyebrow="ORDER WORKSPACE" close={close} wide><div className="order-top"><div><span className={`status-badge ${selected.status}`}>{selected.statusLabel}</span><h3>{selected.planName}</h3><p>{selected.id}</p></div><strong>¥{money(selected.amount)}</strong></div><dl className="admin-order-info"><div><dt>联系邮箱</dt><dd>{selected.email}</dd></div><div><dt>联系方式</dt><dd>{selected.contact}</dd></div><div><dt>支付类型</dt><dd>{selected.paymentMode === 'demo' ? '演示支付（未实际收款）' : selected.paymentMode === 'merchant' ? selected.paymentChannel === 'wechat' ? '微信支付' : selected.paymentChannel === 'alipay' ? '支付宝' : '微信／支付宝（尚未发起）' : 'Stripe 托管支付'}</dd></div></dl><ol className="timeline">{selected.events.map(e => <li key={e.id}><span className="timeline-dot"/><div><p>{e.message}</p><small>{date(e.createdAt)}</small></div></li>)}</ol>
      {selected.flow === 'voucher' && <AdminRefund order={selected} reload={async () => { const r = await api<Dashboard>(`/admin/orders?search=${encodeURIComponent(selected.id)}`); setSelected(r.orders.find(o => o.id === selected.id) || selected); await load(); }}/>}{(selected.flow !== 'voucher' || selected.status === 'pending_payment') && ['pending_payment', 'paid', 'processing'].includes(selected.status) ? <form className="form-stack admin-action" onSubmit={update} key={`${selected.id}-${selected.status}`}><label>下一步操作<select name="status" defaultValue={selected.status === 'processing' ? 'completed' : selected.status === 'paid' ? 'processing' : 'cancelled'}>{selected.status === 'pending_payment' ? <option value="cancelled">取消未付款订单</option> : selected.status === 'paid' ? <option value="processing">开始协助开通</option> : <><option value="completed">确认交付完成</option><option value="processing">记录阶段进度（继续处理中）</option></>}</select></label><label>客户可见的处理说明<textarea name="note" rows={3} required minLength={2} maxLength={1000} placeholder="填写联系结果、处理进度或交付说明，请勿填写账号密码或支付信息。"/></label><ErrorMessage message={actionError}/><button className="button primary full" disabled={busy}>{busy ? <Busy label="更新订单"/> : <>更新订单状态<ArrowRight size={16}/></>}</button></form> : <p className="success-message">支付与履约分别记录，请查看对应记录的当前状态。</p>}
    </Modal>}
  </div>;
}
