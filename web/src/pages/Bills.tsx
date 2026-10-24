import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, downloadBlob, fileUrl, qs } from '../api';
import { useAuth } from '../auth';
import { Confirm, ErrorBox, Field, Loading, Modal, PageHead, Status, Tabs, useAction } from '../components/ui';
import { d, dt, inr, monthRange, thisMonth } from '../format';
import { useClients, useContracts } from '../lookups';

const STEPS = ['Select', 'Check duties', 'Calculate', 'Resolve exceptions', 'Review & approve', 'Generate files', 'Submit'];
function stepOf(b: any): number {
  if (!b) return 0;
  if (!b.current_snapshot_id) return 1;
  if (['draft', 'calculation_pending', 'validation_required'].includes(b.status)) return b.exceptions.some((e: any) => e.status === 'open') || b.stale || b.status === 'calculation_pending' ? 3 : 4;
  if (b.status === 'under_review') return 4;
  if (b.status === 'approved') return 5;
  if (b.status === 'generated') return 6;
  return 7;
}

export function BillingWorkspacePage() {
  const { id } = useParams();
  return id ? <BillWorkspace id={id} /> : <NewBill />;
}

function NewBill() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const clients = useClients();
  const [clientId, setClientId] = useState('');
  const contracts = useContracts(clientId || undefined);
  const [contractId, setContractId] = useState(sp.get('contract') ?? '');
  const [month, setMonth] = useState(thisMonth(-1));
  const [kind, setKind] = useState<'month' | 'date' | 'range'>('month');
  const [date, setDate] = useState(monthRange(thisMonth(-1)).to);
  const [range, setRange] = useState(monthRange(thisMonth(-1)));
  const [billDate, setBillDate] = useState('');
  const { run, busy } = useAction();
  const contract = contracts.data?.find((k) => k.id === contractId);
  const create = async () => {
    const period = kind === 'month' ? monthRange(month) : kind === 'date' ? { from: date, to: date } : range;
    const r = await run(() => api.post('/bills', { contract_id: contractId, period_start: period.from, period_end: period.to, period_type: kind, bill_date: billDate || undefined }), 'Bill created');
    if (r) nav(`/billing/${r.id}`);
  };
  const dateWise = async () => {
    const r = await run(() => api.post('/bills/date-wise', { contract_id: contractId, month, bill_date: billDate || undefined }));
    if (r) {
      alert(`${r.created.length} date-wise draft bill(s) created${r.skipped.length ? `; ${r.skipped.length} date(s) skipped (already billed)` : ''}. They are listed under Billing Export / Invoices.`);
      nav('/bills');
    }
  };
  return (
    <>
      <PageHead title="Billing Workspace" sub="Step 1 — choose the department, contract and billing period." />
      <Steps cur={0} />
      <div className="panel grid" style={{ maxWidth: 720 }}>
        <div className="grid g2">
          <Field label="Department"><select value={clientId} onChange={(e) => setClientId(e.target.value)}><option value="">All</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Contract" required><select value={contractId} onChange={(e) => setContractId(e.target.value)}><option value="">Select…</option>{contracts.data?.map((k) => <option key={k.id} value={k.id}>{k.client_name} — {k.reference_no}</option>)}</select></Field>
        </div>
        <div className="row">
          <label className="check"><input type="radio" checked={kind === 'month'} onChange={() => setKind('month')} />Month-wise bill</label>
          <label className="check"><input type="radio" checked={kind === 'date'} onChange={() => setKind('date')} />Date-wise bill (one date)</label>
          <label className="check"><input type="radio" checked={kind === 'range'} onChange={() => setKind('range')} />Other period</label>
          {contract && <span className="small muted">Contract billing: {contract.billing_frequency === 'daily' ? 'date-wise' : contract.billing_frequency}</span>}
        </div>
        <div className="grid g3">
          {kind === 'month' && <Field label="Billing month" required><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>}
          {kind === 'date' && <Field label="Duty date" required><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>}
          {kind === 'range' && <>
            <Field label="From" required><input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
            <Field label="To" required><input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field></>}
          <Field label="Bill date" hint="Default: day after period end"><input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} /></Field>
        </div>
        <div className="row end">
          {kind === 'month' && <button className="btn" disabled={!contractId || busy} onClick={dateWise} title="One draft bill per duty date in the month">Create date-wise bills for the month</button>}
          <button className="btn primary" disabled={!contractId || busy} onClick={create}>Create bill & check duties</button>
        </div>
      </div>
    </>
  );
}

function Steps({ cur }: { cur: number }) {
  return <div className="steps">{STEPS.map((s, i) => <div key={s} className={`s ${i < cur ? 'done' : i === cur ? 'cur' : ''}`}>{i + 1}. {s}</div>)}</div>;
}

type Tab = 'summary' | 'duties' | 'lines' | 'exceptions' | 'files' | 'history';

function BillWorkspace({ id }: { id: string }) {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['bill', id], queryFn: () => api.get(`/bills/${id}`) });
  const pre = useQuery({ queryKey: ['precheck', id, q.data?.updated_at], queryFn: () => api.get(`/bills/${id}/precheck`), enabled: !!q.data });
  const templates = useQuery({ queryKey: ['templates-for-bill', q.data?.client_id], queryFn: () => api.get<any[]>(`/templates${qs({ clientId: q.data?.client_id })}`), enabled: !!q.data });
  const [tab, setTab] = useState<Tab>('summary');
  const [confirm, setConfirm] = useState<null | { text: string; reason?: string; label: string; fn: (r: string) => Promise<unknown>; danger?: boolean }>(null);
  const [trace, setTrace] = useState<any>(null);
  const nav = useNavigate();
  const { run, busy } = useAction();
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const b = q.data;
  const step = stepOf(b);
  const editable = ['draft', 'calculation_pending', 'validation_required', 'under_review'].includes(b.status);
  const open = b.exceptions.filter((e: any) => e.status === 'open');
  const openErrors = open.filter((e: any) => e.severity === 'error');
  const act = async (fn: () => Promise<unknown>, ok: string) => { const r = await run(fn, ok); if (r) q.refetch(); return r; };
  const latestFiles = (kind: string) => b.files.find((f: any) => f.kind === kind);
  const recon = b.files[0]?.reconciliation;
  const approvedTemplates = (templates.data ?? []).flatMap((t: any) => (t.versions ?? []).filter((v: any) => v.status !== 'draft').map((v: any) => ({ id: v.id, label: `${t.name} v${v.version_no}${v.status === 'retired' ? ' (retired)' : ''}`, status: v.status })));
  return (
    <>
      <PageHead title={`${b.bill_no ?? 'Draft bill'}${b.revision_no ? ` — revision ${b.revision_no}` : ''}`} sub={<>{b.client_name} · {b.contract_ref} · {d(b.period_start)} – {d(b.period_end)} · <Status s={b.status} /></>}>
        {editable && can('bill.prepare') && <button className="btn primary" disabled={busy} onClick={() => act(() => api.post(`/bills/${id}/calculate`), 'Calculated')}>{b.current_snapshot_id ? 'Recalculate' : 'Calculate'}</button>}
        {['draft', 'validation_required'].includes(b.status) && b.current_snapshot_id && can('bill.prepare') && <button className="btn" disabled={busy || open.length > 0 || b.stale} onClick={() => act(() => api.post(`/bills/${id}/submit-review`), 'Submitted for review')}>Submit for review</button>}
        {b.status === 'under_review' && b.approval_levels === 2 && !b.reviewed_by && can('bill.review') && <button className="btn" disabled={busy} onClick={() => act(() => api.post(`/bills/${id}/review`, {}), 'Marked reviewed')}>Mark reviewed</button>}
        {b.status === 'under_review' && can('bill.approve') && <button className="btn ok" disabled={busy} onClick={() => setConfirm({ text: `Approve this bill for ${inr(b.grand_total)}? The calculation, rates and template version will be frozen and a bill number assigned.`, label: 'Approve', fn: (note) => api.post(`/bills/${id}/approve`, { note }) })}>Approve</button>}
        {b.status === 'under_review' && can('bill.review') && <button className="btn danger" onClick={() => setConfirm({ text: 'Send the bill back for correction?', reason: 'Reason', label: 'Send back', danger: true, fn: (note) => api.post(`/bills/${id}/reject`, { note }) })}>Send back</button>}
        {['approved', 'generated', 'submitted'].includes(b.status) && can('export') && <button className="btn primary" disabled={busy} onClick={() => act(() => api.post(`/bills/${id}/generate`), 'Files generated')}>{b.files.length ? 'Regenerate files' : 'Generate Excel & PDF'}</button>}
        {editable && b.current_snapshot_id && b.template_version_id && <>
          <button className="btn" disabled={busy} title="Draft preview in the department's format (marked as preview)" onClick={async () => { const blob = await run(() => api.blob('POST', `/template-versions/${b.template_version_id}/preview`, { format: 'pdf', billId: id })); if (blob) window.open(URL.createObjectURL(blob), '_blank'); }}>Preview PDF</button>
          <button className="btn" disabled={busy} onClick={async () => { const blob = await run(() => api.blob('POST', `/template-versions/${b.template_version_id}/preview`, { format: 'xlsx', billId: id })); if (blob) downloadBlob(blob, `draft-${b.client_name}-${b.period_start}.xlsx`); }}>Preview Excel</button>
        </>}
        {b.status === 'generated' && can('bill.submit') && <button className="btn ok" onClick={() => setConfirm({ text: 'Mark this bill as submitted to the department?', reason: 'Submission / diary reference', label: 'Mark submitted', fn: (ref) => api.post(`/bills/${id}/submit`, { submission_ref: ref }) })}>Mark submitted</button>}
        {['approved', 'generated', 'submitted'].includes(b.status) && can('bill.prepare') && <button className="btn" onClick={() => setConfirm({ text: 'Create a controlled revision? The approved bill stays unchanged until the revision is approved, then it is marked superseded.', reason: 'Why is a revision needed?', label: 'Create revision', fn: async (reason) => { const r = await api.post(`/bills/${id}/revise`, { reason }); nav(`/billing/${r.id}`); return r; } })}>Revise</button>}
        {editable && can('bill.prepare') && <button className="btn danger" onClick={() => setConfirm({ text: 'Cancel this bill? Its duties become available for billing again.', reason: 'Reason', label: 'Cancel bill', danger: true, fn: (reason) => api.post(`/bills/${id}/cancel`, { reason }) })}>Cancel bill</button>}
      </PageHead>
      <Steps cur={step} />
      {b.stale && <div className="alert warn">Duties were added or changed after the last calculation. Recalculate before review.</div>}
      {b.status === 'calculation_pending' && <div className="alert warn">Duty selection changed. Recalculate.</div>}
      {openErrors.length > 0 && <div className="alert err">{openErrors.length} error(s) must be fixed (correct the duty or rule and recalculate, or exclude the duty with a reason). Errors cannot be waived.</div>}
      {open.length > 0 && openErrors.length === 0 && <div className="alert warn">{open.length} warning(s) need a reviewer decision before submission.</div>}
      {b.revision_of && <div className="alert info">Revision of an approved bill. Reason: {b.revision_reason}</div>}
      <Tabs<Tab> tabs={[['summary', 'Summary'], ['duties', `Duties (${pre.data?.total ?? '…'})`], ['lines', `Calculation (${b.lines.length})`], ['exceptions', `Exceptions (${open.length} open)`], ['files', `Files (${b.files.length})`], ['history', 'Approvals & history']]} value={tab} onChange={setTab} />

      {tab === 'summary' && (
        <div className="grid g2">
          <div className="panel">
            <h2>Totals</h2>
            {!b.current_snapshot_id ? <p className="muted">Not calculated yet. Check the duties tab, then Calculate.</p> : (
              <table className="t"><tbody>
                <tr><td>Charges</td><td className="num">{inr(b.totals?.chargesTotal)}</td></tr>
                <tr><td>Reimbursements</td><td className="num">{inr(b.totals?.reimbursementsTotal)}</td></tr>
                {b.totals?.deductionsTotal !== '0.00' && <tr><td>Deductions</td><td className="num">{inr(b.totals?.deductionsTotal)}</td></tr>}
                <tr><td><b>Taxable value</b></td><td className="num">{inr(b.taxable_value)}</td></tr>
                {b.taxLines.map((t: any) => <tr key={t.id}><td>{t.name} @ {Number(t.rate)}% on {inr(t.taxable_base)}</td><td className="num">{inr(t.amount)}</td></tr>)}
                <tr><td>Non-taxable</td><td className="num">{inr(b.non_taxable_total)}</td></tr>
                {b.round_off !== '0.00' && <tr><td>Round off</td><td className="num">{inr(b.round_off)}</td></tr>}
              </tbody><tfoot><tr><td>Total payable</td><td className="num">{inr(b.grand_total)}</td></tr></tfoot></table>
            )}
            {b.checks && <div style={{ marginTop: 10 }}>{b.checks.map((c: any) => <div key={c.name} className="small">{c.ok ? '✔' : '✖'} {c.name} <span className="muted">({c.detail})</span></div>)}</div>}
            {b.calculated_at && <p className="small muted">Calculated {dt(b.calculated_at)} · engine {b.engine_version} · snapshot <span className="mono">{b.content_hash?.slice(0, 12)}</span></p>}
          </div>
          <div className="panel grid">
            <h2>Bill settings</h2>
            <Field label="Bill format (approved template)">
              <select disabled={!editable || !can('bill.prepare')} value={b.template_version_id ?? ''} onChange={(e) => act(() => api.patch(`/bills/${id}`, { template_version_id: e.target.value }), 'Template set')}>
                <option value="">Select…</option>{approvedTemplates.filter((t) => t.status === 'approved' || t.id === b.template_version_id).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </Field>
            {b.template_version_id && <Link to={`/templates/versions/${b.template_version_id}`}>Preview this bill in the template</Link>}
            <Field label="Bill date"><input type="date" disabled={!editable} defaultValue={b.bill_date ?? ''} onBlur={(e) => e.target.value !== b.bill_date && act(() => api.patch(`/bills/${id}`, { bill_date: e.target.value }), 'Bill date saved')} /></Field>
            <label className="check"><input type="checkbox" disabled={!editable} checked={b.include_unverified} onChange={(e) => act(() => api.patch(`/bills/${id}`, { include_unverified: e.target.checked }), 'Saved')} />Allow unverified duties (flagged as warnings)</label>
            <div className="small muted">Prepared by {b.created_by_name}{b.reviewed_by_name && ` · reviewed by ${b.reviewed_by_name}`}{b.approved_by_name && ` · approved by ${b.approved_by_name} ${dt(b.approved_at)}`}{b.submission_ref && ` · submitted ref. ${b.submission_ref}`}</div>
          </div>
        </div>
      )}

      {tab === 'duties' && pre.data && (
        <>
          <div className="kpis">
            <div className="kpi"><div className="v">{pre.data.total}</div><div className="l">Duties in period</div></div>
            <div className="kpi"><div className="v">{pre.data.excluded.length}</div><div className="l">Excluded</div></div>
            <div className={`kpi ${pre.data.withErrors.length ? 'alert-kpi' : ''}`}><div className="v">{pre.data.withErrors.length}</div><div className="l">With errors</div></div>
            <div className="kpi"><div className="v">{pre.data.withWarnings}</div><div className="l">With warnings</div></div>
            <div className="kpi"><div className="v">{pre.data.unverified}</div><div className="l">Unverified</div></div>
            <div className={`kpi ${pre.data.alreadyBilled.length ? 'alert-kpi' : ''}`}><div className="v">{pre.data.alreadyBilled.length}</div><div className="l">Already on another bill</div></div>
          </div>
          <div className="panel tight">
            <table className="t">
              <thead><tr><th>Date</th><th>Vehicle</th><th>Driver</th><th className="num">Km</th><th>Start</th><th>Close</th><th>Status</th><th className="num">Amount</th><th /></tr></thead>
              <tbody>
                {b.duties.map((x: any) => (
                  <tr key={x.id}><td>{d(x.duty_date)}</td><td className="mono">{x.vehicle_reg_no}</td><td>{x.driver_name}</td><td className="num">{x.start_km != null && x.end_km != null ? (Math.round((Number(x.end_km) - Number(x.start_km)) * 10) / 10) : ''}</td><td className="small">{dt(x.start_at)}</td><td className="small">{dt(x.end_at)}</td><td><Status s={x.status} /></td><td className="num">{inr(x.amount)}</td>
                    <td>{editable && can('bill.prepare') && <button className="btn sm" onClick={() => setConfirm({ text: `Exclude ${x.vehicle_reg_no} on ${d(x.duty_date)} from this bill?`, reason: 'Reason for exclusion', label: 'Exclude', fn: (reason) => api.post(`/bills/${id}/exclude`, { dutyId: x.id, reason }) })}>Exclude</button>}</td></tr>
                ))}
                {b.duties.length === 0 && <tr><td colSpan={9} className="empty">Calculate to link the eligible duties.</td></tr>}
              </tbody>
            </table>
          </div>
          {pre.data.excluded.length > 0 && (
            <div className="panel"><h3>Excluded duties</h3>{pre.data.excluded.map((e: any) => <div key={e.dutyId} className="row small"><span className="mono">{e.dutyId.slice(0, 8)}</span> — {e.reason}{editable && <button className="btn sm" onClick={() => act(() => api.post(`/bills/${id}/exclude`, { dutyId: e.dutyId, reason: 'Re-included', include: true }), 'Included again')}>Include again</button>}</div>)}</div>
          )}
          <details className="panel"><summary><b>Vehicle coverage</b> — days without duty in the period ({pre.data.periodDays} days)</summary>
            <table className="t"><tbody>{pre.data.vehicleCoverage.map((v: any) => <tr key={v.vehicle}><td className="mono">{v.vehicle}</td><td>{v.daysWithDuty} day(s) with duty</td><td className="small muted">{v.missingDates.length ? `No duty: ${v.missingDates.map((x: string) => x.slice(8)).join(', ')}` : 'every day'}</td></tr>)}</tbody></table>
            <p className="small muted">Shown for checking missing entries; whether gaps matter depends on the contract.</p>
          </details>
        </>
      )}

      {tab === 'lines' && (
        <div className="panel tight">
          <div className="scroll">
            <table className="t">
              <thead><tr><th>Date</th><th>Vehicle</th><th>Component</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Amount</th><th>Tax</th><th>Formula</th><th>Rule</th></tr></thead>
              <tbody>{b.lines.map((l: any) => (
                <tr key={l.id} className="clickable" onClick={() => setTrace(l)}><td className="nowrap">{d(l.duty_date)}</td><td className="mono">{l.vehicle_reg_no}</td><td>{l.label}</td><td className="num">{Number(l.quantity)} {l.unit}</td><td className="num">{inr(l.rate)}</td><td className="num">{inr(l.amount)}</td>
                  <td>{l.tax_category === 'taxable' ? 'T' : 'NT'}</td><td className="mono small">{l.trace.formula}</td><td className="small">{l.trace.schemeName} v{l.trace.versionNo}{l.trace.clauseRef && <div className="muted">{l.trace.clauseRef}</div>}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'exceptions' && (
        <div className="panel tight">
          <table className="t">
            <thead><tr><th>Severity</th><th>Code</th><th>Duty</th><th>Message</th><th>Status</th><th>Decision</th><th /></tr></thead>
            <tbody>
              {b.exceptions.map((e: any) => (
                <tr key={e.id}><td><Status s={e.severity} /></td><td className="mono small">{e.code}</td><td className="nowrap">{e.duty_id ? <>{d(e.duty_date)} <span className="mono">{e.vehicle_reg_no}</span></> : '—'}</td><td>{e.message}</td><td><Status s={e.status} /></td>
                  <td className="small">{e.resolution_note}{e.resolved_by_name && <div className="muted">{e.resolved_by_name}</div>}</td>
                  <td className="nowrap">{editable && can('bill.review') && e.severity === 'warning' && e.status === 'open' && <button className="btn sm" onClick={() => setConfirm({ text: e.message, reason: 'Why is this acceptable?', label: 'Accept warning', fn: (note) => api.patch(`/billing-exceptions/${e.id}`, { status: 'waived', note }) })}>Accept</button>}
                    {editable && e.status === 'waived' && can('bill.review') && <button className="btn sm" onClick={() => act(() => api.patch(`/billing-exceptions/${e.id}`, { status: 'open' }), 'Reopened')}>Reopen</button>}
                    {editable && e.severity === 'error' && e.duty_id && can('bill.prepare') && <button className="btn sm" onClick={() => setConfirm({ text: `Exclude this duty from the bill?\n${e.message}`, reason: 'Reason for exclusion', label: 'Exclude duty', fn: (reason) => api.post(`/bills/${id}/exclude`, { dutyId: e.duty_id, reason }) })}>Exclude duty</button>}</td></tr>
              ))}
              {b.exceptions.length === 0 && <tr><td colSpan={7} className="empty">{b.current_snapshot_id ? 'No exceptions.' : 'Calculate first.'}</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'files' && (
        <>
          {recon && <div className={`alert ${recon.ok ? 'ok' : 'err'}`}><b>{recon.ok ? 'Excel and PDF reconcile with the calculation.' : 'Reconciliation found differences — do not submit until resolved.'}</b>{recon.checks.map((c: any) => <div key={c.name} className="small">{c.ok ? '✔' : '✖'} {c.name} — {c.detail}</div>)}</div>}
          <div className="panel tight">
            <table className="t"><thead><tr><th>File</th><th>Kind</th><th>Generated</th><th>SHA-256</th><th /></tr></thead>
              <tbody>{b.files.map((f: any) => <tr key={f.id}><td>{f.original_name}</td><td>{f.kind === 'register_xlsx' ? 'Calculation register (internal)' : f.kind === 'bill_pdf' ? 'Customer bill PDF' : 'Customer bill Excel'}</td><td>{dt(f.created_at)}</td><td className="mono small">{f.sha256.slice(0, 16)}…</td>
                <td><a className="btn sm" href={fileUrl(f.file_id)}>Download</a>{f.kind === 'bill_pdf' && <> <a className="btn sm" href={fileUrl(f.file_id, true)} target="_blank" rel="noreferrer">Open</a></>}</td></tr>)}
                {b.files.length === 0 && <tr><td colSpan={5} className="empty">Files are generated after approval.</td></tr>}</tbody></table>
          </div>
          {latestFiles('bill_pdf') && <iframe className="preview" src={fileUrl(latestFiles('bill_pdf').file_id, true)} title="Bill PDF" />}
        </>
      )}

      {tab === 'history' && (
        <div className="grid g2">
          <div className="panel"><h3>Approvals</h3><table className="t"><tbody>{b.approvals.map((a: any) => <tr key={a.id}><td>{dt(a.created_at)}</td><td>{a.user_name}</td><td>{a.action}</td><td>{a.note}</td></tr>)}</tbody></table></div>
          <div className="panel"><h3>Revisions</h3><table className="t"><tbody>{b.revisions.map((r: any) => <tr key={r.id}><td><Link to={`/billing/${r.id}`}>Rev {r.revision_no}</Link></td><td><Status s={r.status} /></td><td className="num">{inr(r.grand_total)}</td><td className="small">{r.revision_reason}</td></tr>)}</tbody></table>
            <Link to={`/audit?entityType=bill&entityId=${id}`}>Full audit log for this bill</Link></div>
        </div>
      )}

      {trace && (
        <Modal title={`${trace.label} — calculation trace`} onClose={() => setTrace(null)}>
          <div className="grid">
            <div className="trace">{trace.trace.formula}</div>
            <div>Quantity formula: <code>{trace.trace.quantityExpr}</code>{trace.trace.condition && <> · applies when <code>{trace.trace.condition}</code></>}</div>
            <table className="t"><thead><tr><th>Input</th><th>Value</th></tr></thead><tbody>{Object.entries(trace.trace.inputs).map(([k, v]) => <tr key={k}><td className="mono">{k}</td><td>{String(v)}</td></tr>)}</tbody></table>
            <div>Rule: {trace.trace.schemeName} version {trace.trace.versionNo} {trace.trace.clauseRef && <>· clause {trace.trace.clauseRef}</>} · <Link to={`/rates/versions/${trace.trace.schemeVersionId}`}>open rate version</Link></div>
            {trace.duty_id && <div>Duty: <Link to={`/duties?vehicle=${trace.vehicle_reg_no}&from=${trace.duty_date}&to=${trace.duty_date}`}>{d(trace.duty_date)} {trace.vehicle_reg_no}</Link></div>}
            {trace.trace.capped && <div className="alert warn">{trace.trace.capped}</div>}
          </div>
        </Modal>
      )}
      {confirm && <Confirm text={confirm.text} needReason={confirm.reason} yesLabel={confirm.label} danger={confirm.danger} onClose={() => setConfirm(null)}
        onYes={async (r) => { const c = confirm; setConfirm(null); await act(() => c.fn(r), 'Done'); }} />}
    </>
  );
}
