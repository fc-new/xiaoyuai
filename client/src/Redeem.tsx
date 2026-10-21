import { useEffect, useState, type FormEvent } from 'react';
import {
  ArrowRight, Check, ChevronRight, CircleHelp, Copy, Headphones,
  RefreshCw, ShieldCheck, Sparkles, Ticket,
} from 'lucide-react';
import { api, date, type Redemption, type RedemptionReceipt } from './api';
import { Busy, ErrorMessage, Logo, Modal } from './components';

function stored<T>(key: string, fallback: T): T {
  try { return JSON.parse(sessionStorage.getItem(key) || 'null') || fallback; } catch { return fallback; }
}
function save(key: string, value: unknown) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Keep the receipt visible. */ }
}
const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, '0')).join('');
async function fingerprint(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value.toUpperCase().replace(/[\s-]/g, '')))), byte => byte.toString(16).padStart(2, '0')).join('');
}
interface Checked {
  planName: string; servicePeriod: string; paymentMode: string; statusLabel: string;
  expiresAt: string; redeemable: boolean;
}

export default function Redeem() {
  const [tab, setTab] = useState<'redeem' | 'track'>('redeem');
  const [code, setCode] = useState('');
  const [checked, setChecked] = useState<Checked | null>(null);
  const [result, setResult] = useState<Redemption | null>(null);
  const [receipt, setReceipt] = useState<RedemptionReceipt | null>(() => stored('xy-redemption', null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingKey, setPendingKey] = useState('');
  const [tutorial, setTutorial] = useState(false);

  const step = result ? 3 : checked?.redeemable ? 2 : 1;

  useEffect(() => {
    if (!receipt || !result || ['completed', 'cancelled'].includes(result.status)) return;
    let active = true;
    const timer = setInterval(() => {
      api<{ redemption: Redemption }>('/redemptions/lookup', receipt)
        .then(value => { if (active) setResult(value.redemption); })
        .catch(() => { if (active) setNotice('进度暂未更新，可以稍后手动刷新。'); });
    }, 15000);
    return () => { active = false; clearInterval(timer); };
  }, [receipt, result?.id, result?.status]);

  function closeTutorial() {
    setTutorial(false);
    try { sessionStorage.setItem('xy-redeem-tutorial-seen', '1'); } catch { /* Ignore storage failure. */ }
  }

  async function check(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setChecked(null);
    setPendingKey('');
    try {
      const value = await api<Checked>('/vouchers/check', { code });
      setChecked(value);
      const saved = stored<{ mark: string; key: string } | null>('xy-redemption-attempt', null);
      if (!value.redeemable && saved?.mark === await fingerprint(code)) {
        const recovered = await api<{ redemption: Redemption }>('/redemptions/recover', { code, accessCode: saved.key });
        const credentials = { id: recovered.redemption.id, accessCode: saved.key };
        save('xy-redemption', credentials);
        setReceipt(credentials);
        setResult(recovered.redemption);
        setCode('');
        return;
      }
      if (!value.redeemable) setError(`此卡密${value.statusLabel}。已提交的兑换请使用兑换凭据查询。`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function redeem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      const mark = await fingerprint(code);
      const saved = stored<{ mark: string; key: string } | null>('xy-redemption-attempt', null);
      const requestKey = saved?.mark === mark ? saved.key : newKey();
      save('xy-redemption-attempt', { mark, key: requestKey });
      setPendingKey(requestKey);
      const response = await api<{ redemption: Redemption }>('/vouchers/redeem', {
        code,
        targetEmail: String(form.get('targetEmail')).trim(),
        contact: form.get('contact'),
        consent: form.get('consent') === 'on',
        requestKey,
      });
      const credentials = { id: response.redemption.id, accessCode: requestKey };
      save('xy-redemption', credentials);
      setReceipt(credentials);
      setResult(response.redemption);
      setCode('');
      setChecked(null);
      setPendingKey('');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function lookup(credentials: RedemptionReceipt) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const value = await api<{ redemption: Redemption }>('/redemptions/lookup', credentials);
      setResult(value.redemption);
      setReceipt(credentials);
      save('xy-redemption', credentials);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function copy() {
    if (!receipt) return;
    try {
      await navigator.clipboard.writeText(`xiaoyu AI 兑换凭据\n兑换编号：${receipt.id}\n兑换查询码：${receipt.accessCode}\n进度查询：${location.origin}/redeem`);
      setNotice('兑换凭据已复制。');
    } catch { setNotice('请手动保存兑换编号和查询码。'); }
  }

  function reset() {
    setResult(null);
    setChecked(null);
    setError('');
    setNotice('');
    setTab('redeem');
  }

  return <>
    <header className="reference-header"><div className="reference-container reference-nav">
      <Logo/>
      <nav className="reference-nav-links"><a href="/">首页</a><a href="/#products">购买卡密</a><a className="active" href="/redeem">卡密兑换</a><a href="/#faq">服务帮助</a></nav>
      <span className="reference-secure-status"><span className="reference-status-dot"/>安全连接</span>
      <a className="reference-outline-button redeem-mobile-buy" href="/#products">购买卡密</a>
    </div></header>

    <main className="redeem-reference-page">
      <div className="reference-container redeem-reference-grid">
        <aside className="redeem-reference-intro">
          <span className="eyebrow">ACTIVATION CENTER</span>
          <h1>输入卡密<br/><strong>开始自助兑换</strong></h1>
          <p>系统会自动识别套餐、数量与剩余兑换期限。</p>
          <div className="redeem-security-note"><ShieldCheck/><span>账号邮箱和联系方式仅用于本次兑换及售后处理</span></div>
          <div className="redeem-intro-points">
            <span><Check/>卡密一次一用</span>
            <span><Check/>提交后状态可追踪</span>
            <span><Check/>不索取账号密码或验证码</span>
          </div>
          <p className="redeem-intro-note">购买卡密不等于订阅已经开通；兑换申请提交后，仍需等待履约结果。</p>
        </aside>

        <section className="redeem-reference-panel">
          <ol className="redeem-progress" aria-label="兑换步骤">
            {['验证卡密', '提交兑换', '查看进度'].map((label, index) => <li key={label} className={step === index + 1 ? 'active' : step > index + 1 ? 'done' : ''}><span>{step > index + 1 ? <Check/> : index + 1}</span><b>{label}</b></li>)}
          </ol>

          {result ? <div className="reference-result">
            <div className="result-success-icon"><Check/></div>
            <span className="step-label">第三步</span>
            <h2>{result.status === 'completed' ? '履约已完成' : result.status === 'failed' ? '处理遇到问题' : '兑换申请已进入队列'}</h2>
            <p>{result.status === 'completed' ? '处理人员已确认交付结果。' : '系统会自动更新状态，也可以手动刷新。'}</p>
            <div className="task-details">
              <div><span>任务编号</span><strong>{result.id}</strong></div>
              <div><span>兑换账号</span><strong>{result.targetEmail}</strong></div>
              <div><span>当前状态</span><strong className={`status-badge ${result.status}`}>{result.statusLabel}</strong></div>
            </div>
            {result.paymentMode === 'demo' && <div className="reference-demo-note">演示兑换：不会扣款，也不会开通真实订阅。</div>}
            <div className="redemption-credentials reference-credentials"><label>兑换编号<code data-testid="redemption-id">{receipt?.id}</code></label><label>兑换查询码<code data-testid="redemption-key">{receipt?.accessCode}</code></label><button className="text-link" onClick={copy}><Copy size={16}/>复制兑换凭据</button></div>
            <ol className="timeline">{result.events.map(event => <li key={event.id}><span className="timeline-dot"/><div><p>{event.message}</p><small>{date(event.createdAt)}</small></div></li>)}</ol>
            {result.deliveryReference && <p className="delivery-reference">交付或核查凭据：{result.deliveryReference}</p>}
            {['failed', 'review', 'cancelled'].includes(result.status) && <div className="reference-demo-note">{result.status === 'review' ? '正在核查外部处理结果，请勿重复提交。' : '请保留兑换凭据并联系处理人员；后续处理会关联到当前兑换单。'}</div>}
            <div className="result-actions"><button className="reference-outline-button" disabled={busy} onClick={() => receipt && lookup(receipt)}><RefreshCw size={16}/>刷新进度</button><button className="reference-text-button" onClick={reset}>使用新的卡密</button></div>
          </div> : tab === 'track' ? <div className="reference-step">
            <div className="reference-step-heading"><span className="step-label">进度查询</span><h2>查询兑换进度</h2><p>使用兑换时保存的兑换编号和查询码。</p></div>
            <form className="reference-form" onSubmit={event => {
              event.preventDefault();
              const fields = new FormData(event.currentTarget);
              void lookup({ id: String(fields.get('id')).trim().toUpperCase(), accessCode: String(fields.get('accessCode')).trim() });
            }}>
              <label>兑换编号<input name="id" defaultValue={receipt?.id} required maxLength={64}/></label>
              <label>兑换查询码<input name="accessCode" defaultValue={receipt?.accessCode} required maxLength={64}/></label>
              <button className="reference-blue-button full" disabled={busy}>{busy ? <Busy/> : <>查询进度<ArrowRight size={16}/></>}</button>
            </form>
            <button className="reference-text-button redeem-progress-entry" onClick={() => { setTab('redeem'); setError(''); }}>返回验证卡密</button>
          </div> : checked?.redeemable ? <div className="reference-step">
            <div className="verified-product"><span className="result-success-icon small"><Check/></span><div><small>已验证</small><strong>{checked.planName}</strong></div><b>{checked.servicePeriod}</b></div>
            <div className="reference-step-heading"><span className="step-label">第二步</span><h2>确认兑换账号</h2><p>请核对套餐和目标账号。兑换提交后，此卡密将进入占用状态。</p></div>
            <form className="reference-form" onSubmit={redeem}>
              <label>ChatGPT 账号邮箱<input type="email" name="targetEmail" required maxLength={254} placeholder="填写目标账号邮箱"/><small>这里无需填写密码、验证码或 session。</small></label>
              <label>联系方式<input name="contact" required minLength={2} maxLength={100} placeholder="微信号或手机号，用于履约联系"/></label>
              <label className="reference-consent"><input type="checkbox" name="consent" required/><span>我确认有权使用此账号并已核对邮箱；我了解提交兑换不等于订阅已经开通。</span></label>
              <button className="reference-blue-button full" disabled={busy}>{busy ? <Busy label="提交兑换"/> : <>确认兑换，进入队列<ArrowRight size={16}/></>}</button>
              <button type="button" className="reference-text-button" onClick={() => { setChecked(null); setCode(''); }}>更换卡密</button>
              {pendingKey && error && <p className="reference-footnote">请求结果未确认，请使用原邮箱和联系方式重试。查询码：<code>{pendingKey}</code></p>}
            </form>
          </div> : <div className="reference-step">
            <div className="reference-step-heading"><span className="step-label">第一步</span><h2>验证卡密</h2><p>输入购买后获得的完整卡密。</p></div>
            <div className="redeem-quick-actions">
              <button className="tutorial-card" onClick={() => setTutorial(true)}>
                <span className="tutorial-play">▶</span>
                <span><strong>第一次使用？</strong><small>查看兑换操作说明</small></span>
                <b>查看步骤 →</b>
              </button>
              <a href="/#products" className="purchase-card-link"><span>＋</span>购买卡密<ArrowRight size={16}/></a>
              <small>前往商品页购买，已有卡密可直接兑换</small>
            </div>
            <form className="reference-form" onSubmit={check}>
              <label>卡密<input value={code} onChange={event => { setCode(event.target.value); setChecked(null); }} required maxLength={100} autoComplete="off" spellCheck={false} placeholder="XYA-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX"/></label>
              <button className="reference-blue-button full" disabled={busy}>{busy ? <Busy label="校验中"/> : <>验证并继续<ArrowRight size={16}/></>}</button>
            </form>
            <p className="reference-footnote">无法识别？请核对字母、数字和符号是否完整。</p>
            <button className="reference-text-button redeem-progress-entry" onClick={() => { setTab('track'); setError(''); }}><CircleHelp/>查询已有兑换进度</button>
          </div>}
          {notice && <p className="success-message" role="status">{notice}</p>}<ErrorMessage message={error}/>
        </section>
      </div>
      <section className="reference-container reference-support"><div><span className="support-icon"><Headphones/></span><h2>兑换遇到问题？</h2><p>请保留兑换编号和查询码，正式售后入口由运营方配置。</p></div><a className="reference-outline-button" href="/#faq">查看服务帮助<ChevronRight size={16}/></a></section>
    </main>

    {tutorial && <Modal title="兑换前，先看操作说明" eyebrow="ACTIVATION GUIDE" close={closeTutorial} wide>
      <div className="tutorial-guide"><div className="guide-symbols"><Ticket/><Sparkles/><ShieldCheck/></div><ol>{['验证卡密','核对目标账号与联系方式','提交后保存兑换编号和查询码','处理人员核验交付结果'].map((item, index) => <li key={item}><span>{String(index + 1).padStart(2, '0')}</span>{item}</li>)}</ol><div className="reference-demo-note">卡密只可兑换一次。账号密码、验证码和 session 始终留在官方页面。</div><button className="reference-blue-button full" onClick={closeTutorial}>已熟悉流程，开始兑换</button></div>
    </Modal>}
  </>;
}
