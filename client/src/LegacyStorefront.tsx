import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowUpRight, ArrowRight, Check, Plus, Minus, ShieldCheck, Search, Sparkles, Zap, Headphones, Command, Copy, RefreshCw, CreditCard, Menu, X, LockKeyhole, CircleHelp, Clock3, PackageCheck, Leaf } from 'lucide-react';
import { api, date, money, type Catalog, type Order, type Plan, type Receipt } from './api';
import { Busy, ErrorMessage, Fish, Logo, Modal } from './components';
import QRCode from 'qrcode';
import VoucherDelivery from './VoucherDelivery';

type Dialog = 'checkout' | 'lookup' | 'order' | 'terms' | 'privacy' | 'support' | null;
const faqs = [
  ['这是怎样的服务？', 'xiaoyu AI 提供 ChatGPT 订阅的人工开通协助。你购买卡密并提交兑换申请后，专人会核实账号及所在地区的适用条件，再通过官方支持的方式协助完成开通。xiaoyu AI 是独立服务平台，与 OpenAI 无隶属关系。'],
  ['需要提供账号密码吗？', '不需要在本平台填写密码、验证码、会话令牌或银行卡信息。请使用自己的账号，开通过程中的敏感验证应由你在官方页面自行完成。客服不会向你索取账号密码。'],
  ['下单后多久可以完成？', '这是人工协助服务，付款确认后自动发放卡密。兑换时提交目标账号，才进入待处理队列。专人会通过你留下的联系方式确认条件和预计处理时间；完成前可以随时用订单号和查询码查看进度，不承诺自动或即时到账。'],
  ['支持哪些支付方式？', '当前演示环境支持完整的模拟付款流程，不会实际扣款。正式环境可按商户配置提供微信扫码或支付宝官方收银台；Stripe 托管收银台也可承接适用的银行卡。实际可用渠道以订单页为准。'],
  ['无法开通或需要退款怎么办？', '请先通过订单号和查询码查询当前状态，并回复处理专员的联系消息。开通前会核实适用条件；无法履约的已付款订单由运营人员核实并在支付服务商后台处理退款。季度服务的未履约部分需按实际交付记录核算。'],
];
const readReceipt = (): Receipt | null => { try { return JSON.parse(sessionStorage.getItem('xy-receipt') || 'null'); } catch { return null; } };

export default function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadError, setLoadError] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [quantity, setQuantity] = useState(1);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(readReceipt);
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const [paymentChannel, setPaymentChannel] = useState<'wechat' | 'alipay'>('wechat');
  const [qr, setQr] = useState<{ orderId: string; image: string } | null>(null);
  const close = useCallback(() => { setDialog(null); setError(''); setNotice(''); }, []);
  const loadCatalog = useCallback(() => {
    setLoadError('');
    api<Catalog>('/catalog').then(result => {
      if (!Array.isArray(result.plans) || result.plans.length === 0 || result.plans.some(p => !p || typeof p.id !== 'string' || typeof p.name !== 'string' || !Number.isSafeInteger(p.price) || !Array.isArray(p.features))) throw new Error('套餐暂时无法加载，请稍后重试。');
      setCatalog(result);
    }).catch(e => setLoadError(e.message));
  }, []);
  useEffect(loadCatalog, [loadCatalog]);
  useEffect(() => {
    if (dialog !== 'order' || !receipt || !qr || qr.orderId !== order?.id || order.status !== 'pending_payment') return;
    let active = true;
    const timer = setInterval(() => {
      api<{ order: Order }>('/orders/payment-status', receipt).then(result => { if (active) setOrder(result.order); })
        .catch(() => { if (active) setNotice('付款结果暂未更新，可以点击刷新进度重试，请勿重复付款。'); });
    }, 15000);
    return () => { active = false; clearInterval(timer); };
  }, [dialog, receipt, qr, order?.id, order?.status]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('payment')) return;
    const saved = readReceipt();
    setNotice(params.get('payment') === 'success' ? '已从收银台返回，付款状态以服务端确认结果为准。' : '本次支付未完成，你可以继续付款。');
    if (saved && saved.orderId === params.get('order')) {
      api<{ order: Order }>('/orders/lookup', saved).then(r => { setOrder(r.order); setReceipt(saved); setDialog('order'); }).catch(e => { setError(e.message); setDialog('lookup'); });
    } else setDialog('lookup');
    window.history.replaceState({}, '', '/');
  }, []);
  function open(value: Dialog) { setError(''); setNotice(''); setDialog(value); setMobileMenu(false); }
  function selectPlan(selected: Plan) { setPlan(selected); setQuantity(1); open('checkout'); }
  function saveReceipt(value: Receipt) { setReceipt(value); try { sessionStorage.setItem('xy-receipt', JSON.stringify(value)); } catch { /* Receipt remains visible if storage is disabled. */ } }
  async function createOrder(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (!plan || busy) return;
    const fields = new FormData(e.currentTarget); setBusy(true); setError('');
    try {
      const result = await api<{ order: Order; accessCode: string }>('/orders', { planId: plan.id, quantity, email: fields.get('email'), contact: fields.get('contact'), consent: fields.get('consent') === 'on' });
      saveReceipt({ orderId: result.order.id, accessCode: result.accessCode }); setOrder(result.order); setDialog('order');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function lookup(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const fields = new FormData(e.currentTarget);
    const input = { orderId: String(fields.get('orderId')).trim().toUpperCase(), accessCode: String(fields.get('accessCode')).trim().toUpperCase() };
    setBusy(true); setError('');
    try { const result = await api<{ order: Order }>('/orders/lookup', input); saveReceipt(input); setOrder(result.order); setDialog('order'); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function refresh() {
    if (!receipt) return; setBusy(true); setError('');
    try { const result = await api<{ order: Order }>(order?.paymentMode === 'merchant' ? '/orders/payment-status' : '/orders/lookup', receipt); setOrder(result.order); setNotice(result.order.status === 'pending_payment' ? '暂未确认付款，请稍后刷新，请勿重复付款。' : '已获取最新进度。'); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function pay() {
    if (!receipt || busy) return; setBusy(true); setError('');
    try {
      const available = catalog?.paymentChannels || [];
      const channel = order?.paymentChannel || (available.some(c => c.id === paymentChannel) ? paymentChannel : available[0]?.id);
      const checkout = await api<{ mode: string; url?: string; qrCode?: string }>('/orders/checkout', { ...receipt, channel });
      if (checkout.mode === 'demo') {
        const result = await api<{ order: Order }>('/orders/demo-pay', receipt); setOrder(result.order); setNotice('演示付款成功，未实际扣款。请查看卡密并提交兑换申请。');
      } else if (checkout.qrCode) {
        const image = await QRCode.toDataURL(checkout.qrCode, { width: 264, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#163f35', light: '#ffffff' } });
        setQr({ orderId: receipt.orderId, image });
        const result = await api<{ order: Order }>('/orders/lookup', receipt); setOrder(result.order);
      } else if (checkout.url) { window.location.assign(checkout.url); }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function copyReceipt() {
    if (!receipt) return;
    try { await navigator.clipboard.writeText(`xiaoyu AI 订单\n订单号：${receipt.orderId}\n查询码：${receipt.accessCode}\n请妥善保管，查询码可访问订单信息。`); setCopied(true); setTimeout(() => setCopied(false), 2500); }
    catch { setNotice('复制未成功，请手动保存订单号和查询码。'); }
  }

  return <>
    <div className="announcement"><span className="status-dot"/>{!catalog ? '正在连接xiaoyu AI 服务' : !catalog.voucherReady ? '卡密服务配置中 · 暂未开放新订单' : catalog.paymentMode === 'demo' ? '当前为演示模式 · 模拟支付不扣款，套餐价格仅供展示' : !catalog.paymentReady ? '收款通道配置中 · 暂未开放下单' : '官方收银台付款 · 自动发放卡密 · 人工履约'}<ArrowUpRight size={13}/></div>
    <header className="site-header"><div className="container nav-row"><Logo/>
      <nav className={mobileMenu ? 'nav-links mobile-open' : 'nav-links'} aria-label="主导航"><a href="#home" className="active" onClick={() => setMobileMenu(false)}>首页</a><a href="/redeem">兑换卡密</a><a href="#plans" onClick={() => setMobileMenu(false)}>选择套餐</a><a href="#how-it-works" onClick={() => setMobileMenu(false)}>服务流程</a><a href="#faq" onClick={() => setMobileMenu(false)}>常见问题</a></nav>
      <button className="nav-order" onClick={() => open('lookup')}><Search size={16}/><span>查询订单</span><ArrowUpRight size={16}/></button>
      <button className="mobile-toggle icon-button" onClick={() => setMobileMenu(!mobileMenu)} aria-label={mobileMenu ? '收起导航' : '展开导航'} aria-expanded={mobileMenu}>{mobileMenu ? <X/> : <Menu/>}</button>
    </div></header>

    <main>
      <section className="hero container" id="home">
        <div className="hero-copy"><div className="eyebrow"><span className="tiny-spark">✳︎</span> LITTLE FISH. BIG IDEAS.</div>
          <h1>让灵感，<br/><span className="serif-word">自由</span>发生<span className="orange-dot">。</span></h1>
          <p className="hero-lead">你的 AI 灵感补给站。</p><p className="hero-description">把繁琐交给 xiaoyu AI，把时间留给创造。<br/>从写下第一行，到实现下一个好想法，我们陪你开始。</p>
          <div className="hero-buttons"><a className="button primary" href="#plans">购买卡密 <ArrowUpRight size={19}/></a><a className="text-link" href="/redeem">已有卡密，前往兑换 <ArrowRight size={16}/></a></div>
          <div className="hero-assurances"><span><ShieldCheck size={16}/>独立账号</span><span><Clock3 size={16}/>进度可查</span><span><Headphones size={16}/>人工协助</span></div>
        </div>
        <div className="hero-art" aria-label="xiaoyu AI 灵感空间品牌插画" role="img">
          <div className="art-topline"><span><span className="status-dot light"/> INSPIRATION IS ONLINE</span><Command size={17}/></div>
          <div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="orbit orbit-three"/>
          <div className="art-star star-one">✳︎</div><div className="art-star star-two">✦</div>
          <div className="fish-disc"><Fish/><span className="disc-spark">✦</span></div>
          <div className="floating-label label-idea"><Sparkles size={16}/><span>今天，也有好想法。</span></div>
          <div className="floating-label label-create"><span className="orange-mini">↗</span> Ready to create</div>
          <div className="art-prompt"><div className="prompt-icon"><Sparkles size={17}/></div><div><small>YOUR NEXT CHAPTER</small><p>帮我把一个好想法，变成现实。</p></div><span className="prompt-send"><ArrowUpRight size={18}/></span></div>
          <div className="art-bottomline"><span>A LITTLE HELP. A LOT OF POSSIBILITY.</span><span>01 — ∞</span></div>
        </div>
        <div className="hero-footnote"><span className="footnote-index">01 /</span> 每一种热爱，都值得更好的工具。<span className="scroll-note">SCROLL TO EXPLORE <span>↓</span></span></div>
      </section>
      <div className="word-strip"><div><span>更好的工具</span><Sparkles/><span>更自由的想法</span><Fish/><span>更有趣的日常</span><Sparkles/><span>MAKE ROOM FOR IDEAS</span><Fish/></div></div>

      <section className="plans-section container section" id="plans"><div className="section-heading"><div><div className="eyebrow">PICK YOUR POSSIBILITY</div><h2>刚刚好的选择，<br className="mobile-break"/>陪你走得更远<span className="orange-dot">。</span></h2><p>按你的创作节奏选择。价格清晰，服务认真。</p></div><div className="section-pill"><span className="status-dot"/>付款发码 · 兑换申请</div></div>
        {loadError ? <div className="catalog-error"><ErrorMessage message={loadError}/><button className="button secondary" onClick={loadCatalog}><RefreshCw size={15}/>重新加载套餐</button></div> : !catalog ? <div className="catalog-loading"><Busy label="加载套餐"/></div> : <>
          <div className="plan-grid">{catalog.plans.map((p, i) => <article className={`plan-card ${p.featured ? 'featured' : ''}`} key={p.id}>
            <div className="plan-top"><span className="plan-symbol">{i === 0 ? <Leaf size={22}/> : i === 1 ? <Sparkles size={22}/> : <Zap size={22}/>}</span><span className="plan-tag">{p.featured && <span>✦ </span>}{p.tag}</span></div>
            <div className="plan-tier">CHATGPT {p.tier}</div><h3>{p.name}</h3><p className="plan-subtitle">{p.subtitle}</p>
            <div className="plan-price"><span>¥</span><strong>{money(p.price)}</strong><small>/ {p.period}</small></div><div className="plan-price-note">{catalog.paymentMode === 'demo' ? '演示价格 · ' : ''}人民币一次性付款，含协助服务</div>
            <div className="plan-divider"/><ul>{p.features.map(f => <li key={f}><Check size={16}/>{f}</li>)}</ul>
            <button className={`button ${p.featured ? 'coral' : 'secondary'}`} onClick={() => selectPlan(p)} disabled={!catalog.paymentReady}>{catalog.paymentReady ? '选择这个套餐' : '收款开通中'}<ArrowUpRight size={18}/></button>
            <p className="plan-bottom-note">独立账号 · 开通前核实适用条件</p>
          </article>)}</div>
          {(!catalog.voucherReady || !catalog.paymentReady) && <div className="payment-pending-note" role="status"><Clock3 size={18}/><div><strong>{!catalog.voucherReady ? '正在准备卡密服务' : '正在准备收款服务'}</strong><p>{!catalog.voucherReady ? '服务端尚未配置卡密加密密钥，当前不会创建订单或收取费用。' : '套餐和服务内容可以正常浏览。官方收款通道开通后开放购买，当前不会收取费用。'}</p></div></div>}
          <div className="plans-disclaimer"><ShieldCheck size={16}/><span>无需向平台提交账号密码。套餐权益以官方当前政策为准；xiaoyu AI 为独立人工协助服务。</span></div>
        </>}
      </section>

      <section className="workflow-section" id="how-it-works"><div className="container section"><div className="section-heading"><div><div className="eyebrow">LESS HASSLE. MORE CREATING.</div><h2>简单几步，<span className="workflow-serif">把可能打开。</span></h2><p>复杂的事，我们认真处理。每一步，你都看得见。</p></div><span className="workflow-flower">✳︎</span></div>
        <div className="steps-grid">{[
          { n: '01', icon: <Sparkles/>, title: '找到你的套餐', text: '选择适合的订阅协助方案，留下邮箱和方便联系的方式。' },
          { n: '02', icon: <CreditCard/>, title: '付款后自动发码', text: '确认到账后自动发放卡密，保存订单号和查询码。' },
          { n: '03', icon: <Headphones/>, title: '兑换并确认账号', text: '输入卡密、核对目标账号，提交后进入人工履约队列。' },
          { n: '04', icon: <PackageCheck/>, title: '开始你的创造', text: '交付结果记录在兑换单中，打开你的 AI 日常，尽情探索。' },
        ].map(s => <article className="step" key={s.n}><div className="step-top"><span>{s.n}</span>{s.icon}</div><h3>{s.title}</h3><p>{s.text}</p></article>)}</div>
        <div className="workflow-note"><LockKeyhole size={16}/><span>你的账号，始终由你掌握。请勿向任何人提供密码、验证码或会话令牌。</span></div>
      </div></section>

      <section className="faq-section container section" id="faq"><div className="faq-intro"><div className="eyebrow">A LITTLE CLARITY</div><h2>你想知道的，<br/>都在这里<span className="orange-dot">。</span></h2><p>好的开始，来自清楚的了解。</p><button className="text-link" onClick={() => open('support')}>还想了解更多 <ArrowUpRight size={17}/></button><div className="faq-decoration"><CircleHelp size={66} strokeWidth={1}/><span>?</span></div></div>
        <div className="faq-list">{faqs.map(([q, a], i) => <div className={`faq-item ${openFaq === i ? 'expanded' : ''}`} key={q}><button onClick={() => setOpenFaq(openFaq === i ? null : i)} aria-expanded={openFaq === i} aria-controls={`faq-${i}`}><span><small>0{i + 1}</small>{q}</span>{openFaq === i ? <Minus size={18}/> : <Plus size={18}/>}</button><div id={`faq-${i}`} hidden={openFaq !== i}><p>{i === 3 && catalog?.paymentMode === 'merchant' ? '支持微信扫码支付和支付宝官方收银台，实际开放渠道以订单页为准。付款结果由服务端校验官方回调或主动查询后确认；未完成商户配置时暂不接受下单。微信二维码请使用另一台设备扫描，或在微信中识别保存的付款码。' : i === 3 && catalog?.paymentMode === 'stripe' ? '当前已接入 Stripe 托管收银台。可用的银行卡品牌和支付方式以收银台实际显示为准；支付结果由服务端校验回调确认。' : a}</p></div></div>)}</div>
      </section>
      <section className="container"><div className="closing-card"><div><div className="eyebrow">YOUR NEXT IDEA STARTS HERE</div><h2>每一次开始，都有 xiaoyu AI 同行。</h2><p>给灵感一点空间，给自己更多可能。</p></div><a className="button primary" href="#plans">现在，开始创造<ArrowUpRight size={19}/></a><span className="closing-star">✳︎</span></div></section>
    </main>
    <footer className="container site-footer"><div className="footer-top"><div><Logo/><p>让灵感，自由发生。</p></div><div className="footer-links"><a href="#plans">选择套餐</a><button onClick={() => open('lookup')}>查询订单</button><button onClick={() => open('support')}>服务帮助</button><a href="/admin">管理后台<ArrowUpRight size={12}/></a></div></div><div className="footer-bottom"><span>© {new Date().getFullYear()} xiaoyu AI · XIAOYUAI</span><span>独立服务平台，与 OpenAI 无隶属关系</span><div><button onClick={() => open('terms')}>服务条款</button><button onClick={() => open('privacy')}>隐私说明</button></div></div></footer>

    {dialog === 'checkout' && plan && <Modal title="把好想法，安排上。" eyebrow="YOUR NEXT CHAPTER" close={close}>
      <div className="checkout-summary"><div><Sparkles size={20}/><span>{plan.name}<small>人工开通协助 · {plan.period}</small></span></div><strong>¥{money(plan.price * quantity)}</strong></div>
      <form onSubmit={createOrder} className="form-stack"><label>购买数量<select value={quantity} onChange={e => setQuantity(Number(e.target.value))}>{Array.from({ length: 10 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} 张</option>)}</select></label><p className="form-footnote">每张为独立的本站服务凭证；发放后 365 天内兑换。付款不代表已开通。</p><label>联系邮箱<input name="email" type="email" autoComplete="email" placeholder="you@example.com" required maxLength={254}/><small>用于专员联系及核实订单，请填写常用邮箱。</small></label><label>微信号或其他联系方式<input name="contact" autoComplete="off" placeholder="方便专员联系你的方式" required minLength={2} maxLength={100}/></label>
        <div className="form-info"><LockKeyhole size={17}/><p>这里不需要账号密码或银行卡信息。开通前专员会联系你核实条件。</p></div>
        <label className="checkbox-label"><input type="checkbox" name="consent" required/><span>我已阅读<button type="button" onClick={() => open('terms')}>服务条款</button>与<button type="button" onClick={() => open('privacy')}>隐私说明</button>，了解这是人工协助服务。{catalog?.paymentMode === 'demo' && '当前为演示，不实际开通订阅。'}</span></label>
        <ErrorMessage message={error}/><button className="button primary full" disabled={busy}>{busy ? <Busy label="创建订单"/> : <>创建订单 · ¥{money(plan.price * quantity)}<ArrowRight size={17}/></>}</button>
      </form>
    </Modal>}
    {dialog === 'lookup' && <Modal title="你的进度，xiaoyu AI 记着。" eyebrow="TRACK YOUR ORDER" close={close}><p className="modal-description">输入下单时保存的订单号和查询码，查看最新进度。</p><form className="form-stack" onSubmit={lookup}><label>订单号<input name="orderId" placeholder="XY 开头的订单号" defaultValue={receipt?.orderId} required autoCapitalize="characters" maxLength={64}/></label><label>专属查询码<input name="accessCode" placeholder="下单后获得的 16 位查询码" defaultValue={receipt?.accessCode} required maxLength={64}/></label><ErrorMessage message={error}/><button className="button primary full" disabled={busy}>{busy ? <Busy label="查询订单"/> : <>查询进度<Search size={17}/></>}</button><p className="form-footnote">查询码可访问你的订单信息，请妥善保管。平台不会自动发送邮件，请在创建订单后主动保存。</p></form></Modal>}
    {dialog === 'order' && order && <Modal title={order.status === 'pending_payment' ? '好想法，已经在路上。' : '每一步，都有回应。'} eyebrow="YOUR LITTLE FISH ORDER" close={close} wide>
      {order.paymentMode === 'demo' && <div className="demo-notice">演示订单 · 不实际扣款、不实际开通订阅</div>}
      <div className="order-top"><div><span className={`status-badge ${order.status}`}>{order.statusLabel}</span><h3>{order.planName}</h3><p>{order.email}</p></div><strong>¥{money(order.amount)}</strong></div>
      <div className="receipt-box"><div><small>订单号</small><code>{order.id}</code></div><div><small>专属查询码（请保存）</small><code>{receipt?.accessCode}</code></div><button className="icon-button" onClick={copyReceipt} aria-label="复制订单号和查询码">{copied ? <Check size={18}/> : <Copy size={18}/>}</button></div>
      {order.flow === 'voucher' && receipt && <VoucherDelivery key={order.id} order={order} receipt={receipt}/>}
      <div className="order-contact">联系信息：{order.contact}<span>创建于 {date(order.createdAt)}</span></div>
      <ol className="timeline">{order.events.map((event, i) => <li key={event.id} className={i === order.events.length - 1 ? 'latest' : ''}><span className="timeline-dot"/><div><p>{event.message}</p><small>{date(event.createdAt)}</small></div></li>)}</ol>
      {notice && <p className="success-message" role="status">{notice}</p>}<ErrorMessage message={error}/>
      {order.status === 'pending_payment' && order.paymentMode === 'merchant' && <fieldset className="payment-options"><legend>选择支付方式</legend>{(catalog?.paymentChannels || []).map(channel => <label key={channel.id}><input type="radio" name="paymentChannel" value={channel.id} checked={(order.paymentChannel || ((catalog?.paymentChannels || []).some(c => c.id === paymentChannel) ? paymentChannel : catalog?.paymentChannels[0]?.id)) === channel.id} disabled={Boolean(order.paymentChannel) || busy} onChange={() => setPaymentChannel(channel.id)}/><span>{channel.label}</span><small>{channel.id === 'wechat' ? '官方扫码' : '官方收银台'}</small></label>)}</fieldset>}
      {order.status === 'pending_payment' && qr?.orderId === order.id && <div className="wechat-qr"><img src={qr.image} alt="此订单的微信支付二维码" width={240} height={240}/><strong>微信扫一扫 · ¥{money(order.amount)}</strong><p>请使用另一台设备扫描，或保存付款码后在微信中识别。<br/>仅对本订单有效；付款后自动查询，也可手动刷新。</p><a className="text-link" href={qr.image} download={`${order.id}-wechat.png`}>保存付款码</a><button className="button secondary" onClick={refresh} disabled={busy}>我已付款，查询结果<RefreshCw size={15}/></button></div>}
      <div className="order-actions"><button className="button secondary" onClick={refresh} disabled={busy}><RefreshCw size={16}/>刷新进度</button>{order.status === 'pending_payment' && <button className="button primary" onClick={pay} disabled={busy}>{busy ? <Busy/> : <>{order.paymentMode === 'demo' ? '模拟付款（不扣款）' : order.paymentMode === 'merchant' ? (order.paymentChannel || ((catalog?.paymentChannels || []).some(c => c.id === paymentChannel) ? paymentChannel : catalog?.paymentChannels[0]?.id)) === 'wechat' ? '微信扫码付款' : '前往支付宝付款' : '前往安全收银台'}<ArrowUpRight size={17}/></>}</button>}</div>
      <p className="form-footnote">{order.status === 'paid' || order.status === 'processing' ? order.flow === 'voucher' ? '请先提交卡密兑换，再使用兑换查询码查看履约进度。' : '专员将通过你的联系方式沟通开通条件。' : '请保存订单号和查询码。刷新页面后可通过「查询订单」继续查看。'}</p>
    </Modal>}
    {(dialog === 'terms' || dialog === 'privacy' || dialog === 'support') && <Modal title={dialog === 'terms' ? '服务条款' : dialog === 'privacy' ? '隐私说明' : '需要一点帮助？'} eyebrow="A LITTLE HELP" close={close}>
      <div className="legal-content">{dialog === 'terms' ? <><p>xiaoyu AI 提供第三方订阅的人工开通协助，与 OpenAI 无隶属关系。订阅权益、地区资格和账号条件以官方规则为准。</p><h3>订单与交付</h3><p>下单后请保存订单号和查询码。付款后发放本站卡密，卡密有效期为发放后 365 天。请前往兑换中心提交目标账号；专人会在兑换后核实适用条件、交付时间和具体官方操作方式。卡密只能提交一次兑换，失败重试在原兑换单处理。季度套餐按约定分期协助并记录交付，不代表官方提供季度订阅。</p><h3>付款与退款</h3><p>标价为人民币一次性服务总额，不自动续费。演示订单不会扣款或开通。正式订单如无法履约，运营人员核实后从原支付渠道处理退款；部分履约需按实际记录核算。退款不由本演示系统自动执行。</p><h3>账号安全</h3><p>请勿提交密码、验证码、会话令牌或银行卡信息。涉及敏感验证的步骤，由你在官方页面完成。开通行为应遵守相关官方条款。</p></> : dialog === 'privacy' ? <><p>为创建和履行订单，我们保存联系邮箱、联系方式、所选套餐、金额、订单状态和处理记录，数据存储在平台的数据库中。</p><h3>信息的使用</h3><p>联系信息仅用于订单沟通与人工履约。订单号及查询码用于查询授权，查询码只保存哈希。支付卡信息由托管支付服务处理，本平台不接收或保存卡号、有效期和安全码。</p><h3>本地存储与管理</h3><p>浏览器会在当前会话保存最近一笔订单号和查询码，便于继续查询。管理登录使用仅 HTTP 可读的会话 Cookie。请勿在公共设备保留查询码。</p><h3>查阅与删除</h3><p>如需更正或删除联系信息，请回复订单处理专员的联系消息并提供订单凭据。订单记录保留至运营方按财务和售后要求执行清理，当前版本不会自动删除记录。</p></> : <><div className="support-illustration"><Headphones size={36}/><span>每个好问题，都值得认真回答。</span></div><h3>已有订单？</h3><p>先用订单号和查询码查看进度。处理专员会通过你下单时填写的邮箱或联系方式与你沟通。</p><button className="button primary full" onClick={() => open('lookup')}>查询我的订单<ArrowRight size={16}/></button><h3>还没下单？</h3><p>套餐、服务流程和常见问题中已列出当前可用信息。演示站暂未配置公开客服渠道；正式上线前由运营方补充真实联系方式。</p><p className="form-footnote">请不要把银行卡号、CVV 或账号密码发到聊天或订单备注中。</p></>}</div>
      {(dialog === 'terms' || dialog === 'privacy') && plan && <button className="button secondary full" onClick={() => open('checkout')}>返回填写订单<ArrowRight size={16}/></button>}
    </Modal>}
  </>;
}
