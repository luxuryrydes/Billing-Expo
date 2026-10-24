import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Field, Loading, Modal, PageHead, Status, Tabs, useAction } from '../components/ui';
import { ImportDialog } from '../components/ImportDialog';
import { RateCardDialog, RegisterImportDialog } from '../components/RateCard';
import { DocumentList, DocumentUploader } from '../components/DocumentUploader';
import { d } from '../format';
import { ContractForm } from './Contracts';

type Entity = 'departments' | 'institutions';
const rate = (v: unknown) => (v == null || v === '' ? '' : String(Number(v)));
const list = (v: unknown) => (Array.isArray(v) ? v.join(', ') : '');

const GST_MODES: [string, string][] = [['', '—'], ['include', 'GST added to the bill (include)'], ['show_separate', 'GST shown separately'], ['rcm', 'Reverse charge (RCM)'], ['exempt', 'Exempt']];

/** Add / edit form. Saves through the same validation as the Excel import. */
export function MasterForm({ entity, initial, onDone }: { entity: Entity; initial?: any; onDone: (saved?: any) => void }) {
  const isInst = entity === 'institutions';
  const [f, setF] = useState<any>(() => ({
    name: initial?.name ?? '', code: initial?.code ?? '', aliases: list(initial?.aliases), invoice_prefix: initial?.invoice_prefix ?? '', default_package: initial?.default_package ?? '',
    gst_label: initial?.gst_label ?? '', company: initial?.company ?? '', billing_address: initial?.billing_address ?? '', gstin: initial?.gstin ?? '', notes: initial?.notes ?? '',
    header_title: initial?.header_title ?? '', header_subtitle: initial?.header_subtitle ?? '', gst_mode: initial?.gst_mode ?? '', cgst_rate: rate(initial?.cgst_rate), sgst_rate: rate(initial?.sgst_rate),
    igst_rate: rate(initial?.igst_rate), vendor_sac: initial?.vendor_sac ?? '', vendor_gstin: initial?.vendor_gstin ?? '', duty_fields: list(initial?.duty_fields), terms: initial?.terms ?? '',
  }));
  const [extra, setExtra] = useState<[string, string][]>(Object.entries(initial?.extra ?? {}).map(([k, v]) => [k, String(v)]));
  const { run, busy } = useAction();
  const qc = useQueryClient();
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    const keys = isInst
      ? ['code', 'name', 'header_title', 'header_subtitle', 'invoice_prefix', 'gst_mode', 'cgst_rate', 'sgst_rate', 'igst_rate', 'vendor_sac', 'vendor_gstin', 'billing_address', 'gstin', 'duty_fields', 'terms', 'notes']
      : ['name', 'aliases', 'invoice_prefix', 'default_package', 'gst_label', 'company', 'billing_address', 'gstin', 'notes'];
    const body: Record<string, unknown> = Object.fromEntries(keys.map((k) => [k, f[k]]));
    body.extra = Object.fromEntries(extra.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v]));
    const r = await run(() => (initial?.id ? api.put(`/master/${entity}/${initial.id}`, body) : api.post(`/master/${entity}`, body)), 'Saved');
    if (r) { qc.invalidateQueries(); onDone(r); }
  };
  return (
    <div className="grid">
      <div className="grid g3">
        {isInst && <Field label="Code" required hint="Stable key used to match imports, e.g. crri"><input value={f.code} onChange={set('code')} /></Field>}
        <Field label="Name" required hint={isInst ? undefined : 'Stable key used to match imports'}><input value={f.name} onChange={set('name')} /></Field>
        {!isInst && <Field label="Aliases" hint="Names on duty sheets, comma-separated"><input value={f.aliases} onChange={set('aliases')} /></Field>}
        {!isInst && <Field label="Company (name on bills)"><input value={f.company} onChange={set('company')} /></Field>}
        {isInst && <Field label="Header title"><input value={f.header_title} onChange={set('header_title')} /></Field>}
        {isInst && <Field label="Header subtitle"><input value={f.header_subtitle} onChange={set('header_subtitle')} /></Field>}
        <Field label="Invoice prefix" hint="e.g. LRTS/26-27"><input value={f.invoice_prefix} onChange={set('invoice_prefix')} /></Field>
        {!isInst && <Field label="Default package"><input value={f.default_package} onChange={set('default_package')} /></Field>}
      </div>
      <h3>GST</h3>
      {isInst ? (
        <div className="grid g4">
          <Field label="GST mode"><select value={f.gst_mode} onChange={set('gst_mode')}>{GST_MODES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}{f.gst_mode && !GST_MODES.some(([k]) => k === f.gst_mode) && <option value={f.gst_mode}>{f.gst_mode}</option>}</select></Field>
          <Field label="CGST %"><input value={f.cgst_rate} onChange={set('cgst_rate')} inputMode="decimal" /></Field>
          <Field label="SGST %"><input value={f.sgst_rate} onChange={set('sgst_rate')} inputMode="decimal" /></Field>
          <Field label="IGST %"><input value={f.igst_rate} onChange={set('igst_rate')} inputMode="decimal" /></Field>
          <Field label="Vendor SAC"><input value={f.vendor_sac} onChange={set('vendor_sac')} /></Field>
          <Field label="Vendor GSTIN (our registration)"><input value={f.vendor_gstin} onChange={set('vendor_gstin')} /></Field>
        </div>
      ) : (
        <div className="grid g2">
          <Field label="GST" hint='As written, e.g. "Split 2.5+2.5%", "18% IGST", "GST Under RCM(Invoice)". Rates are worked out from it when clear.'><input value={f.gst_label} onChange={set('gst_label')} /></Field>
          <div className="small muted" style={{ alignSelf: 'end' }}>{initial ? `Current rates: CGST ${rate(initial.cgst_rate) || '—'}%, SGST ${rate(initial.sgst_rate) || '—'}%, IGST ${rate(initial.igst_rate) || '—'}%` : ''}</div>
        </div>
      )}
      <div className="grid g2">
        <Field label="Client address"><textarea value={f.billing_address} onChange={set('billing_address')} /></Field>
        <Field label="Client GSTIN" hint="15 characters; state is taken from the first two digits"><input value={f.gstin} onChange={set('gstin')} /></Field>
      </div>
      {isInst && <div className="grid g2">
        <Field label="Custom duty fields" hint="Comma-separated, e.g. User Name, Division, Project Code"><input value={f.duty_fields} onChange={set('duty_fields')} /></Field>
        <Field label="Terms"><textarea value={f.terms} onChange={set('terms')} /></Field>
      </div>}
      <Field label="Notes"><textarea value={f.notes} onChange={set('notes')} /></Field>
      <details open={extra.length > 0}><summary className="small"><b>Extra fields</b> ({extra.length}) — information without a dedicated field, e.g. from imported columns</summary>
        {extra.map(([k, v], i) => (
          <div className="row" key={i} style={{ marginTop: 4 }}>
            <input value={k} onChange={(e) => setExtra(extra.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} placeholder="Field" style={{ width: 200 }} />
            <input value={v} onChange={(e) => setExtra(extra.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} placeholder="Value" style={{ flex: 1 }} />
            <button className="btn sm danger" onClick={() => setExtra(extra.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <button className="btn sm" style={{ marginTop: 6 }} onClick={() => setExtra([...extra, ['', '']])}>Add field</button>
      </details>
      <div className="row end"><button className="btn" onClick={() => onDone()}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Save changes</button></div>
    </div>
  );
}

export function ClientsPage() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Entity) ?? 'departments';
  const [search, setSearch] = useState('');
  const q = useQuery({ queryKey: ['master', tab, search], queryFn: () => api.get<any[]>(`/master/${tab}${qs({ q: search })}`) });
  const counts = useQuery({ queryKey: ['master-counts'], queryFn: async () => ({ d: (await api.get<any[]>('/master/departments')).length, i: (await api.get<any[]>('/master/institutions')).length }) });
  const [edit, setEdit] = useState<any>(null);
  const [importing, setImporting] = useState(false);
  const [register, setRegister] = useState(false);
  const [card, setCard] = useState<any>(null);
  const isInst = tab === 'institutions';
  const rows = q.data ?? [];
  return (
    <>
      <PageHead title="Departments & Institutions" sub="Client master data used on contracts, duty sheets and bills. Add records by hand or import them from Excel — both use the same checks." />
      <Tabs<Entity> tabs={[['departments', `Departments (${counts.data?.d ?? '…'})`], ['institutions', `Institutions (${counts.data?.i ?? '…'})`]]} value={tab} onChange={(t) => setSp({ tab: t })} />
      <div className="actions-bar">
        <input placeholder={isInst ? 'Search code, name, GSTIN…' : 'Search name, alias, GSTIN…'} value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 260 }} />
        <span className="spacer" />
        {can('client.write') && <button className="btn primary" onClick={() => setEdit({})}>Add new</button>}
        {can('client.write') && <button className="btn" onClick={() => setImporting(true)}>Import Excel</button>}
        <a className="btn" href={`/api/imports/${tab}/template.xlsx`}>Download template</a>
        {can('export') && <a className="btn" href={`/api/imports/${tab}/export.xlsx`}>Download current list</a>}
        <span className="sep" />
        {can('rate.write') && can('client.write') && <button className="btn" onClick={() => setRegister(true)}>Import rate register</button>}
        {can('export') && <a className="btn" href="/api/imports/register/export.xlsx" title="All departments with their current rate cards, in the register layout. Edit it and import it back: only the changes are applied.">Export rate register</a>}
        {can('client.write') && <><span className="sep" /><Link className="btn" to="/onboarding">Set up from documents</Link></>}
      </div>
      <ErrorBox error={q.error} />
      <div className="panel tight">
        {q.isLoading ? <Loading /> : (
          <div className="scroll">
            <table className="t">
              <thead>{isInst
                ? <tr><th>Code</th><th>Name</th><th>Header title</th><th>Invoice prefix</th><th>GST mode</th><th className="num">CGST/SGST/IGST %</th><th>Vendor GSTIN</th><th>Client GSTIN</th><th>Custom fields</th><th className="num">Contracts</th><th /></tr>
                : <tr><th>Name</th><th>Aliases</th><th>Company</th><th>GST</th><th>Client GSTIN</th><th>State</th><th>Invoice prefix</th><th className="num">Contracts</th><th /></tr>}</thead>
              <tbody>
                {rows.map((c) => isInst ? (
                  <tr key={c.id}><td className="mono">{c.code}</td><td><Link to={`/clients/${c.id}`}>{c.name}</Link></td><td>{c.header_title}<div className="small muted">{c.header_subtitle}</div></td><td>{c.invoice_prefix}</td><td>{c.gst_mode}</td>
                    <td className="num">{[c.cgst_rate, c.sgst_rate, c.igst_rate].map(rate).join(' / ')}</td><td className="mono small">{c.vendor_gstin}</td><td className="mono small">{c.gstin}</td><td className="small">{list(c.duty_fields)}</td><td className="num">{c.contract_count}</td>
                    <td>{can('client.write') && <button className="btn sm" onClick={() => setEdit(c)}>Edit</button>}</td></tr>
                ) : (
                  <tr key={c.id}><td><Link to={`/clients/${c.id}`}>{c.name}</Link></td><td className="small">{list(c.aliases)}</td><td>{c.company}</td><td>{c.gst_label}<div className="small muted">{c.cgst_rate != null || c.igst_rate != null ? `C ${rate(c.cgst_rate) || 0} · S ${rate(c.sgst_rate) || 0} · I ${rate(c.igst_rate) || 0}` : 'rates not set'}</div></td>
                    <td className="mono small">{c.gstin}</td><td>{c.state_name}</td><td>{c.invoice_prefix}</td><td className="num">{c.contract_count}</td>
                    <td style={{ whiteSpace: 'nowrap' }}><button className="btn sm" onClick={() => setCard(c)}>Rate card</button> {can('client.write') && <button className="btn sm" onClick={() => setEdit(c)}>Edit</button>}</td></tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={11} className="empty">{search ? 'Nothing matches.' : `No ${tab} yet — add one, or import your Excel list.`}</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {edit && <Modal title={edit.id ? `Edit ${edit.name}` : `New ${isInst ? 'institution' : 'department'}`} onClose={() => setEdit(null)} wide><MasterForm entity={tab} initial={edit.id ? edit : undefined} onDone={() => setEdit(null)} /></Modal>}
      {importing && <ImportDialog entity={tab} onClose={() => setImporting(false)} onDone={() => { q.refetch(); counts.refetch(); }} />}
      {register && <RegisterImportDialog onClose={() => setRegister(false)} onDone={() => { q.refetch(); counts.refetch(); }} />}
      {card && <RateCardDialog clientId={card.id} clientName={card.name} onClose={() => setCard(null)} />}
    </>
  );
}

export function ClientDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['client', id], queryFn: () => api.get(`/clients/${id}`) });
  const docs = useQuery({ queryKey: ['client-docs', id], queryFn: () => api.get<any[]>(`/documents${qs({ clientId: id })}`) });
  const [editing, setEditing] = useState(false);
  const [newContract, setNewContract] = useState(false);
  const [card, setCard] = useState(false);
  const [tab, setTab] = useState<'contracts' | 'documents' | 'details'>('contracts');
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const c = q.data;
  const isInst = c.kind === 'institution';
  return (
    <>
      <PageHead title={c.name} sub={<>{isInst ? <>Institution <span className="mono">{c.code}</span></> : 'Department'} · GSTIN {c.gstin || '—'} · <Status s={c.status} /></>}>
        <button className="btn" onClick={() => setCard(true)}>Rate card</button>
        {can('client.write') && <button className="btn" onClick={() => setEditing(true)}>Edit</button>}
        {can('client.write') && <button className="btn primary" onClick={() => setNewContract(true)}>Add contract</button>}
      </PageHead>
      <Tabs tabs={[['contracts', `Contracts (${c.contracts.length})`], ['documents', `Documents (${docs.data?.length ?? '…'})`], ['details', 'Details']]} value={tab} onChange={setTab} />
      {tab === 'contracts' && (
        <div className="panel tight">
          <table className="t">
            <thead><tr><th>Contract</th><th>Reference</th><th>Work order / PO</th><th>Validity</th><th>Status</th></tr></thead>
            <tbody>
              {c.contracts.map((k: any) => <tr key={k.id}><td><Link to={`/contracts/${k.id}`}>{k.title}</Link></td><td>{k.reference_no}</td><td>{k.po_number}</td><td>{d(k.start_date)} – {k.end_date ? d(k.end_date) : 'open'}</td><td><Status s={k.status} /></td></tr>)}
              {c.contracts.length === 0 && <tr><td colSpan={5} className="empty">No contracts yet. Add one, or use “Set up from documents”.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {tab === 'documents' && (
        <>
          {can('document.upload') && <div className="actions-bar"><DocumentUploader clientId={c.id} onDone={() => docs.refetch()} /><span className="small muted">Documents of a specific contract are uploaded on that contract's Documents tab.</span></div>}
          <div className="panel tight"><DocumentList docs={docs.data ?? []} reload={() => docs.refetch()} /></div>
        </>
      )}
      {tab === 'details' && (
        <div className="grid g3">
          <div className="panel"><h3>Billing address</h3><div className="pre">{c.billing_address || '—'}</div><h3 style={{ marginTop: 10 }}>State</h3><div>{c.state_name ? `${c.state_name} (${c.state_code})` : '—'}</div>
            {!isInst && <><h3 style={{ marginTop: 10 }}>Aliases</h3><div>{list(c.aliases) || '—'}</div></>}</div>
          <div className="panel"><h3>Invoicing</h3>
            <div>Invoice prefix: {c.invoice_prefix || '—'}</div>
            {c.header_title && <div>Header: {c.header_title}<div className="small muted">{c.header_subtitle}</div></div>}
            <div>GST: {c.gst_label || c.gst_mode || '—'} {c.cgst_rate != null || c.igst_rate != null ? `(CGST ${rate(c.cgst_rate) || 0}%, SGST ${rate(c.sgst_rate) || 0}%, IGST ${rate(c.igst_rate) || 0}%)` : ''}</div>
            {c.vendor_gstin && <div>Our GSTIN: {c.vendor_gstin} · SAC {c.vendor_sac}</div>}
            {c.duty_fields?.length > 0 && <div>Duty fields: {list(c.duty_fields)}</div>}
            <p className="small muted">Tax applies to bills through each contract's approved tax rules; these are the department's defaults.</p></div>
          <div className="panel"><h3>Notes</h3><div className="pre">{c.notes || c.special_instructions || '—'}</div>
            {c.terms && <><h3 style={{ marginTop: 10 }}>Terms</h3><div className="pre">{c.terms}</div></>}
            {Object.keys(c.extra ?? {}).length > 0 && <><h3 style={{ marginTop: 10 }}>Extra fields</h3>{Object.entries(c.extra).map(([k, v]) => <div key={k}><b>{k}:</b> {String(v)}</div>)}</>}</div>
        </div>
      )}
      {editing && <Modal title={`Edit ${c.name}`} onClose={() => setEditing(false)} wide><MasterForm entity={isInst ? 'institutions' : 'departments'} initial={c} onDone={() => { setEditing(false); q.refetch(); }} /></Modal>}
      {card && <RateCardDialog clientId={c.id} clientName={c.name} onClose={() => { setCard(false); q.refetch(); }} />}
      {newContract && <Modal title="New contract" onClose={() => setNewContract(false)} wide><ContractForm initial={{ client_id: c.id }} onDone={() => { setNewContract(false); q.refetch(); }} /></Modal>}
    </>
  );
}
