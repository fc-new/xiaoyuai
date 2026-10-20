import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Copy, RefreshCw, Ticket, ShieldCheck } from 'lucide-react';
import { api, date, type Redemption, type RedemptionReceipt } from './api';
import { Busy, ErrorMessage, Logo } from './components';
function stored<T>(key: string, fallback: T): T { try { return JSON.parse(sessionStorage.getItem(key) || 'null') || fallback; } catch { return fallback; } }
function save(key: string, value: unknown) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Manual receipt remains available. */ } }
const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
async function fingerprint(code: string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code.toUpperCase().replace(/[\s-]/g, '')))), b => b.toString(16).padStart(2, '0')).join(''); }
interface Checked { planName: string; servicePeriod: string; paymentMode: string; statusLabel: string; expiresAt: string; redeemable: boolean }
export default function Redeem() {
  const [tab, setTab] = useState<'redeem' | 'track'>('redeem'), [code, setCode] = useState('');
  const [checked, setChecked] = useState<Checked | null>(null), [result, setResult] = useState<Redemption | null>(null);
  const [receipt, setReceipt] = useState<RedemptionReceipt | null>(() => stored('xy-redemption', null));
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [pendingKey, setPendingKey] = useState('');
  useEffect(() => {
    if (!receipt || !result || ['completed', 'cancelled'].includes(result.status)) return;
    let active = true;
    const timer = setInterval(() => { void api<{ redemption: Redemption }>('/redemptions/lookup', receipt).then(r => { if (active) setResult(r.redemption); }).catch(() => { if (active) setNotice('进度暂未更新，可以稍后手动刷新。'); }); }, 15000);
    return () => { active = false; clearInterval(timer); };
  }, [receipt, result?.id, result?.status]);
  async function check(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(''); setChecked(null); setPendingKey('');
    try { const value = await api<Checked>('/vouchers/check', { code }); setChecked(value);
      const saved = stored<{ mark: string; key: string } | null>('xy-redemption-attempt', null);
      if (!value.redeemable && saved?.mark === await fingerprint(code)) {
        const recovered = await api<{ redemption: Redemption }>('/redemptions/recover', { code, accessCode: saved.key });
        const credentials = { id: recovered.redemption.id, accessCode: saved.key };
        save('xy-redemption', credentials); setReceipt(credentials); setResult(recovered.redemption); setCode(''); return;
      }
      if (!value.redeemable) setError(`此卡密${value.statusLabel}。已提交的兑换请使用兑换凭据查询。`); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function redeem(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (busy) return; setBusy(true); setError('');
    const form = new FormData(e.currentTarget);
    try {
      const mark = await fingerprint(code);
      const saved = stored<{ mark: string; key: string } | null>('xy-redemption-attempt', null);
      const requestKey = saved?.mark === mark ? saved.key : newKey();
      save('xy-redemption-attempt', { mark, key: requestKey }); setPendingKey(requestKey);
      const response = await api<{ redemption: Redemption }>('/vouchers/redeem', { code, targetEmail: String(form.get('targetEmail')).trim(), contact: form.get('contact'), consent: form.get('consent') === 'on', requestKey });
      const credentials = { id: response.redemption.id, accessCode: requestKey };
      save('xy-redemption', credentials); setReceipt(credentials); setResult(response.redemption); setCode(''); setChecked(null); setPendingKey('');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function lookup(credentials: RedemptionReceipt) {
    setBusy(true); setError(''); setNotice('');
    try { const value = await api<{ redemption: Redemption }>('/redemptions/lookup', credentials); setResult(value.redemption); setReceipt(credentials); save('xy-redemption', credentials); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function copy() {
    if (!receipt) return;
    try { await navigator.clipboard.writeText(`xiaoyu AI 兑换凭据\n兑换编号：${receipt.id}\n兑换查询码：${receipt.accessCode}\n查询入口：${location.origin}/redeem`); setNotice('兑换凭据已复制。'); }
    catch { setNotice('请手动保存兑换编号和查询码。'); }
  }
  return <><header className="container admin-header"><Logo/><a href="/#plans" className="text-link">购买卡密<ArrowRight size={16}/></a></header><main className="container redeem-page"><div className="redeem-heading"><div className="eyebrow">YOUR NEXT CHAPTER</div><h1>兑换卡密，开始下一步<span className="orange-dot">。</span></h1><p>确认账号、提交申请，随时查看每一步处理进度。</p></div>
    <div className="redeem-layout"><aside className="redeem-guide"><Ticket size={32}/><h2>每一步，清楚可见。</h2><ol>{['校验卡密与对应套餐', '核对账号邮箱及联系方式', '提交兑换，进入人工履约队列', '核实交付，查询处理结果'].map(step => <li key={step}>{step}</li>)}</ol><div className="form-info"><ShieldCheck size={20}/><p>这里填写账号邮箱即可。密码、验证码和银行卡资料请保留在官方页面。</p></div><p>卡密是本站服务凭证。购买成功、提交兑换和实际开通是三个独立步骤。</p><a href="/#faq" className="text-link">服务说明与售后<ArrowRight size={16}/></a></aside>
    <section className="redeem-panel"><div className="filter-tabs"><button className={tab === 'redeem' ? 'selected' : ''} onClick={() => { setTab('redeem'); setResult(null); setError(''); }}>兑换卡密</button><button className={tab === 'track' ? 'selected' : ''} onClick={() => { setTab('track'); setResult(null); setError(''); }}>查询履约进度</button></div>
    {result ? <div className="redemption-result"><span className="status-badge">{result.statusLabel}</span><h2>{result.planName}</h2><p>目标账号：{result.targetEmail} · 服务周期 {result.servicePeriod}</p>{result.paymentMode === 'demo' && <div className="demo-notice">演示兑换 · 不实际扣款或开通订阅</div>}
      <div className="redemption-credentials"><label>兑换编号<code data-testid="redemption-id">{receipt?.id}</code></label><label>兑换查询码<code data-testid="redemption-key">{receipt?.accessCode}</code></label><button className="text-link" onClick={copy}><Copy size={16}/>复制兑换凭据</button></div><p className="form-footnote">查询码用于查看本次履约进度，请保存。它与购买订单查询码不同；当前不发送邮件。</p>
      <ol className="timeline">{result.events.map(ev => <li key={ev.id}><span className="timeline-dot"/><div><p>{ev.message}</p><small>{date(ev.createdAt)}</small></div></li>)}</ol>{result.deliveryReference && <p>交付或核查凭据：{result.deliveryReference}</p>}
      {['failed', 'review', 'cancelled'].includes(result.status) && <p className="form-info">{result.status === 'review' ? '正在核查外部处理结果，请勿重复提交。' : '请保留兑换凭据，回复处理专员的联系消息；后续将在原兑换单重试或处理售后。'}</p>}
      <button className="button secondary full" disabled={busy} onClick={() => receipt && lookup(receipt)}><RefreshCw size={16}/>刷新履约进度</button>
    </div> : tab === 'track' ? <form className="form-stack" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); void lookup({ id: String(f.get('id')).trim().toUpperCase(), accessCode: String(f.get('accessCode')).trim() }); }}><h2>查询你的履约进度</h2><label>兑换编号<input name="id" defaultValue={receipt?.id} required maxLength={64}/></label><label>兑换查询码<input name="accessCode" defaultValue={receipt?.accessCode} required maxLength={64}/></label><button className="button primary" disabled={busy}>{busy ? <Busy/> : '查询履约进度'}</button></form> : <>
      <form className="form-stack" onSubmit={check}><h2>01 · 校验卡密</h2><label>兑换卡密<input value={code} onChange={e => { setCode(e.target.value); setChecked(null); }} autoComplete="off" spellCheck={false} required maxLength={100} placeholder="XYA-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX"/></label><button className="button secondary" disabled={busy}>{busy ? <Busy/> : '校验卡密'}</button></form>
      {checked?.redeemable && <form className="form-stack redemption-form" onSubmit={redeem}><div className="demo-notice">{checked.planName} · {checked.servicePeriod} · {checked.paymentMode === 'demo' ? '演示卡密' : '有效卡密'}<br/>兑换截止 {date(checked.expiresAt)}</div><h2>02 · 确认目标账号</h2><label>账号邮箱<input name="targetEmail" type="email" required maxLength={254} placeholder="目标账号邮箱"/></label><label>兑换联系方式<input name="contact" required minLength={2} maxLength={100} placeholder="微信号或其他联系方式"/></label><label className="checkbox-label"><input type="checkbox" name="consent" required/><span>我确认有权使用此账号，邮箱填写正确，并了解兑换提交后进入人工履约队列，尚未完成订阅开通。</span></label><button className="button primary" disabled={busy}>{busy ? <Busy/> : '确认兑换，进入队列'}</button></form>}
    </>}{pendingKey && error && <p className="form-footnote">请求结果未确认，请保持原邮箱及联系方式再次提交。当前重试查询码：<code>{pendingKey}</code></p>}{notice && <p role="status">{notice}</p>}<ErrorMessage message={error}/></section></div></main></>;
}
