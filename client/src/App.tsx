import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, ArrowUpRight, Check, Copy, ExternalLink, KeyRound, LockKeyhole, RefreshCw, Search, ShieldCheck, Sparkles, Ticket, Trash2, X } from 'lucide-react';
import { api, date } from './api';
import { MAX_SESSION_CHARACTERS, SESSION_LENGTH_ERROR } from '../../shared/session-limits';
import { Busy, ErrorMessage, Logo, Modal } from './components';

export interface ActivationJob {
  id: string; accountEmail: string; status: string; statusLabel: string; planId: string; planName: string;
  isDemo: boolean; codeSuffix: string; sessionAvailable: boolean; sessionExpiresAt: string | null;
  deliveryReference: string | null; createdAt: string; updatedAt: string; completedAt: string | null;
  events: { id: string; kind: string; message: string; createdAt: string }[];
}
interface Receipt { id: string; accessCode: string }
interface CheckedCode { planName: string; isDemo: boolean; status: string; redeemable: boolean }
function readReceipt(): Receipt | null { try { return JSON.parse(sessionStorage.getItem('xy-activation-receipt') || 'null'); } catch { return null; } }
function getAttemptKey() {
  try { const saved = sessionStorage.getItem('xy-activation-request'); if (saved && /^[a-f0-9]{32}$/.test(saved)) return saved; } catch { /* Optional session storage. */ }
  const key = crypto.randomUUID().replaceAll('-', '');
  try { sessionStorage.setItem('xy-activation-request', key); } catch { /* Remains in memory for retries. */ }
  return key;
}
export default function App() {
  const [code, setCode] = useState('');
  const [session, setSession] = useState('');
  const [updatedSession, setUpdatedSession] = useState('');
  const [checked, setChecked] = useState<CheckedCode | null>(null);
  const [job, setJob] = useState<ActivationJob | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(readReceipt);
  const [attemptKey, setAttemptKey] = useState(getAttemptKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<'lookup' | 'help' | 'privacy' | null>(null);
  const [showUpdate, setShowUpdate] = useState(false);
  const updateForm = useRef<HTMLFormElement>(null);
  const close = useCallback(() => setDialog(null), []);
  function saveReceipt(value: Receipt) { setReceipt(value); try { sessionStorage.setItem('xy-activation-receipt', JSON.stringify(value)); } catch { /* Save manually from the visible receipt. */ } }
  async function checkCode() {
    setBusy(true); setError(''); setChecked(null);
    try {
      const result = await api<CheckedCode>('/activation/check', { code }); setChecked(result);
      if (result.status === 'redeemed') {
        try {
          const recovered = await api<{ job: ActivationJob }>('/activation/recover', { code, requestKey: attemptKey });
          setJob(recovered.job); saveReceipt({ id: recovered.job.id, accessCode: attemptKey }); setSession('');
          setNotice('已恢复此浏览器提交的兑换任务。'); return;
        } catch { /* Another browser must use its saved receipt. */ }
      }
      if (!result.redeemable) setError(result.status === 'redeemed' ? '此卡密已兑换。请使用兑换编号和查询码查看进度。' : result.status === 'expired' ? '此卡密已过期，请联系发卡商家。' : '此卡密已禁用，请联系发卡商家。');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (busy || !checked?.redeemable) return;
    if (session.length > MAX_SESSION_CHARACTERS) { setError(SESSION_LENGTH_ERROR); return; }
    setBusy(true); setError(''); setNotice('');
    const consent = new FormData(e.currentTarget).get('consent') === 'on';
    try {
      const result = await api<{ job: ActivationJob }>('/activation/redeem', { code, session, consent, requestKey: attemptKey });
      setJob(result.job); saveReceipt({ id: result.job.id, accessCode: attemptKey }); setSession(''); setCode(''); setChecked(null);
      setNotice('兑换申请已提交，请保存下方查询凭据。实际开通结果以履约记录为准。');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const lookup = useCallback(async (credentials: Receipt, quiet = false) => {
    if (!quiet) { setBusy(true); setError(''); }
    try { const result = await api<{ job: ActivationJob }>('/activation/lookup', credentials); setJob(result.job); saveReceipt(credentials); if (!quiet) setDialog(null); }
    catch (e) { if (!quiet) setError((e as Error).message); }
    finally { if (!quiet) setBusy(false); }
  }, []);
  useEffect(() => {
    if (!job || !receipt || ['completed', 'failed'].includes(job.status)) return;
    const interval = setInterval(() => { void lookup(receipt, true); }, 20000);
    return () => clearInterval(interval);
  }, [job?.id, job?.status, receipt, lookup]);
  async function copy() {
    if (!receipt) return;
    try { await navigator.clipboard.writeText(`xiaoyu AI 兑换凭据\n兑换编号：${receipt.id}\n查询码：${receipt.accessCode}\n查询网址：${location.origin}`); setNotice('查询凭据已复制，请妥善保存。'); }
    catch { setNotice('复制失败，请手动保存兑换编号与查询码。'); }
  }
  async function deleteSession() {
    if (!receipt) return; setBusy(true); setError('');
    try { const result = await api<{ job: ActivationJob }>('/activation/delete-session', receipt); setJob(result.job); setNotice('本站保存的临时 session 已删除。此操作不会注销官方账号。'); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function updateSession(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (!receipt) return;
    if (updatedSession.length > MAX_SESSION_CHARACTERS) { setError(SESSION_LENGTH_ERROR); return; }
    setBusy(true); setError('');
    const form = new FormData(e.currentTarget);
    try {
      const result = await api<{ job: ActivationJob }>('/activation/session', { ...receipt, session: form.get('session'), consent: form.get('consent') === 'on' });
      setJob(result.job); updateForm.current?.reset(); setUpdatedSession(''); setShowUpdate(false); setNotice('session 已更新，等待继续处理。');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <>
    <div className="announcement"><span className="status-dot"/>卡密兑换服务 · 卡密由外部商家提供 · 本站不销售卡密<ArrowUpRight size={13}/></div>
    <header className="site-header"><div className="container nav-row"><Logo/><nav className="activation-nav" aria-label="主导航"><a href="/" className="active">兑换中心</a><button onClick={() => setDialog('help')}>使用帮助<ExternalLink size={13}/></button></nav><button className="nav-order" onClick={() => { setError(''); setDialog('lookup'); }}><Search size={16}/>查询进度<ArrowUpRight size={15}/></button></div></header>
    <main className="container activation-layout">
      <section className="activation-intro"><div className="eyebrow"><Sparkles size={15}/> XIAOYU AI / ACTIVATE YOUR IDEAS</div><h1>一张卡密，<br/>开启<span>下一程。</span></h1><p className="activation-lead">给灵感续航，让创造继续。</p><p className="activation-description">准备好卡密与账号 session。<br/>提交一次授权，每一步进度都看得见。</p>
        <div className="activation-art" aria-hidden="true"><div className="activation-art-orbit"/><div className="activation-art-card"><div>xiaoyu <b>AI</b><span>ACTIVATION / 01</span></div><span className="activation-star">✳</span><strong>MORE ROOM<br/>FOR YOUR IDEAS.</strong><footer><span>ONE CODE. NEXT CHAPTER.</span><ArrowUpRight size={19}/></footer></div><span className="activation-art-chip"><Check size={15}/>每一步，都有记录</span></div>
        <ol className="activation-steps">{['校验卡密', '授权提交', '排队处理', '结果确认'].map((step, i) => <li key={step}><span>0{i + 1}</span>{step}{i < 3 && <ArrowRight size={13}/>}</li>)}</ol>
      </section>
      <section className="activation-panel" aria-label="卡密兑换">
        {job ? <>
          <div className="panel-eyebrow"><span>YOUR ACTIVATION</span><span>↗</span></div><div className="job-heading"><span className={`status-badge ${job.status}`}>{job.statusLabel}</span><h2>{job.planName}</h2><p>开通账号：{job.accountEmail}</p></div>
          {job.isDemo && <div className="demo-notice">演示任务 · 不进行实际扣款或订阅开通</div>}
          <div className="activation-receipt"><div><small>兑换编号</small><code>{receipt?.id}</code></div><div><small>专属查询码（请保存）</small><code>{receipt?.accessCode}</code></div><button className="text-link" onClick={copy}><Copy size={15}/>复制查询凭据</button></div>
          <p className="form-footnote">平台不会自动发邮件，请保存此凭据。刷新页面后可通过「查询进度」继续查看。</p>
          <ol className="timeline activation-timeline">{job.events.map(event => <li key={event.id}><span className="timeline-dot"/><div><p>{event.message}</p><small>{date(event.createdAt)}</small></div></li>)}</ol>
          {job.deliveryReference && <div className="delivery-reference"><ShieldCheck size={18}/><div><small>交付凭据编号</small><strong>{job.deliveryReference}</strong></div></div>}
          {job.sessionAvailable && <div className="session-meta"><LockKeyhole size={15}/><span>临时 session 保存至 {job.sessionExpiresAt && date(job.sessionExpiresAt)}</span><button onClick={deleteSession} disabled={busy} aria-label="删除临时 session"><Trash2 size={14}/>删除</button></div>}
          {notice && <p className="success-message" role="status">{notice}</p>}<ErrorMessage message={error}/>
          <div className="job-buttons"><button className="button secondary" disabled={busy} onClick={() => receipt && lookup(receipt)}><RefreshCw size={15}/>刷新进度</button>{!['completed', 'failed'].includes(job.status) && <button className="button primary" onClick={() => { setUpdatedSession(''); setShowUpdate(!showUpdate); }}>更新 session<ArrowRight size={16}/></button>}</div>
          {showUpdate && <form className="form-stack update-session-form" ref={updateForm} onSubmit={updateSession}><label>更新 session<textarea name="session" value={updatedSession} onChange={e => setUpdatedSession(e.target.value)} required rows={5} autoComplete="off" spellCheck={false} placeholder={job.isDemo ? 'DEMO_SESSION' : '粘贴原账号最新的 session JSON'}/></label><p className="session-length-hint" aria-live="polite">{updatedSession.length.toLocaleString()} / {MAX_SESSION_CHARACTERS.toLocaleString()} 字符 · 完整粘贴，不截断</p>{updatedSession.length > MAX_SESSION_CHARACTERS && <ErrorMessage message={SESSION_LENGTH_ERROR}/>}<label className="checkbox-label"><input type="checkbox" name="consent" required/><span>我再次授权本站运营方仅为本次开通使用此临时凭据，最多可使用 30 分钟，过期后禁止读取并清理。</span></label><button className="button primary full" disabled={busy || updatedSession.length > MAX_SESSION_CHARACTERS}>{busy ? <Busy/> : '提交更新'}</button></form>}
          <button className="text-link another-code" onClick={() => { setJob(null); setError(''); setNotice(''); setShowUpdate(false); const key = crypto.randomUUID().replaceAll('-', ''); setAttemptKey(key); try { sessionStorage.setItem('xy-activation-request', key); } catch { /* Keep in memory. */ } }}>兑换另一张卡密<ArrowUpRight size={15}/></button>
        </> : <>
          <div className="panel-eyebrow"><span>START YOUR NEXT CHAPTER</span><span>01 — 02</span></div><h2>兑换你的服务卡密</h2><p className="panel-description">只需两项信息，提交后即可查询处理进度。</p>
          <form className="form-stack activation-form" onSubmit={submit}>
            <label><span className="field-heading"><span><i>01</i>兑换卡密</span><Ticket size={17}/></span><div className="code-input-row"><input name="code" value={code} onChange={e => { setCode(e.target.value); setChecked(null); setSession(''); }} placeholder="输入商家提供的完整卡密" required minLength={12} maxLength={120} autoComplete="off" spellCheck={false}/><button type="button" className="button secondary" onClick={checkCode} disabled={busy || code.trim().length < 12}>{busy ? <Busy label="校验"/> : '校验卡密'}</button></div></label>
            {checked?.redeemable && <div className="code-verified" role="status"><Check size={16}/><span>{checked.planName}<small>{checked.isDemo ? '演示卡密 · 请使用演示 session' : '卡密可兑换 · 账号有效性将在履约时核实'}</small></span></div>}
            <label><span className="field-heading"><span><i>02</i>账号 session</span><LockKeyhole size={17}/></span><textarea name="session" value={session} onChange={e => setSession(e.target.value)} required rows={6} disabled={!checked?.redeemable} placeholder={checked?.isDemo ? '点击下方按钮填入演示 session' : '粘贴完整的 session JSON，仅用于本次授权开通'} autoComplete="off" autoCorrect="off" spellCheck={false}/></label><p className="session-length-hint" aria-live="polite">{session.length.toLocaleString()} / {MAX_SESSION_CHARACTERS.toLocaleString()} 字符 · 完整粘贴，不截断</p>{session.length > MAX_SESSION_CHARACTERS && <ErrorMessage message={SESSION_LENGTH_ERROR}/>}
            {checked?.isDemo ? <button type="button" className="text-link demo-fill" onClick={() => setSession('DEMO_SESSION')}>填入演示 session<Sparkles size={14}/></button> : <button type="button" className="text-link session-help" onClick={() => setDialog('help')}>如何获取 session？<ExternalLink size={13}/></button>}
            <div className="session-consent-note"><ShieldCheck size={18}/><p>session 具有账号访问权限。仅提交你有权使用的账号凭据，授权本站运营方为本次开通使用；加密后最多可使用 30 分钟，任务结束后删除。</p></div>
            <label className="checkbox-label"><input type="checkbox" name="consent" required/><span>我已阅读<button type="button" onClick={() => setDialog('privacy')}>授权与隐私说明</button>，同意本次使用，了解提交兑换不代表订阅已经到账。</span></label>
            <ErrorMessage message={error}/><button className="button primary full activation-submit" disabled={busy || !checked?.redeemable || !session.trim() || session.length > MAX_SESSION_CHARACTERS}>{busy ? <Busy label="提交兑换"/> : <>提交兑换申请<ArrowRight size={17}/></>}</button>
          </form>
          <div className="panel-bottom"><KeyRound size={14}/>一次兑换 · 一笔任务 · 全程可查</div>
        </>}
      </section>
    </main>
    <section className="container activation-service-note"><ShieldCheck size={18}/><p>xiaoyu AI 为独立协助服务，与 OpenAI 无隶属关系。卡密由外部商家发放；账号适用条件与订阅权益以官方为准，实际开通需完成官方结算。</p></section>
    <footer className="container activation-footer"><span>© {new Date().getFullYear()} xiaoyu AI · 给灵感，留一点可能。</span><div><button onClick={() => setDialog('help')}>使用帮助</button><button onClick={() => setDialog('privacy')}>授权与隐私</button><a href="/redeem">历史卡密兑换</a><a href="/admin">管理后台<ArrowUpRight size={12}/></a></div></footer>
    {dialog === 'lookup' && <Modal title="每一步，随时回来查看。" eyebrow="TRACK YOUR ACTIVATION" close={close}><form className="form-stack" onSubmit={e => { e.preventDefault(); const form = new FormData(e.currentTarget); void lookup({ id: String(form.get('id')).trim().toUpperCase(), accessCode: String(form.get('accessCode')).trim() }); }}><label>兑换编号<input name="id" placeholder="XR 开头的兑换编号" defaultValue={receipt?.id} maxLength={64} required/></label><label>专属查询码<input name="accessCode" placeholder="兑换时保存的查询码" defaultValue={receipt?.accessCode} maxLength={64} required/></label><ErrorMessage message={error}/><button className="button primary full" disabled={busy}>{busy ? <Busy/> : <>查询进度<Search size={16}/></>}</button></form></Modal>}
    {dialog === 'help' && <Modal title="准备好，再开启下一步。" eyebrow="A LITTLE HELP" close={close}><div className="legal-content"><h3>1. 准备卡密</h3><p>请向你的发卡商家获取卡密。商家需要先将卡密导入本站数据库，校验通过后才能兑换。本站不提供购买入口。</p><h3>2. 获取自己的 session</h3><p>先在 ChatGPT 官方网站登录你有权使用的账号，然后在同一浏览器打开下面的官方地址，复制返回的完整 JSON。请在了解其账号访问权限后再提交。</p><a className="official-session-link" href="https://chatgpt.com/api/auth/session" target="_blank" rel="noreferrer">chatgpt.com/api/auth/session<ExternalLink size={14}/></a><p>如果只看到空对象，请确认官方账号已登录。本站仅检查格式和保存期限，无法据此保证账号资格或支付成功。</p><h3>3. 提交与查询</h3><p>兑换成功后，请保存兑换编号和查询码。任务进入处理队列，运营方通过官方支持的结算流程协助开通；结果和交付凭据会记录在进度页。</p><h3>session 过期或开通失败</h3><p>可在进度页为同一账号更新 session，或删除本站临时副本。卡密不会因更新 session 再次兑换。失败或售后请凭兑换编号联系原发卡商家。</p></div></Modal>}
    {dialog === 'privacy' && <Modal title="一次授权，范围写清楚。" eyebrow="CONSENT & PRIVACY" close={close}><div className="legal-content"><p>本服务会接收你主动提供的账号 session，其中的 accessToken 可能允许访问账号。提交表示你有权授权本站运营方，仅为本次订阅开通使用该临时凭据。</p><h3>保存哪些信息</h3><p>系统保存卡密哈希、账号邮箱、任务进度、授权记录和交付凭据编号。完整 session JSON 不入库，仅提取 accessToken 加密保存；不将 session 写入日志或浏览器存储。</p><h3>临时凭据的期限</h3><p>本站临时凭据最多可读取 30 分钟，超过 session 标注期限时更早失效。到期后禁止读取；后台运行时定时清理，服务休眠时在恢复后清理。任务结束或用户主动删除会立即清空数据库密文字段。备份副本按运营方备份策略保留。删除本站副本不会撤销已读取的官方凭据；如需撤销账号访问，请使用官方账号安全设置。</p><h3>谁可以访问</h3><p>只有登录后台并重新验证管理密码的运营方可按任务读取临时凭据，读取行为会留在客户可见记录中。本站不接收银行卡号、CVV 或短信验证码，实际付款应在官方收银台完成。</p><h3>实际交付与售后</h3><p>卡密校验和任务提交均不代表官方充值成功。完成状态由运营方凭实际官方结算结果及交付凭据确认。请保存兑换凭据，并联系原发卡商家处理售后、资料更正或删除请求。</p></div></Modal>}
  </>;
}
