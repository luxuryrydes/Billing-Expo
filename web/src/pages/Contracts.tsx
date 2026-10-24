import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Confirm, ErrorBox, Field, Loading, Modal, PageHead, Status, Tabs, useAction } from '../components/ui';
import { d, dt } from '../format';
import { useClients, useContracts, useSuppliers } from '../lookups';

const DEFAULT = {
  client_id: '', supplier_profile_id: null, title: '', reference_no: '', po_number: '', start_date: '', end_date: '', billing_frequency: 'monthly', status: 'draft',
  tax_mode: 'exclusive', tax_level: 'document', invoice_rounding: 'none', approval_levels: 1, bill_no_format: '{CLIENT}/{FY}/{SEQ}', required_formats: '', special_instructions: '',
  validation: {}, custom_fields: [],
};

export function ContractForm({ initial, onDone }: { initial?: any; onDone: () => void }) {
  const clients = useClients();
  const suppliers = useSuppliers();
  const qc = useQueryClient();
  const { run, busy } = useAction();
  const [f, setF] = useState<any>({ ...DEFAULT, ...(initial ?? {}), start_date: initial?.start_date ?? '', end_date: initial?.end_date ?? '' });
  const set = (k: string, num = false) => (e: React.ChangeEvent<any>) => setF({ ...f, [k]: num ? Number(e.target.value) : e.target.value });
  const v = f.validation ?? {};
  const setV = (k: string, val: unknown) => setF({ ...f, validation: { ...v, [k]: val === '' ? undefined : val } });
  const save = async () => {
    const body = { ...f, end_date: f.end_date || null, supplier_profile_id: f.supplier_profile_id || null };
    const r = await run(() => (f.id ? api.put(`/contracts/${f.id}`, body) : api.post('/contracts', body)), 'Contract saved');
    if (r) { qc.invalidateQueries(); onDone(); }
  };
  const cf: any[] = f.custom_fields ?? [];
  return (
    <div className="grid">
      <div className="grid g2">
        <Field label="Department" required>
          <select value={f.client_id} onChange={set('client_id')}><option value="">Select…</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        </Field>
        <Field label="Supplier profile on invoices" hint="Leave empty to use the default supplier profile">
          <select value={f.supplier_profile_id ?? ''} onChange={set('supplier_profile_id')}><option value="">Default</option>{suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        </Field>
      </div>
      <div className="grid g3">
        <Field label="Contract title" required><input value={f.title} onChange={set('title')} /></Field>
        <Field label="Contract reference no." required><input value={f.reference_no} onChange={set('reference_no')} /></Field>
        <Field label="Work order / PO no."><input value={f.po_number ?? ''} onChange={set('po_number')} /></Field>
      </div>
      <div className="grid g4">
        <Field label="Start date" required><input type="date" value={f.start_date} onChange={set('start_date')} /></Field>
        <Field label="End date"><input type="date" value={f.end_date ?? ''} onChange={set('end_date')} /></Field>
        <Field label="Billing frequency"><select value={f.billing_frequency} onChange={set('billing_frequency')}><option value="monthly">Monthly</option><option value="fortnightly">Fortnightly</option><option value="weekly">Weekly</option><option value="per_trip">Per trip</option></select></Field>
        <Field label="Status"><select value={f.status} onChange={set('status')}><option value="draft">Draft</option><option value="active">Active</option><option value="expired">Expired</option><option value="terminated">Terminated</option></select></Field>
      </div>
      <h3>Tax & invoice settings</h3>
      <div className="grid g4">
        <Field label="Rates are" hint="As stated in the contract"><select value={f.tax_mode} onChange={set('tax_mode')}><option value="exclusive">Exclusive of tax</option><option value="inclusive">Inclusive of tax</option></select></Field>
        <Field label="Tax calculated"><select value={f.tax_level} onChange={set('tax_level')}><option value="document">On the bill total</option><option value="line">Per line, then summed</option></select></Field>
        <Field label="Invoice rounding"><select value={f.invoice_rounding} onChange={set('invoice_rounding')}><option value="none">None</option><option value="nearest_rupee">Nearest rupee</option><option value="up_rupee">Up to rupee</option><option value="down_rupee">Down to rupee</option></select></Field>
        <Field label="Approval levels"><select value={f.approval_levels} onChange={set('approval_levels', true)}><option value={1}>Approver only</option><option value={2}>Reviewer + approver</option></select></Field>
      </div>
      <Field label="Bill number format" hint="Tokens: {CLIENT} {FY} {YYYY} {MM} {SEQ}"><input value={f.bill_no_format} onChange={set('bill_no_format')} /></Field>
      <div className="grid g2">
        <Field label="Required bill & supporting-document formats"><textarea value={f.required_formats ?? ''} onChange={set('required_formats')} /></Field>
        <Field label="Special billing instructions"><textarea value={f.special_instructions ?? ''} onChange={set('special_instructions')} /></Field>
      </div>
      <h3>Duty validation for this contract</h3>
      <div className="grid g4">
        <Field label="Max km per duty (review)"><input type="number" value={v.maxKmPerDuty ?? ''} placeholder="global default" onChange={(e) => setV('maxKmPerDuty', e.target.value ? Number(e.target.value) : '')} /></Field>
        <Field label="Max hours per duty (review)"><input type="number" value={v.maxHoursPerDuty ?? ''} placeholder="global default" onChange={(e) => setV('maxHoursPerDuty', e.target.value ? Number(e.target.value) : '')} /></Field>
        <label className="check"><input type="checkbox" checked={!!v.requireExpenseEvidence} onChange={(e) => setV('requireExpenseEvidence', e.target.checked)} />Require document ref. for toll/parking</label>
        <Field label="Warnings treated as hard errors" hint="Comma-separated codes, e.g. HIGH_KM"><input value={(v.hardErrorCodes ?? []).join(',')} onChange={(e) => setV('hardErrorCodes', e.target.value ? e.target.value.split(',').map((s) => s.trim()).filter(Boolean) : '')} /></Field>
      </div>
      <h3>Contract-specific duty fields</h3>
      <table className="t">
        <thead><tr><th>Key</th><th>Label</th><th>Type</th><th>Required</th><th /></tr></thead>
        <tbody>
          {cf.map((x, i) => (
            <tr key={i}>
              <td><input value={x.key} onChange={(e) => { const n = [...cf]; n[i] = { ...x, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') }; setF({ ...f, custom_fields: n }); }} /></td>
              <td><input value={x.label} onChange={(e) => { const n = [...cf]; n[i] = { ...x, label: e.target.value }; setF({ ...f, custom_fields: n }); }} /></td>
              <td><select value={x.type} onChange={(e) => { const n = [...cf]; n[i] = { ...x, type: e.target.value }; setF({ ...f, custom_fields: n }); }}><option value="number">Number</option><option value="text">Text</option></select></td>
              <td><input type="checkbox" checked={x.required} onChange={(e) => { const n = [...cf]; n[i] = { ...x, required: e.target.checked }; setF({ ...f, custom_fields: n }); }} /></td>
              <td><button className="btn sm danger" onClick={() => setF({ ...f, custom_fields: cf.filter((_, j) => j !== i) })}>Remove</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div><button className="btn sm" onClick={() => setF({ ...f, custom_fields: [...cf, { key: '', label: '', type: 'number', required: false }] })}>Add field</button> <span className="small muted">Usable in rate formulas as f_&lt;key&gt;.</span></div>
      <div className="row end"><button className="btn" onClick={onDone}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Save contract</button></div>
    </div>
  );
}

export function ContractsPage() {
  const { can } = useAuth();
  const [clientId, setClientId] = useState('');
  const clients = useClients();
  const q = useContracts(clientId || undefined);
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHead title="Contracts" sub="Contracts hold validity, tax treatment, rate schemes and documents.">
        <select value={clientId} onChange={(e) => setClientId(e.target.value)}><option value="">All departments</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        {can('client.write') && <button className="btn primary" onClick={() => setAdding(true)}>Add contract</button>}
      </PageHead>
      <ErrorBox error={q.error} />
      <div className="panel tight">
        {q.isLoading ? <Loading /> : (
          <table className="t">
            <thead><tr><th>Department</th><th>Contract</th><th>Reference</th><th>Validity</th><th>Status</th></tr></thead>
            <tbody>
              {q.data?.map((k) => <tr key={k.id}><td>{k.client_name}</td><td><Link to={`/contracts/${k.id}`}>{k.title}</Link></td><td>{k.reference_no}</td><td>{d(k.start_date)} – {k.end_date ? d(k.end_date) : 'open'}</td><td><Status s={k.status} /></td></tr>)}
              {q.data?.length === 0 && <tr><td colSpan={5} className="empty">No contracts yet.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      {adding && <Modal title="New contract" onClose={() => setAdding(false)} wide><ContractForm onDone={() => setAdding(false)} /></Modal>}
    </>
  );
}

type Tab = 'overview' | 'tax' | 'rates' | 'docs' | 'terms' | 'templates';

export function ContractDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['contract', id], queryFn: () => api.get(`/contracts/${id}`) });
  const [tab, setTab] = useState<Tab>('overview');
  const [editing, setEditing] = useState(false);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const k = q.data;
  return (
    <>
      <PageHead title={k.title} sub={<><Link to={`/clients/${k.client_id}`}>{k.client_name}</Link> · {k.reference_no} · {d(k.start_date)} – {k.end_date ? d(k.end_date) : 'open'} · <Status s={k.status} /></>}>
        {can('client.write') && <button className="btn" onClick={() => setEditing(true)}>Edit contract</button>}
        <Link className="btn primary" to={`/billing?contract=${k.id}`}>Prepare bill</Link>
      </PageHead>
      <Tabs<Tab> tabs={[['overview', 'Overview'], ['tax', `Tax rules (${k.taxRules.length})`], ['rates', `Rate schemes (${k.schemes.length})`], ['docs', `Documents (${k.documents.length})`], ['terms', 'Extracted terms'], ['templates', `Bill templates (${k.templates.length})`]]} value={tab} onChange={setTab} />
      {tab === 'overview' && (
        <div className="grid g3">
          <div className="panel"><h3>Invoice</h3>
            <div>Rates {k.tax_mode} of tax; tax on {k.tax_level === 'line' ? 'each line' : 'bill total'}</div>
            <div>Rounding: {k.invoice_rounding.replace('_', ' ')}</div>
            <div>Bill no. format: <code>{k.bill_no_format}</code></div>
            <div>Approval: {k.approval_levels === 2 ? 'reviewer + approver' : 'approver'}</div></div>
          <div className="panel"><h3>Work order / PO</h3><div>{k.po_number || '—'}</div><h3 style={{ marginTop: 10 }}>Required formats</h3><div className="pre">{k.required_formats || '—'}</div></div>
          <div className="panel"><h3>Special instructions</h3><div className="pre">{k.special_instructions || '—'}</div></div>
        </div>
      )}
      {tab === 'tax' && <TaxRules contractId={k.id} rules={k.taxRules} reload={q.refetch} />}
      {tab === 'rates' && <SchemesList contractId={k.id} schemes={k.schemes} reload={q.refetch} />}
      {tab === 'docs' && (
        <div className="panel tight"><table className="t"><thead><tr><th>Document</th><th>Type</th><th>Latest version</th><th>Added</th></tr></thead>
          <tbody>{k.documents.map((x: any) => <tr key={x.id}><td><Link to={`/documents/${x.id}`}>{x.title}</Link></td><td>{x.doc_type}</td><td>v{x.latest_version}</td><td>{dt(x.created_at)}</td></tr>)}
            {k.documents.length === 0 && <tr><td colSpan={4} className="empty">No documents. <Link to={`/documents?contract=${k.id}`}>Upload contract documents</Link>.</td></tr>}</tbody></table></div>
      )}
      {tab === 'terms' && <ExtractedTerms contractId={k.id} />}
      {tab === 'templates' && (
        <div className="panel tight"><table className="t"><thead><tr><th>Template</th><th>Scope</th></tr></thead>
          <tbody>{k.templates.map((t: any) => <tr key={t.id}><td><Link to={`/templates?client=${k.client_id}`}>{t.name}</Link></td><td>{t.contract_id ? 'This contract' : 'All contracts of the department'}</td></tr>)}
            {k.templates.length === 0 && <tr><td colSpan={2} className="empty">No bill template. <Link to="/templates">Create one</Link>.</td></tr>}</tbody></table></div>
      )}
      {editing && <Modal title="Edit contract" onClose={() => setEditing(false)} wide><ContractForm initial={k} onDone={() => { setEditing(false); q.refetch(); }} /></Modal>}
    </>
  );
}

function TaxRules({ contractId, rules, reload }: { contractId: string; rules: any[]; reload: () => void }) {
  const { can } = useAuth();
  const { run, busy } = useAction();
  const [form, setForm] = useState<any>(null);
  const [retire, setRetire] = useState<any>(null);
  const save = async () => {
    const r = await run(() => (form.id ? api.put(`/tax-rules/${form.id}`, form) : api.post(`/contracts/${contractId}/tax-rules`, form)), 'Tax rule saved');
    if (r) { setForm(null); reload(); }
  };
  return (
    <>
      <div className="alert warn">No tax rate is assumed. Enter each applicable tax with the clause or authority that establishes it; it only applies to bills after an approver approves it. To confirm an exemption, approve a 0% rule with its source.</div>
      <div className="panel tight">
        <table className="t">
          <thead><tr><th>Name</th><th>Type</th><th className="num">Rate %</th><th>Effective</th><th>Source / authority</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}><td>{r.name}</td><td>{r.tax_type}</td><td className="num">{r.rate}</td><td>{d(r.effective_from)} – {r.effective_to ? d(r.effective_to) : 'open'}</td><td>{r.source_ref || <span className="badge err">missing</span>}</td>
                <td><Status s={r.status} />{r.approved_by_name && <div className="small muted">by {r.approved_by_name}</div>}</td>
                <td className="nowrap">
                  {r.status === 'draft' && can('tax.write') && <button className="btn sm" onClick={() => setForm(r)}>Edit</button>}{' '}
                  {r.status === 'draft' && can('tax.approve') && <button className="btn sm ok" disabled={busy} onClick={async () => { if (await run(() => api.post(`/tax-rules/${r.id}/approve`), 'Tax rule approved')) reload(); }}>Approve</button>}
                  {r.status === 'approved' && can('tax.approve') && <button className="btn sm" onClick={() => setRetire(r)}>End / retire</button>}
                </td></tr>
            ))}
            {rules.length === 0 && <tr><td colSpan={7} className="empty">No tax rules configured.</td></tr>}
          </tbody>
        </table>
      </div>
      {can('tax.write') && <button className="btn primary" onClick={() => setForm({ name: '', tax_type: 'CGST', rate: '', effective_from: '', effective_to: '', source_ref: '' })}>Add tax rule</button>}
      {form && (
        <Modal title="Tax rule" onClose={() => setForm(null)}>
          <div className="grid g2">
            <Field label="Name" required><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Type" required><select value={form.tax_type} onChange={(e) => setForm({ ...form, tax_type: e.target.value })}>{['CGST', 'SGST', 'IGST', 'UTGST', 'CESS', 'OTHER'].map((t) => <option key={t}>{t}</option>)}</select></Field>
            <Field label="Rate (%)" required><input value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} inputMode="decimal" /></Field>
            <Field label="Contract clause / notification / authority" required><input value={form.source_ref ?? ''} onChange={(e) => setForm({ ...form, source_ref: e.target.value })} /></Field>
            <Field label="Effective from" required><input type="date" value={form.effective_from} onChange={(e) => setForm({ ...form, effective_from: e.target.value })} /></Field>
            <Field label="Effective to"><input type="date" value={form.effective_to ?? ''} onChange={(e) => setForm({ ...form, effective_to: e.target.value || null })} /></Field>
          </div>
          <div className="row end" style={{ marginTop: 12 }}><button className="btn" onClick={() => setForm(null)}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Save</button></div>
        </Modal>
      )}
      {retire && <Confirm text={`Retire "${retire.name}"? It will no longer apply to new calculations. Existing bills keep their snapshot.`} onClose={() => setRetire(null)} yesLabel="Retire" danger
        onYes={async () => { if (await run(() => api.post(`/tax-rules/${retire.id}/retire`), 'Retired')) { setRetire(null); reload(); } }} />}
    </>
  );
}

function SchemesList({ contractId, schemes, reload }: { contractId: string; schemes: any[]; reload: () => void }) {
  const { can } = useAuth();
  const { run } = useAction();
  const [name, setName] = useState('');
  return (
    <>
      <div className="panel tight">
        <table className="t">
          <thead><tr><th>Scheme</th><th>Versions</th></tr></thead>
          <tbody>
            {schemes.map((s) => (
              <tr key={s.id}><td>{s.name}<div className="small muted">{s.description}</div></td>
                <td>{(s.versions ?? []).map((v: any) => <div key={v.id}><Link to={`/rates/versions/${v.id}`}>v{v.version_no}</Link> <Status s={v.status} /> <span className="small muted">{d(v.effective_from)} – {v.effective_to ? d(v.effective_to) : 'open'}</span></div>)}
                  {can('rate.write') && <button className="btn sm" onClick={async () => { const r = await run(() => api.post(`/rate-schemes/${s.id}/versions`, { effective_from: new Date().toISOString().slice(0, 10), config: blankConfig() })); if (r) location.href = `/rates/versions/${r.id}`; }}>New version</button>}</td></tr>
            ))}
            {schemes.length === 0 && <tr><td colSpan={2} className="empty">No rate schemes yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {can('rate.write') && (
        <div className="row"><input placeholder="New scheme name, e.g. Innova daily package" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 320 }} />
          <button className="btn primary" disabled={!name.trim()} onClick={async () => { if (await run(() => api.post('/rate-schemes', { contract_id: contractId, name }), 'Scheme created')) { setName(''); reload(); } }}>Add scheme</button></div>
      )}
    </>
  );
}

export function blankConfig() {
  return {
    billingModel: 'daily_package',
    params: { includedKm: '0', includedHours: '0', graceMinutes: 0, graceMode: 'waive_within', hourRounding: { mode: 'exact', unit: '60' }, kmRounding: { mode: 'exact', unit: '1' }, kmAdjustment: '0', night: { enabled: false, start: '22:00', end: '06:00', minOverlapMinutes: 1, countMode: 'per_night' }, monthlyIncludedKm: '0', monthlyIncludedHours: '0', variables: [] },
    components: [{ code: 'BASE', label: 'Base duty charge', scope: 'duty', kind: 'charge', quantityExpr: '1', rate: '0', unit: 'duty', taxCategory: 'taxable', quantityDp: 2, quantityRoundMode: 'half_up', showWhenZero: false }],
    amountDp: 2,
    amountRoundMode: 'half_up',
  };
}

function ExtractedTerms({ contractId }: { contractId: string }) {
  const q = useQuery({ queryKey: ['terms', contractId], queryFn: () => api.get<any[]>(`/contracts/${contractId}/extracted-terms`) });
  if (q.isLoading) return <Loading />;
  const rows = q.data ?? [];
  return (
    <div className="panel tight">
      <div className="alert info" style={{ margin: 10 }}>Candidate terms found in this contract's documents. Accepted terms are a reference for configuring rate schemes and tax rules — they never change bills on their own.</div>
      <table className="t">
        <thead><tr><th>Term</th><th>Applies to</th><th>Value</th><th>Source</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}><td>{r.label}{r.conflict && <> <span className="badge err">conflict</span></>}</td><td>{r.qualifier}</td><td><b>{r.edited_value ?? r.value}</b> {r.unit}</td>
              <td className="small"><Link to={`/documents/${r.document_id}`}>{r.document_title}</Link> v{r.version_no}{r.source_page ? `, p.${r.source_page}` : ''}<div className="muted">“{r.source_text?.slice(0, 160)}”</div></td><td><Status s={r.status} /></td></tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="empty">No extracted terms yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
