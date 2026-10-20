import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X, LoaderCircle } from 'lucide-react';

export function Fish({ className = '' }: { className?: string }) {
  return <svg viewBox="0 0 50 40" fill="none" aria-hidden="true" className={className}><path d="M3 20C14 4 31 4 40 20 31 36 14 36 3 20Z" fill="currentColor"/><path d="m38 20 11-12v24L38 20Z" fill="currentColor"/><circle cx="15" cy="17" r="2.5" fill="var(--fish-eye,#f6f5ed)"/></svg>;
}
export function Logo() {
  return <a className="brand" href="/" aria-label="xiaoyu AI 首页"><span className="brand-icon"><Fish/></span><span className="brand-word">xiaoyu <b>AI</b><small>XIAOYUAI</small></span></a>;
}
export function Busy({ label = '处理中' }: { label?: string }) { return <span className="busy"><LoaderCircle size={17}/>{label}…</span>; }
export function ErrorMessage({ message }: { message: string }) { return message ? <div className="error-message" role="alert">{message}</div> : null; }
export function Modal({ title, eyebrow, children, close, wide = false }: { title: string; eyebrow?: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]') || []);
    (focusable()[0] || ref.current)?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Tab') {
        const items = focusable(); const first = items[0]; const last = items.at(-1);
        if (!items.length) { e.preventDefault(); return; }
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', handler); previous?.focus(); };
  }, [close]);
  return <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) close(); }}><div className={`modal ${wide ? 'modal-wide' : ''}`} ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
    <button className="icon-button modal-close" onClick={close} aria-label="关闭窗口"><X size={20}/></button>
    {eyebrow && <div className="eyebrow">{eyebrow}</div>}<h2 id={titleId}>{title}</h2>{children}
  </div></div>;
}
