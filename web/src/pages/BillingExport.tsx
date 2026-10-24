import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, fileUrl, qs } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Field, Loading, Modal, PageHead, Status, Tabs, useAction } from '../components/ui';
import { DutyImportWizard } from '../components/DutyImportWizard';
import { d, inr, monthRange, STATUS_LABEL, thisMonth } from '../format';
import { useClients, useContracts } from '../lookups';

type Tab = 'invoices' | 'formats';

/** Billing Export / Invoices: bills, invoice formats per department, and the related imports and exports. */
export function BillsPage() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) ?? 'invoices';
  const [dialog, setDialog] = useState<null | 'sample' | 'duties' | 'export' | 'datewise'>(null);
  const nav = useNavigate();
  return (
    <>
      <PageHead title="Billing Export / Invoices" sub="Prepare, approve and export bills in each department's own format (Excel and PDF)." />
      <div className="actions-bar">
        <span className="group-label">Invoices</span>
        {can('bill.prepare') && <button className="btn primary" onClick={() => nav('/billing')}>New bill</button>}
        {can('bill.prepare') && <button className="btn" onClick={() => setDialog('datewise')}>Date-wise bills</button>}
        <span className="sep" />
        <span className="group-label">Formats</span>
        {can('template.write') && <button className="btn" onClick={() => setDialog('sample')}>Import sample bill / invoice format</button>}
        <Link className="btn" to="/templates">Templates</Link>
        <span className="sep" />
        <span className="group-label">Data</span>
        {can('duty.write') && <button className="btn" onClick={() => setDialog('duties')}>Import billing data (duty sheet)</button>}
        {can('export') && <button className="btn" onClick={() => setDialog('export')}>Export billing data</button>}
      </div>
      <Tabs<Tab> tabs={[['invoices', 'Invoices'], ['formats', 'Invoice formats by department']]} value={tab} onChange={(t) => setSp({ tab: t })} />
      {tab === 'invoices' ? <InvoiceList /> : <FormatList onImport={() => setDialog('sample')} />}
      {dialog === 'sample' && <SampleFormatDialog onClose={() => setDialog(null)} />}
      {dialog === 'duties' && <DutyImportWizard onClose={() => setDialog(null)} onDone={() => setDialog(null)} />}
      {dialog === 'export' && <ExportDialog onClose={() => setDialog(null)} />}
      {dialog === 'datewise' && <DateWiseDialog onClose={() => setDialog(null)} />}
    </>
  );
}

function InvoiceList() {
  const [sp, setSp] = useSearchParams();
  const clients = useClients();
  const f = { clientId: sp.get('clientId') ?? '', status: sp.get('status') ?? '' };
  const q = useQuery({ queryKey: ['bills', f], queryFn: () => api.get<any[]>(`/bills${qs(f)}`) });
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n); };
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <select value={f.clientId} onChange={(e) => set('clientId', e.target.value)}><option value="">All departments</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <select value={f.status} onChange={(e) => set('status', e.target.value)}><option value="">Any status</option>{['draft', 'calculation_pending', 'validation_required', 'under_review', 'approved', 'generated', 'submitted', 'superseded', 'cancelled'].map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select>
      </div>
      <ErrorBox error={q.error} />
      <div className="panel tight">
        {q.isLoading ? <Loading /> : (
          <div className="scroll">
            <table className="t">
              <thead><tr><th>Bill no.</th><th>Department</th><th>Contract</th><th>Period</th><th className="num">Duties</th><th className="num">Taxable</th><th className="num">Tax</th><th className="num">Total</th><th>Status</th><th>Download</th></tr></thead>
              <tbody>
                {q.data?.map((b) => (
                  <tr key={b.id}><td><Link to={`/billing/${b.id}`}>{b.bill_no ?? 'Draft'}</Link>{b.revision_no > 0 && <span className="badge brand"> Rev {b.revision_no}</span>}</td><td>{b.client_name}</td><td>{b.contract_ref}</td>
                    <td className="nowrap">{b.period_type === 'date' ? <>{d(b.period_start)} <span className="badge">date-wise</span></> : <>{d(b.period_start)} – {d(b.period_end)}</>}</td>
                    <td className="num">{b.duty_count}</td><td className="num">{inr(b.taxable_value)}</td><td className="num">{inr(b.tax_total)}</td><td className="num"><b>{inr(b.grand_total)}</b></td>
                    <td><Status s={b.status} />{b.open_exceptions > 0 && <span className="badge err"> {b.open_exceptions} open</span>}</td>
                    <td className="nowrap">{b.pdf_file_id ? <><a className="btn sm" href={fileUrl(b.pdf_file_id)}>PDF</a> <a className="btn sm" href={fileUrl(b.xlsx_file_id)}>Excel</a></> : <span className="small muted">after approval</span>}</td></tr>
                ))}
                {q.data?.length === 0 && <tr><td colSpan={10} className="empty">No bills yet.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function FormatList({ onImport }: { onImport: () => void }) {
  const clients = useClients();
  const [clientId, setClientId] = useState('');
  const q = useQuery({ queryKey: ['templates', clientId], queryFn: () => api.get<any[]>(`/templates${qs({ clientId })}`) });
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <select value={clientId} onChange={(e) => setClientId(e.target.value)}><option value="">All departments</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <span className="small muted">Each department keeps its own format; a bill uses the approved version chosen for it and keeps it after approval.</span>
      </div>
      <div className="panel tight">
        <table className="t">
          <thead><tr><th>Department</th><th>Format</th><th>Applies to</th><th>Versions</th><th /></tr></thead>
          <tbody>
            {q.data?.map((t) => (
              <tr key={t.id}><td>{t.client_name}</td><td>{t.name}<div className="small muted">{t.description}</div></td><td>{t.contract_ref ?? 'All contracts'}</td>
                <td>{(t.versions ?? []).map((v: any) => <span key={v.id} style={{ marginRight: 10 }}><Link to={`/templates/versions/${v.id}`}>v{v.version_no}</Link> <Status s={v.status} />{v.has_xlsx && <span className="badge brand"> xlsx</span>}</span>)}</td>
                <td><Link className="btn sm" to={`/templates/versions/${(t.versions ?? []).slice(-1)[0]?.id}`}>Preview / edit</Link></td></tr>
            ))}
            {q.data?.length === 0 && <tr><td colSpan={5} className="empty">No invoice formats yet. <button className="btn link" onClick={onImport}>Import a sample bill</button> to start one.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Upload a department's sample bill (PDF or Excel) and get a draft format learned from it. */
export function SampleFormatDialog({ onClose }: { onClose: () => void }) {
  const clients = useClients();
  const [clientId, setClientId] = useState('');
  const contracts = useContracts(clientId || undefined);
  const templates = useQuery({ queryKey: ['templates', clientId], queryFn: () => api.get<any[]>(`/templates${qs({ clientId })}`), enabled: !!clientId });
  const [contractId, setContractId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [conflictWith, setConflictWith] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const send = async (over: { template_id?: string; as_new?: boolean } = {}) => {
    setBusy(true); setError(null);
    const fd = new FormData();
    fd.append('client_id', clientId);
    if (contractId) fd.append('contract_id', contractId);
    const tid = over.template_id ?? templateId;
    if (tid) fd.append('template_id', tid);
    else if (name) fd.append('name', name);
    if (over.as_new) fd.append('as_new', 'true');
    fd.append('file', file!);
    try {
      const res = await fetch('/api/templates/from-sample', { method: 'POST', body: fd, credentials: 'same-origin' });
      const j = await res.json();
      if (res.status === 409 && j.existingTemplateId) { setConflictWith(j.existingTemplateId); setError(new Error(j.error)); return; }
      if (!res.ok) throw new Error(j.error ?? res.statusText);
      setResult(j);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title="Import sample bill / invoice format" onClose={onClose}>
      <ErrorBox error={error} />
      {result ? (
        <div className="grid">
          <div className="alert ok">A draft format (version {result.versionNo}) was created from the sample.</div>
          <ul className="small">{result.notes.map((n: string, i: number) => <li key={i}>{n}</li>)}</ul>
          <p className="small muted">Open it to preview the result with sample data or a real bill, adjust columns and wording, and approve it. Only approved formats are used for bills.</p>
          <div className="row end"><button className="btn" onClick={onClose}>Close</button><button className="btn primary" onClick={() => nav(`/templates/versions/${result.versionId}`)}>Preview and edit</button></div>
        </div>
      ) : conflictWith ? (
        <div className="row end">
          <button className="btn" onClick={() => setConflictWith(null)}>Back</button>
          <button className="btn" disabled={busy} onClick={() => send({ as_new: true })}>Save as a separate format</button>
          <button className="btn primary" disabled={busy} onClick={() => send({ template_id: conflictWith })}>Add as a new version of the existing format</button>
        </div>
      ) : (
        <div className="grid">
          <Field label="Department / institution" required><select value={clientId} onChange={(e) => { setClientId(e.target.value); setContractId(''); setTemplateId(''); }}><option value="">Select…</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Contract" hint="Optional — leave empty to use the format for all the department's contracts"><select value={contractId} onChange={(e) => setContractId(e.target.value)}><option value="">All contracts</option>{contracts.data?.map((k) => <option key={k.id} value={k.id}>{k.reference_no}</option>)}</select></Field>
          <Field label="Save into"><select value={templateId} onChange={(e) => setTemplateId(e.target.value)} disabled={!clientId}><option value="">A new format</option>{templates.data?.map((t) => <option key={t.id} value={t.id}>New version of “{t.name}”</option>)}</select></Field>
          {!templateId && <Field label="Format name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. DRI monthly bill" /></Field>}
          <Field label="Sample bill" required hint="PDF of a previous bill, or the department's Excel bill format. Images are kept as a visual reference only."><input type="file" accept=".pdf,.xlsx,.png,.jpg,.jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
          <div className="alert info small">The columns, wording, totals and number/date style are read from the sample where possible. Fonts and exact spacing are not copied — always compare the preview with the sample before approving.</div>
          <div className="row end"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!clientId || !file || busy} onClick={() => send()}>{busy ? 'Reading the sample…' : 'Import'}</button></div>
        </div>
      )}
    </Modal>
  );
}

function ExportDialog({ onClose }: { onClose: () => void }) {
  const clients = useClients();
  const m = monthRange(thisMonth(-1));
  const [f, setF] = useState({ from: m.from, to: m.to, clientId: '', includeDrafts: false });
  return (
    <Modal title="Export billing data" onClose={onClose}>
      <div className="grid">
        <div className="grid g2">
          <Field label="Bills with a period starting from"><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
          <Field label="to"><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
        </div>
        <Field label="Department"><select value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })}><option value="">All</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <label className="check"><input type="checkbox" checked={f.includeDrafts} onChange={(e) => setF({ ...f, includeDrafts: e.target.checked })} />Include bills not yet approved</label>
        <div className="row end">
          <a className="btn" href={`/api/reports/duty-register.xlsx${qs({ from: f.from, to: f.to, clientId: f.clientId })}`}>Duty register (Excel)</a>
          <a className="btn primary" href={`/api/reports/billing-summary.xlsx${qs({ from: f.from, to: f.to, clientId: f.clientId, includeDrafts: f.includeDrafts || undefined })}`}>Bills and lines (Excel)</a>
        </div>
      </div>
    </Modal>
  );
}

function DateWiseDialog({ onClose }: { onClose: () => void }) {
  const contracts = useContracts();
  const [contractId, setContractId] = useState('');
  const [month, setMonth] = useState(thisMonth(-1));
  const [res, setRes] = useState<any>(null);
  const { run, busy } = useAction();
  return (
    <Modal title="Date-wise bills" onClose={onClose}>
      {!res ? (
        <div className="grid">
          <p className="small">Creates one draft bill for each date of the month that has duties not yet billed. Each bill is then calculated, checked and approved like any other.</p>
          <Field label="Contract" required><select value={contractId} onChange={(e) => setContractId(e.target.value)}><option value="">Select…</option>{contracts.data?.map((k) => <option key={k.id} value={k.id}>{k.client_name} — {k.reference_no}</option>)}</select></Field>
          <Field label="Month" required><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
          <div className="row end"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!contractId || busy} onClick={async () => { const r = await run(() => api.post('/bills/date-wise', { contract_id: contractId, month })); if (r) setRes(r); }}>Create date-wise bills</button></div>
        </div>
      ) : (
        <div className="grid">
          <div className={`alert ${res.created.length ? 'ok' : 'info'}`}>{res.created.length} draft bill(s) created.</div>
          <table className="t"><tbody>{res.created.map((b: any) => <tr key={b.id}><td><Link to={`/billing/${b.id}`}>{d(b.date)}</Link></td><td className="num">{b.duties} duties</td></tr>)}
            {res.skipped.map((s: any) => <tr key={s.date}><td>{d(s.date)}</td><td className="small muted">{s.reason}</td></tr>)}</tbody></table>
          <div className="row end"><button className="btn primary" onClick={onClose}>Close</button></div>
        </div>
      )}
    </Modal>
  );
}
