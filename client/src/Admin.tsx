import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, Copy, Download, KeyRound, LockKeyhole, LogOut, Package, RefreshCw, ShieldCheck, Ticket } from 'lucide-react';
import { api, date } from './api';
import { Busy, ErrorMessage, Logo, Modal } from './components';
import type { ActivationJob } from './App';

interface Card { id: string; suffix: string; planId: string; planName: string; status: string; isDemo: boolean; source: string; expiresAt: string | null; createdAt: string }
interface Jobs { jobs: ActivationJob[]; total: number; page: number; stats: Record<string, number> }
interface Cards { codes: Card[]; page: number; stats: { total: number; ready: number; redeemed: number } }
const statuses = [['', '全部任务'], ['queued', '待处理'], ['processing', '处理中'], ['needs_session', '待更新 session'], ['needs_review', '待核实'], ['completed', '已完成'], ['failed', '未完成']];
export default function Admin() {
  const [authenticated, setAuthenticated] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [tab, setTab] = useState<'jobs' | 'codes'>('jobs');
  const [jobs, setJobs] = useState<Jobs | null>(null);
  const [cards, setCards] = useState<Cards | null>(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<ActivationJob | null>(null);
  const [dialog, setDialog] = useState<'generate' | 'import' | null>(null);
  const [generated, setGenerated] = useState<string[]>([]);
  const [revealed, setRevealed] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [plans, setPlans] = useState<{ id: string; name: string }[]>([]);
  const [nextStatus, setNextStatus] = useState('processing');
  const close = useCallback(() => { setSelected(null); setDialog(null); setRevealed(''); setActionError(''); }, []);
  useEffect(() => { if (!revealed) return; const timer = setTimeout(() => setRevealed(''), 60000); return () => clearTimeout(timer); }, [revealed]);
  const load = useCallback(async () => {
    setError('');
    try {
      if (tab === 'jobs') setJobs(await api<Jobs>(`/admin/activation/jobs?status=${encodeURIComponent(status)}&page=${page}`));
      else setCards(await api<Cards>(`/admin/activation/codes?page=${page}`));
      setAuthenticated(true);
      setPlans((await api<{ plans: typeof plans }>('/activation/config')).plans);
    } catch (e) { const message = (e as Error).message; if (message.includes('登录')) setAuthenticated(false); else setError(message); }
    finally { setInitializing(false); }
  }, [tab, status, page]);
  useEffect(() => { void load(); }, [load]);
  async function login(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setError('');
    try { await api('/admin/login', { password: new FormData(e.currentTarget).get('password') }); await load(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function logout() {
    try { await api('/admin/logout', {}); setAuthenticated(false); setJobs(null); setCards(null); setSelected(null); setRevealed(''); setGenerated([]); }
    catch (e) { setError((e as Error).message); }
  }
  async function openJob(id: string) {
    setActionError(''); setError(''); setRevealed('');
    try { const { job } = await api<{ job: ActivationJob }>(`/admin/activation/jobs/${id}`); setSelected(job); setNextStatus(job.status === 'processing' ? 'completed' : job.status === 'needs_session' ? 'needs_review' : 'processing'); }
    catch (e) { setError((e as Error).message); }
  }
  async function update(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (!selected) return; setBusy(true); setActionError(''); setRevealed('');
    const f = new FormData(e.currentTarget);
    try {
      const { job } = await api<{ job: ActivationJob }>(`/admin/activation/jobs/${selected.id}`, { status: f.get('status'), note: f.get('note'), deliveryReference: f.get('deliveryReference') || undefined, confirmed: f.get('confirmed') === 'on' }, 'PATCH');
      setSelected(job); setNextStatus(job.status === 'processing' ? 'completed' : job.status === 'needs_session' ? 'needs_review' : 'processing'); await load();
    } catch (e) { setActionError((e as Error).message); } finally { setBusy(false); }
  }
  async function reveal(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (!selected) return;
    const form = e.currentTarget; const password = new FormData(form).get('password'); setBusy(true); setActionError('');
    try { const response = await api<{ accessToken: string }>(`/admin/activation/jobs/${selected.id}/session`, { password }); setRevealed(response.accessToken); }
    catch (e) { setActionError((e as Error).message); } finally { form.reset(); setBusy(false); }
  }
  async function saveBatch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = e.currentTarget; const f = new FormData(form); setBusy(true); setActionError('');
    const input = { planId: f.get('planId'), isDemo: f.get('kind') === 'demo', source: f.get('source'), expiresAt: f.get('expiresAt') ? new Date(String(f.get('expiresAt'))).toISOString() : null };
    try {
      if (dialog === 'generate') {
        const response = await api<{ codes: string[] }>('/admin/activation/codes/generate', { ...input, count: Number(f.get('count')) });
        setGenerated(response.codes); setNotice(`已生成 ${response.codes.length} 张卡密，请立即下载保存。`);
      } else {
        const codes = String(f.get('codes')).split(/\r?\n/).map(c => c.trim()).filter(Boolean);
        const response = await api<{ imported: number }>('/admin/activation/codes/import', { ...input, codes });
        setNotice(`已导入 ${response.imported} 张卡密。`);
      }
      form.reset(); setDialog(null); await load();
    } catch (e) { setActionError((e as Error).message); } finally { setBusy(false); }
  }
  function download() {
    const blob = new Blob([generated.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `xiaoyu-ai-codes-${new Date().toISOString().slice(0, 10)}.txt`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function toggleCard(card: Card) {
    setError(''); try { await api(`/admin/activation/codes/${card.id}`, { status: card.status === 'disabled' ? 'ready' : 'disabled' }, 'PATCH'); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  return <div className="admin-page activation-admin"><header className="admin-header container"><Logo/><a className="text-link" href="/"><ArrowLeft size={15}/>返回前台</a>{authenticated && <button className="text-link" onClick={logout}><LogOut size={15}/>退出登录</button>}</header>
    {initializing ? <div className="admin-login"><Busy label="加载工作台"/></div> : !authenticated ? <main className="admin-login"><div className="admin-login-icon"><ShieldCheck size={28}/></div><div className="eyebrow">XIAOYU AI WORKSPACE</div><h1>每一次交付，认真对待。</h1><p>登录 xiaoyu AI 卡密与履约工作台</p><form className="form-stack" onSubmit={login}><label>管理密码<input name="password" type="password" autoComplete="current-password" required maxLength={256}/></label><ErrorMessage message={error}/><button className="button primary full" disabled={busy}>{busy ? <Busy/> : <>进入工作台<ArrowRight size={17}/></>}</button></form><p className="form-footnote">管理密码由部署管理员配置。Render 部署可在私有 Environment 配置中查看 ADMIN_PASSWORD。</p></main> : <main className="container admin-main">
      <div className="section-heading"><div><div className="eyebrow">CODES IN. CARE THROUGHOUT.</div><h1>xiaoyu AI 工作台<span className="orange-dot">。</span></h1><p>外部发卡、一次兑换、授权履约，全程留档。</p></div><button className="button secondary" onClick={load}><RefreshCw size={16}/>刷新数据</button></div>
      <div className="workspace-tabs"><button className={tab === 'jobs' ? 'selected' : ''} onClick={() => { setTab('jobs'); setPage(1); }}><Package size={17}/>履约任务</button><button className={tab === 'codes' ? 'selected' : ''} onClick={() => { setTab('codes'); setPage(1); }}><Ticket size={17}/>卡密管理</button><a className="text-link" href="/admin/orders">历史购买订单<ArrowRight size={14}/></a></div>
      <ErrorMessage message={error}/>{notice && <p className="success-message" role="status">{notice}</p>}
      {tab === 'codes' ? <>
        <div className="code-workspace-top"><div><h2>卡密库存</h2><p>共 {cards?.stats.total || 0} 张 · 未兑换 {cards?.stats.ready || 0} 张 · 已兑换 {cards?.stats.redeemed || 0} 张</p></div><div><button className="button secondary" onClick={() => { setDialog('import'); setActionError(''); }}>批量导入</button><button className="button primary" onClick={() => { setDialog('generate'); setActionError(''); }}><KeyRound size={16}/>生成卡密</button></div></div>
        {generated.length > 0 && <div className="generated-codes"><div><strong>本批次卡密仅在这里显示一次</strong><p>数据库只保存哈希，关闭或刷新后无法找回完整卡密。</p></div><textarea aria-label="本批次完整卡密" readOnly value={generated.join('\n')} rows={5}/><div><button className="button primary" onClick={download}><Download size={16}/>下载卡密 TXT</button><button className="button secondary" onClick={() => setGenerated([])}>我已保存，关闭显示<Check size={15}/></button></div></div>}
        <div className="admin-table-card"><div className="table-scroll"><table><thead><tr><th>卡密尾号 / 创建时间</th><th>套餐 / 类型</th><th>来源</th><th>状态 / 到期时间</th><th>操作</th></tr></thead><tbody>{cards?.codes.map(card => <tr key={card.id}><td><code>•••• {card.suffix}</code><small>{date(card.createdAt)}</small></td><td>{card.planName}<small>{card.isDemo ? '演示卡密' : '正式服务卡密'}</small></td><td>{card.source}</td><td>{card.status === 'ready' ? card.expiresAt && card.expiresAt <= new Date().toISOString() ? '已过期' : '未兑换' : card.status === 'redeemed' ? '已兑换' : '已禁用'}<small>{card.expiresAt ? date(card.expiresAt) : '不设到期时间'}</small></td><td>{card.status !== 'redeemed' && <button className="text-link" onClick={() => toggleCard(card)}>{card.status === 'disabled' ? '恢复卡密' : '禁用卡密'}</button>}</td></tr>)}</tbody></table></div>{!cards?.codes.length && <div className="empty-state"><Ticket size={30}/><h3>先准备你的卡密</h3><p>导入第三方卡密，或生成卡密后分发给外部销售渠道。</p></div>}<div className="pagination"><span>第 {page} 页</span><div><button className="button secondary small" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</button><button className="button secondary small" disabled={page * 30 >= (cards?.stats.total || 0)} onClick={() => setPage(p => p + 1)}>下一页</button></div></div></div>
      </> : <>
        <div className="stats-grid">{[['待处理', jobs?.stats.queued || 0], ['处理中', jobs?.stats.processing || 0], ['需客户更新', jobs?.stats.needs_session || 0], ['已完成', jobs?.stats.completed || 0]].map(([label, value]) => <div className="stat-card" key={label}><Package size={20}/><span>{label}</span><strong>{value}</strong></div>)}</div>
        <div className="admin-table-card"><div className="admin-toolbar"><div className="filter-tabs">{statuses.map(([value, label]) => <button key={value} className={status === value ? 'selected' : ''} onClick={() => { setStatus(value); setPage(1); }}>{label}</button>)}</div></div><div className="table-scroll"><table><thead><tr><th>兑换编号 / 创建时间</th><th>账号 / 套餐</th><th>临时 session</th><th>状态</th><th>操作</th></tr></thead><tbody>{jobs?.jobs.map(job => <tr key={job.id}><td><code>{job.id}</code><small>{date(job.createdAt)} {job.isDemo && <span className="demo-tag">演示</span>}</small></td><td>{job.accountEmail}<small>{job.planName} · 卡密尾号 {job.codeSuffix}</small></td><td>{job.sessionAvailable ? '已加密保存' : '已删除 / 待更新'}<small>{job.sessionAvailable && job.sessionExpiresAt ? `保存至 ${date(job.sessionExpiresAt)}` : '不在列表展示凭据'}</small></td><td><span className={`status-badge ${job.status}`}>{job.statusLabel}</span></td><td><button className="text-link" onClick={() => openJob(job.id)}>查看任务<ArrowRight size={14}/></button></td></tr>)}</tbody></table></div>{!jobs?.jobs.length && <div className="empty-state"><Package size={30}/><h3>这里还没有任务</h3><p>客户使用卡密兑换后，会进入此队列。</p></div>}<div className="pagination"><span>共 {jobs?.total || 0} 笔 · 第 {page} 页</span><div><button className="button secondary small" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</button><button className="button secondary small" disabled={page * 30 >= (jobs?.total || 0)} onClick={() => setPage(p => p + 1)}>下一页</button></div></div></div>
        <p className="form-footnote">本系统校验卡密并管理授权履约。实际万事达付款请通过官方收银台完成；仅在核实真实交付后确认完成，填写可供售后查证的凭据编号。</p>
      </>}
    </main>}
    {dialog && <Modal title={dialog === 'generate' ? '生成一批服务卡密' : '导入外部卡密'} eyebrow="CODE INVENTORY" close={close}><form className="form-stack" onSubmit={saveBatch}><label>服务套餐<select name="planId">{plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select></label><label>卡密类型<select name="kind" defaultValue="demo"><option value="demo">演示卡密（不进行实际充值）</option><option value="real">正式服务卡密（人工实际履约）</option></select></label><label>来源 / 批次说明<input name="source" required maxLength={80} placeholder="例如：第三方店铺 · 第一批"/></label><label>到期时间（可不填）<input type="datetime-local" name="expiresAt"/></label>{dialog === 'generate' ? <label>生成数量<input type="number" name="count" min={1} max={500} defaultValue={10} required/></label> : <label>卡密列表（一行一张）<textarea name="codes" rows={7} required autoComplete="off" spellCheck={false} placeholder="12–96 位字母或数字，支持连字符。每批最多 500 张。"/></label>}<p className="form-footnote">只导入你有权发行和履约的卡密。重复卡密会使整批导入回滚。数据库不保存卡密明文。</p><ErrorMessage message={actionError}/><button className="button primary full" disabled={busy}>{busy ? <Busy/> : dialog === 'generate' ? '生成并入库' : '导入并启用'}</button></form></Modal>}
    {selected && <Modal title="跟进本次授权履约" eyebrow="ACTIVATION WORKSPACE" close={close} wide><div className="job-heading"><span className={`status-badge ${selected.status}`}>{selected.statusLabel}</span><h2>{selected.planName}</h2><p>{selected.accountEmail} · {selected.id}</p></div>{selected.isDemo && <div className="demo-notice">演示任务，不得作为真实开通记录</div>}
      {selected.sessionAvailable && ['processing', 'needs_review'].includes(selected.status) && <div className="admin-session-access"><h3><LockKeyhole size={17}/>临时凭据 · 最长显示 60 秒</h3><p>仅为该任务授权履约使用，读取会记录在客户可见的时间线中。</p>{revealed ? <><input aria-label="临时 accessToken" type="password" readOnly value={revealed} autoComplete="off"/><div><button className="button secondary small" onClick={async () => { try { await navigator.clipboard.writeText(revealed); } catch { setActionError('复制未成功，请检查浏览器剪贴板权限。'); } }}><Copy size={14}/>复制临时 accessToken</button><button className="text-link" onClick={() => setRevealed('')}>立即隐藏</button></div></> : <form className="session-reauth" onSubmit={reveal}><input type="password" name="password" required maxLength={256} autoComplete="current-password" aria-label="重新验证管理密码" placeholder="重新输入管理密码"/><button className="button secondary small" disabled={busy}>验证并读取</button></form>}</div>}
      {selected.deliveryReference && <div className="form-info">交付凭据：{selected.deliveryReference}</div>}<ol className="timeline">{selected.events.map(event => <li key={event.id}><span className="timeline-dot"/><div><p>{event.message}</p><small>{date(event.createdAt)}</small></div></li>)}</ol>
      {!['completed', 'failed'].includes(selected.status) && <form className="form-stack admin-action" onSubmit={update} key={`${selected.id}-${selected.status}`}><label>下一步操作<select name="status" value={nextStatus} onChange={e => setNextStatus(e.target.value)}>{selected.status !== 'needs_session' && <option value="processing">领取任务 / 记录处理进度</option>}{selected.status === 'processing' && <option value="completed">确认官方结算与交付完成</option>}<option value="needs_review">标记待核实</option><option value="failed">结束任务：未完成</option></select></label>{nextStatus === 'completed' && <><label>官方订单号或交付凭据编号<input name="deliveryReference" required minLength={4} maxLength={120} placeholder="请勿填写银行卡号或 session"/></label><label className="checkbox-label"><input name="confirmed" type="checkbox" required/><span>{selected.isDemo ? '我确认本次仅完成演示流程，不代表实际开通。' : '我已核实官方结算与实际交付结果，以上凭据可用于核验。'}</span></label></>}<label>客户可见的处理说明<textarea name="note" required rows={3} minLength={2} maxLength={1000} placeholder="记录处理结果，不填写 session、银行卡号或验证码。"/></label><button className="button primary full" disabled={busy}>{busy ? <Busy/> : <>更新任务状态<ArrowRight size={16}/></>}</button></form>}<ErrorMessage message={actionError}/>
    </Modal>}
  </div>;
}
