import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  ArrowLeft, ArrowRight, Check, CircleHelp, Clock3, Copy, CreditCard,
  Headphones, Menu, PackageCheck, RefreshCw, Search, ShieldCheck,
  Sparkles, WalletCards, X,
} from 'lucide-react';
import QRCode from 'qrcode';
import { api, date, money, type Catalog, type Order, type Plan, type Receipt } from './api';
import { Busy, ErrorMessage, Logo, Modal } from './components';
import VoucherDelivery from './VoucherDelivery';

type Dialog = 'checkout' | 'lookup' | 'order' | 'terms' | 'privacy' | 'support' | null;

const faqs = [
  ['购买后拿到的是什么？', '付款确认后，系统会为你购买的数量分别生成一张 xiaoyu AI 卡密。卡密代表本站服务兑换权益，不代表 ChatGPT 订阅已经开通。'],
  ['兑换后多久完成？', '兑换申请提交后会进入人工履约队列。处理人员会核对目标账号、适用条件和交付结果；只有取得可验证的交付结果后，状态才会显示为已完成。'],
  ['需要提供密码或 session 吗？', '不需要。本站只收集目标账号邮箱和联系方式。请不要提交密码、验证码、ChatGPT session、银行卡号或 CVV。'],
  ['支持哪些真实收款方式？', '商户资料配置完成后支持支付宝官方收银台和微信支付 Native 扫码；银行卡可通过已配置的 Stripe 托管收银台付款。当前站点是否可使用某项支付方式，以商品页显示为准。'],
  ['购买、兑换和开通是什么关系？', '付款成功会发放卡密；提交卡密后会创建独立履约单；实际开通或交付完成是第三个状态。任何一个步骤都不会被界面提前标记为完成。'],
];

const readReceipt = (): Receipt | null => {
  try { return JSON.parse(sessionStorage.getItem('xy-receipt') || 'null'); } catch { return null; }
};

export default function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadError, setLoadError] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(readReceipt);
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [paymentChannel, setPaymentChannel] = useState<'wechat' | 'alipay'>('alipay');
  const [qr, setQr] = useState<{ orderId: string; image: string } | null>(null);

  const close = useCallback(() => {
    if (dialog === 'checkout') setPlan(null);
    setDialog(null);
    setError('');
    setNotice('');
  }, [dialog]);

  const loadCatalog = useCallback(() => {
    setLoadError('');
    api<Catalog>('/catalog').then(result => {
      if (!Array.isArray(result.plans) || result.plans.length === 0
        || result.plans.some(item => !item || typeof item.id !== 'string' || typeof item.name !== 'string'
          || !Number.isSafeInteger(item.price) || !Array.isArray(item.features))
        || typeof result.paymentReady !== 'boolean' || !Array.isArray(result.paymentChannels)) {
        throw new Error('套餐暂时无法加载，请稍后重试。');
      }
      setCatalog(result);
    }).catch(e => setLoadError((e as Error).message));
  }, []);

  useEffect(loadCatalog, [loadCatalog]);

  useEffect(() => {
    if (dialog !== 'order' || !receipt || !qr || qr.orderId !== order?.id || order.status !== 'pending_payment') return;
    let active = true;
    const timer = setInterval(() => {
      api<{ order: Order }>('/orders/payment-status', receipt)
        .then(result => { if (active) setOrder(result.order); })
        .catch(() => { if (active) setNotice('付款结果暂未更新，可以手动刷新，请勿重复付款。'); });
    }, 15000);
    return () => { active = false; clearInterval(timer); };
  }, [dialog, order?.id, order?.status, qr, receipt]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('payment')) return;
    const saved = readReceipt();
    setNotice(params.get('payment') === 'success' ? '已从收银台返回，付款结果以服务端确认的到账状态为准。' : '本次支付未完成，可以继续付款。');
    if (saved && saved.orderId === params.get('order')) {
      api<{ order: Order }>('/orders/lookup', saved)
        .then(result => { setOrder(result.order); setReceipt(saved); setDialog('order'); })
        .catch(e => { setError((e as Error).message); setDialog('lookup'); });
    } else setDialog('lookup');
    window.history.replaceState({}, '', '/');
  }, []);

  function open(value: Dialog) {
    setError('');
    setNotice('');
    setDialog(value);
    setMobileMenu(false);
  }

  function choosePlan(selected: Plan) {
    setPlan(selected);
    setQuantity(1);
    setPaymentChannel(catalog?.paymentChannels?.some(channel => channel.id === 'alipay') ? 'alipay' : 'wechat');
    open('checkout');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function saveReceipt(value: Receipt) {
    setReceipt(value);
    try { sessionStorage.setItem('xy-receipt', JSON.stringify(value)); } catch { /* Keep the receipt visible. */ }
  }

  async function createOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!plan || busy) return;
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const result = await api<{ order: Order; accessCode: string }>('/orders', {
        planId: plan.id,
        quantity,
        email: fields.get('email'),
        contact: fields.get('contact'),
        consent: fields.get('consent') === 'on',
      });
      const credentials = { orderId: result.order.id, accessCode: result.accessCode };
      saveReceipt(credentials);
      setOrder(result.order);
      setDialog('order');
      if (result.order.paymentMode !== 'demo') await beginCheckout(credentials, result.order, paymentChannel);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function lookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const input = {
      orderId: String(fields.get('orderId')).trim().toUpperCase(),
      accessCode: String(fields.get('accessCode')).trim().toUpperCase(),
    };
    setBusy(true);
    setError('');
    try {
      const result = await api<{ order: Order }>('/orders/lookup', input);
      saveReceipt(input);
      setOrder(result.order);
      setDialog('order');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function refresh() {
    if (!receipt) return;
    setBusy(true);
    setError('');
    try {
      const path = order?.paymentMode === 'merchant' ? '/orders/payment-status' : '/orders/lookup';
      const result = await api<{ order: Order }>(path, receipt);
      setOrder(result.order);
      setNotice(result.order.status === 'pending_payment' ? '暂未确认付款，请稍后刷新，请勿重复付款。' : '已获取最新进度。');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function beginCheckout(credentials: Receipt, currentOrder: Order, preferredChannel?: 'wechat' | 'alipay') {
    const available = catalog?.paymentChannels || [];
    const channel = currentOrder.paymentChannel
      || (available.some(value => value.id === preferredChannel) ? preferredChannel : available[0]?.id);
    const checkout = await api<{ mode: string; url?: string; qrCode?: string }>('/orders/checkout', { ...credentials, channel });
    if (checkout.mode === 'demo') {
      const result = await api<{ order: Order }>('/orders/demo-pay', credentials);
      setOrder(result.order);
      setNotice('演示付款成功，未实际扣款。卡密已发放，可以前往兑换页继续体验。');
    } else if (checkout.qrCode) {
      const image = await QRCode.toDataURL(checkout.qrCode, {
        width: 260, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#102049', light: '#ffffff' },
      });
      setQr({ orderId: credentials.orderId, image });
      setOrder((await api<{ order: Order }>('/orders/lookup', credentials)).order);
    } else if (checkout.url) window.location.assign(checkout.url);
    else throw new Error('支付通道未返回可用的收银台地址，请稍后重试。');
  }

  async function pay() {
    if (!receipt || !order || busy) return;
    setBusy(true);
    setError('');
    try { await beginCheckout(receipt, order, paymentChannel); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function copyReceipt() {
    if (!receipt) return;
    try {
      await navigator.clipboard.writeText(`xiaoyu AI 订单\n订单号：${receipt.orderId}\n查询码：${receipt.accessCode}\n请妥善保管。`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch { setNotice('复制未成功，请手动保存订单号和查询码。'); }
  }

  const inCheckout = dialog === 'checkout' && plan !== null;

  return <>
    <header className="reference-header">
      <div className="reference-container reference-nav">
        <Logo/>
        <nav className={mobileMenu ? 'reference-nav-links open' : 'reference-nav-links'} aria-label="主导航">
          <a href="/" className={!inCheckout ? 'active' : ''}>首页</a>
          <a href="/#products" className={inCheckout ? 'active' : ''}>商品分类</a>
          <a href="/redeem">卡密兑换</a>
          <a href="/#faq">服务帮助</a>
        </nav>
        <div className="reference-nav-actions">
          <button className="reference-outline-button" onClick={() => open('lookup')}><Search size={16}/>订单查询</button>
          <a className="reference-blue-button small" href="/redeem">开始充值</a>
          <button className="reference-mobile-toggle" onClick={() => setMobileMenu(!mobileMenu)} aria-label={mobileMenu ? '收起导航' : '展开导航'}>
            {mobileMenu ? <X/> : <Menu/>}
          </button>
        </div>
      </div>
    </header>

    <main>
      {inCheckout && plan ? <section className="reference-container checkout-page">
        <div className="reference-breadcrumb"><button onClick={close}><ArrowLeft size={14}/>返回商品</button><span>/</span><span>商品与支付</span></div>
        <h1>商品与支付</h1>
        <div className="checkout-grid">
          <article className={`product-detail-card theme-${catalog?.plans.findIndex(value => value.id === plan.id) || 0}`}>
            <div className="product-service-icon"><Sparkles/></div>
            <span className="product-kicker">XIAOYU AI SERVICE CARD</span>
            <h2>{plan.name}</h2>
            <p className="product-rule">服务周期：{plan.period} · 兑换有效期为发码后 365 天</p>
            <div className="reference-price"><span>¥</span><strong>{money(plan.price)}</strong><small>/ {plan.period}</small></div>
            <div className="product-feature-list">{plan.features.map(feature => <span key={feature}><Check size={16}/>{feature}</span>)}</div>
            <div className="product-notice">
              <ShieldCheck size={19}/>
              <div><strong>购买卡密不等于订阅已开通</strong><p>付款确认后自动发码；兑换卡密后才进入履约流程。目标账号资料仅用于本次服务。</p></div>
            </div>
          </article>

          <section className="payment-panel" aria-label="确认并支付">
            <h2>确认并支付</h2>
            <div className="quantity-row">
              <label>购买数量</label>
              <div className="quantity-stepper">
                <button type="button" aria-label="减少数量" disabled={quantity <= 1} onClick={() => setQuantity(value => Math.max(1, value - 1))}>−</button>
                <output aria-live="polite">{quantity}</output>
                <button type="button" aria-label="增加数量" disabled={quantity >= 10} onClick={() => setQuantity(value => Math.min(10, value + 1))}>＋</button>
              </div>
            </div>
            <form className="reference-form" onSubmit={createOrder}>
              <label>接收订单信息的邮箱<input name="email" type="email" required maxLength={254} placeholder="例如：123456@qq.com" autoComplete="email"/><small>不必与 ChatGPT 账号邮箱一致。</small></label>
              <label>联系方式<input name="contact" required minLength={2} maxLength={100} placeholder="微信号或手机号，用于售后联系"/></label>
              {catalog?.paymentMode === 'merchant' && <fieldset className="reference-payment-options"><legend>支付方式</legend>
                {(catalog.paymentChannels || []).map(channel => <label key={channel.id}>
                  <input type="radio" name="checkoutPaymentChannel" checked={paymentChannel === channel.id} onChange={() => setPaymentChannel(channel.id)}/>
                  <span>{channel.id === 'alipay' ? '支付宝' : '微信支付'}</span>
                </label>)}
              </fieldset>}
              {catalog?.paymentMode === 'demo' && <div className="reference-payment-options demo-payment-options">
                <span className="selected-payment"><WalletCards size={18}/>演示支付</span>
                <small>演示模式不会扣款。配置商户资料后，此处显示支付宝与微信支付。</small>
              </div>}
              <label className="reference-consent"><input type="checkbox" name="consent" required/><span>我已阅读并同意<button type="button" onClick={() => open('terms')}>服务条款</button>，了解所购买的是本站兑换卡密，不代表订阅已经开通。</span></label>
              <div className="payment-total"><span>合计</span><strong>¥{money(plan.price * quantity)}</strong></div>
              <ErrorMessage message={error}/>
              <button className="reference-blue-button full" disabled={busy || !catalog?.paymentReady}>
                {busy ? <Busy label="创建订单"/> : <>{catalog?.paymentReady ? '确认支付' : '收款配置中'}<ArrowRight size={17}/></>}
              </button>
              <p className="reference-footnote">付款结果以微信、支付宝或 Stripe 官方回调及主动查单为准。</p>
            </form>
          </section>
        </div>
      </section> : <div className="reference-container shop-layout">
        <aside className="category-sidebar">
          <span>商品分类</span>
          <a href="/#products" className="selected"><span>精选</span>首页推荐</a>
          <a href="/#products"><span>全部</span>{catalog?.plans.length || 3} 个套餐</a>
          <a href="/#faq"><span>客服</span>购买与服务帮助</a>
          <div className="category-divider"/>
          <a href="/redeem">已有卡密？<ArrowRight size={14}/></a>
        </aside>
        <div className="shop-content">
          <div className="shop-heading">
            <div><span className="eyebrow">XIAOYU AI ACTIVATION CENTER</span><h1>会员服务卡密</h1><p>选择套餐，付款确认后自动发码。</p></div>
            <div className={`shop-trust ${catalog?.paymentMode === 'demo' ? 'demo' : ''}`}><span className="reference-status-dot"/>{catalog?.paymentMode === 'demo' ? '演示模式' : catalog?.paymentReady ? '官方收款' : '配置检查中'}</div>
          </div>
          {loadError ? <div className="catalog-error"><ErrorMessage message={loadError}/><button className="reference-outline-button" onClick={loadCatalog}><RefreshCw size={15}/>重新加载套餐</button></div> : !catalog ? <div className="catalog-loading"><Busy label="加载套餐"/></div> : <>
            {catalog.paymentMode === 'demo' && <div className="reference-demo-mode" role="status"><ShieldCheck size={17}/><div><strong>当前为演示购买流程</strong><span>不会实际扣款或开通订阅；配置微信、支付宝商户资料并切换真实模式后才会收取真实款项。</span></div></div>}
            <section className="reference-product-grid" id="products">
              {catalog.plans.map((item, index) => <article className={`reference-product-card theme-${index}`} key={item.id}>
                <div className="reference-product-top">
                  <div className="product-service-icon">{index === 0 ? <Sparkles/> : index === 1 ? <PackageCheck/> : <CreditCard/>}</div>
                  <div><span>{item.tier}</span><h2>{item.name}</h2><small>兑换有效期为发码后 365 天</small></div>
                </div>
                <p>{item.subtitle}</p>
                <div className="reference-product-meta"><span>独立账号</span><span>付款发码</span><span>进度可查</span></div>
                <div className="reference-product-price"><strong>¥{money(item.price)}</strong><small>/ {item.period}</small></div>
                <button className="reference-product-link" onClick={() => choosePlan(item)} disabled={!catalog.paymentReady}>查看详情<ArrowRight size={15}/></button>
              </article>)}
            </section>
            {!catalog.paymentReady && <div className="reference-payment-warning" role="status"><Clock3 size={18}/><div><strong>{catalog.voucherReady === false ? '卡密服务配置中' : '收款通道配置中'}</strong><p>{catalog.voucherReady === false ? '服务端尚未配置卡密加密密钥，当前不会创建订单。' : '配置微信或支付宝官方商户资料后开放真实付款。'}</p></div></div>}
            <section className="reference-service-strip">
              <article><Check/><h3>自动发卡</h3><p>付款确认后自动生成独立卡密。</p></article>
              <article><Clock3/><h3>进度可查</h3><p>订单和履约分别显示真实状态。</p></article>
              <article><Headphones/><h3>人工履约</h3><p>兑换后核对账号并记录交付结果。</p></article>
            </section>
          </>}
          <section className="reference-faq" id="faq">
            <div className="shop-heading"><div><span className="eyebrow">SERVICE NOTES</span><h2>购买前，请先了解</h2></div><CircleHelp size={28}/></div>
            {faqs.map(([question, answer], index) => <article key={question} className={openFaq === index ? 'open' : ''}>
              <button onClick={() => setOpenFaq(openFaq === index ? null : index)}><span>{String(index + 1).padStart(2, '0')} {question}</span>{openFaq === index ? <X size={16}/> : <ArrowRight size={16}/>}</button>
              {openFaq === index && <p>{answer}</p>}
            </article>)}
          </section>
        </div>
      </div>}
    </main>

    <footer className="reference-footer">
      <div className="reference-container"><Logo/><div><a href="/redeem">兑换卡密</a><button onClick={() => open('lookup')}>订单查询</button><button onClick={() => open('support')}>服务帮助</button><a href="/admin">管理后台</a></div><small>© {new Date().getFullYear()} xiaoyu AI · 独立服务平台，与 OpenAI 无隶属关系</small></div>
    </footer>

    {dialog === 'lookup' && <Modal title="订单查询" eyebrow="ORDER CENTER" close={close}>
      <form className="form-stack" onSubmit={lookup}><label>订单号<input name="orderId" placeholder="XY 开头的订单号" required autoCapitalize="characters" maxLength={64}/></label><label>查询码<input name="accessCode" placeholder="下单时获得的查询码" required maxLength={64}/></label><ErrorMessage message={error}/><button className="reference-blue-button full" disabled={busy}>{busy ? <Busy label="查询订单"/> : '查询付款与卡密'}</button><p className="reference-footnote">订单号和查询码用于授权查看订单及卡密，请妥善保管。</p></form>
    </Modal>}
    {dialog === 'order' && order && <Modal title="订单与卡密" eyebrow="ORDER CENTER" close={close} wide>
      <div className="order-top"><div><span className={`status-badge ${order.status}`}>{order.statusLabel}</span><h3>{order.planName}</h3><p>{order.email}</p></div><strong>¥{money(order.amount)}</strong></div>
      {order.paymentMode === 'demo' && <div className="reference-payment-warning compact"><ShieldCheck size={18}/><span>演示订单：不会实际扣款，也不会开通真实订阅。</span></div>}
      <div className="receipt-box"><div><small>订单号</small><code>{order.id}</code></div><div><small>查询码（请保存）</small><code>{receipt?.accessCode}</code></div><button className="icon-button" onClick={copyReceipt} aria-label="复制订单号和查询码">{copied ? <Check size={18}/> : <Copy size={18}/>}</button></div>
      {order.flow === 'voucher' && receipt && <VoucherDelivery key={order.id} order={order} receipt={receipt}/>}
      <ol className="timeline">{order.events.map((event, index) => <li key={event.id} className={index === order.events.length - 1 ? 'latest' : ''}><span className="timeline-dot"/><div><p>{event.message}</p><small>{date(event.createdAt)}</small></div></li>)}</ol>
      {notice && <p className="success-message" role="status">{notice}</p>}<ErrorMessage message={error}/>
      {order.status === 'pending_payment' && order.paymentMode === 'merchant' && <fieldset className="payment-options"><legend>支付方式</legend>{(catalog?.paymentChannels || []).map(channel => <label key={channel.id}><input type="radio" name="paymentChannel" checked={order.paymentChannel ? order.paymentChannel === channel.id : paymentChannel === channel.id} onChange={() => setPaymentChannel(channel.id)}/><span>{channel.label}</span></label>)}</fieldset>}
      {order.status === 'pending_payment' && qr?.orderId === order.id && <div className="wechat-qr"><img src={qr.image} alt="此订单的微信支付二维码" width={240} height={240}/><strong>微信扫一扫 · ¥{money(order.amount)}</strong><p>请使用微信识别付款码。付款后系统会主动查询结果。</p><button className="reference-outline-button" onClick={refresh} disabled={busy}>我已付款，查询进度</button></div>}
      <div className="order-actions"><button className="reference-outline-button" onClick={refresh} disabled={busy}><RefreshCw size={16}/>刷新</button><a className="reference-blue-button" href="/redeem">前往兑换</a>{order.status === 'pending_payment' && <button className="reference-blue-button" onClick={pay} disabled={busy}>{busy ? <Busy/> : order.paymentMode === 'demo' ? '模拟付款（不扣款）' : '继续付款'}</button>}</div>
    </Modal>}
    {(dialog === 'terms' || dialog === 'privacy' || dialog === 'support') && <Modal title={dialog === 'terms' ? '服务条款' : dialog === 'privacy' ? '隐私说明' : '服务帮助'} eyebrow="SERVICE INFORMATION" close={close}>
      <div className="legal-content">{dialog === 'terms' ? <><h3>购买与发放</h3><p>付款确认后发放本站卡密，卡密只可提交一次兑换。卡密有效期、套餐和数量以订单记录为准。</p><h3>兑换与履约</h3><p>提交兑换后进入独立履约流程。处理人员通过官方支持的方式核验账号资格并记录结果。季度服务按阶段记录交付。</p><h3>退款</h3><p>全额退款申请会先冻结未交付权益；退款是否完成以原支付渠道确认结果为准。</p></> : dialog === 'privacy' ? <><h3>保存的信息</h3><p>平台保存下单邮箱、联系方式、订单、卡密状态、兑换账号邮箱和履约记录。</p><h3>不收集的信息</h3><p>平台不要求提交 ChatGPT 密码、验证码、session、银行卡号或 CVV。</p><h3>访问控制</h3><p>订单与兑换查询均需要对应查询码；管理后台使用 HttpOnly 管理会话。</p></> : <><h3>查询订单</h3><p>使用订单号和查询码查看付款及发码情况。</p><h3>查询兑换</h3><p>进入兑换中心，使用兑换编号和兑换查询码查看履约状态。</p><h3>售后</h3><p>处理失败或待核查时，请保留查询凭据并联系运营人员。正式客服入口由运营方上线前配置。</p></>}</div>
    </Modal>}
  </>;
}
