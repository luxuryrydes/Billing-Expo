import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { errorText } from '../api';
import { STATUS_LABEL } from '../format';

export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      <div className="row">{children}</div>
    </div>
  );
}

const TONE: Record<string, string> = {
  approved: 'ok', generated: 'ok', submitted: 'ok', verified: 'ok', active: 'ok', accepted: 'ok', done: 'ok', edited: 'ok', billed: 'brand', waived: 'brand',
  validation_required: 'err', failed: 'err', rejected: 'err', void: 'err', open: 'warn', error: 'err', cancelled: 'err',
  under_review: 'warn', pending_approval: 'warn', calculation_pending: 'warn', pending: 'warn', running: 'warn', warning: 'warn',
  draft: '', entered: '', superseded: '', retired: '', expired: '', inactive: '',
};

export function Status({ s }: { s: string | null | undefined }) {
  if (!s) return null;
  return <span className={`badge ${TONE[s] ?? ''}`}>{STATUS_LABEL[s] ?? s}</span>;
}

export function Field({ label, required, children, hint }: { label: string; required?: boolean; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className={required ? 'req' : ''}>{label}</span>
      {children}
      {hint && <span className="small muted">{hint}</span>}
    </label>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="btn sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: [T, string][]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([k, l]) => (
        <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{l}</button>
      ))}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="alert err">{errorText(error)}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading() {
  return <div className="empty">Loading…</div>;
}

// --- Toasts -------------------------------------------------------------------
type Toast = { id: number; text: string; err?: boolean };
const ToastCtx = createContext<(text: string, err?: boolean) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, err?: boolean) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, err }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), err ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast" role="status">{items.map((t) => <div key={t.id} className={t.err ? 'err' : ''}>{t.text}</div>)}</div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** Runs an async action with toast feedback; returns its result or undefined on error. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) toast(ok);
      return r;
    } catch (e) {
      toast(errorText(e), true);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return { run, busy };
}

export function Confirm({ text, onYes, onClose, needReason, yesLabel = 'Confirm', danger }: { text: string; onYes: (reason: string) => void; onClose: () => void; needReason?: string; yesLabel?: string; danger?: boolean }) {
  const [reason, setReason] = useState('');
  return (
    <Modal title="Please confirm" onClose={onClose}>
      <p className="pre">{text}</p>
      {needReason && <Field label={needReason} required><textarea value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>}
      <div className="row end" style={{ marginTop: 12 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className={`btn ${danger ? 'danger' : 'primary'}`} disabled={!!needReason && reason.trim().length < 3} onClick={() => onYes(reason)}>{yesLabel}</button>
      </div>
    </Modal>
  );
}
