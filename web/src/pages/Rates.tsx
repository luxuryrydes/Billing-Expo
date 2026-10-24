import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { Confirm, ErrorBox, Field, Loading, Modal, PageHead, Status, useAction } from '../components/ui';
import { d, inr } from '../format';
import { useCategories, useClients, useContracts, useDutyTypes } from '../lookups';
import { blankConfig } from './Contracts';
import { ImportDialog } from '../components/ImportDialog';

const MODELS: [string, string][] = [
  ['daily_package', 'Daily package (km + hours)'], ['monthly_package', 'Monthly vehicle hire'], ['monthly_limit', 'Monthly km/hour limit + excess'],
  ['hourly_km', 'Hourly or per-km'], ['fixed_trip', 'Fixed trip / transfer'], ['hybrid', 'Hybrid'],
];

/** Common component presets — the rates are always blank and must come from the approved contract. */
const PRESETS: Record<string, any> = {
  'Base package charge': { code: 'BASE', label: 'Base duty charge', scope: 'duty', kind: 'charge', quantityExpr: '1', unit: 'duty', taxCategory: 'taxable' },
  'Extra kilometres': { code: 'EXKM', label: 'Extra km', scope: 'duty', kind: 'charge', quantityExpr: 'extra_km', unit: 'km', taxCategory: 'taxable' },
  'Extra hours': { code: 'EXHR', label: 'Extra hours', scope: 'duty', kind: 'charge', quantityExpr: 'extra_hours', unit: 'hr', taxCategory: 'taxable' },
  'Night charge': { code: 'NIGHT', label: 'Night charge', scope: 'duty', kind: 'charge', quantityExpr: 'night_count', unit: 'night', taxCategory: 'taxable' },
  'Toll reimbursement': { code: 'TOLL', label: 'Toll', scope: 'duty', kind: 'reimbursement', quantityExpr: 'toll', unit: '', taxCategory: 'non_taxable', rate: '1' },
  'Parking reimbursement': { code: 'PARK', label: 'Parking', scope: 'duty', kind: 'reimbursement', quantityExpr: 'parking', unit: '', taxCategory: 'non_taxable', rate: '1' },
  'Outstation extra days': { code: 'OUTDAY', label: 'Additional day', scope: 'duty', kind: 'charge', quantityExpr: 'max(0, days_spanned - 1)', unit: 'day', taxCategory: 'taxable', condition: "duty_type == 'OUTSTATION'" },
  'Per km (all km)': { code: 'KM', label: 'Kilometre charge', scope: 'duty', kind: 'charge', quantityExpr: 'billable_km', unit: 'km', taxCategory: 'taxable' },
  'Per hour (all hours)': { code: 'HR', label: 'Hourly charge', scope: 'duty', kind: 'charge', quantityExpr: 'billable_hours', unit: 'hr', taxCategory: 'taxable' },
  'Monthly hire (prorated by days deployed)': { code: 'MONTHLY', label: 'Monthly hire charge', scope: 'vehicle_period', kind: 'charge', quantityExpr: 'days_deployed / period_days', quantityDp: 4, unit: 'month', taxCategory: 'taxable' },
  'Monthly hire (fixed)': { code: 'MONTHLY', label: 'Monthly hire charge', scope: 'vehicle_period', kind: 'charge', quantityExpr: '1', unit: 'month', taxCategory: 'taxable' },
  'Km beyond monthly limit': { code: 'MXKM', label: 'Km beyond monthly limit', scope: 'vehicle_period', kind: 'charge', quantityExpr: 'max(0, total_km - monthly_included_km)', unit: 'km', taxCategory: 'taxable' },
  'Minimum billing top-up': { code: 'MINTOP', label: 'Minimum billing top-up', scope: 'bill', kind: 'charge', quantityExpr: 'max(0, 0 - duty_charges)', unit: '', taxCategory: 'taxable', rate: '1' },
  'Contractual deduction': { code: 'DED', label: 'Deduction', scope: 'duty', kind: 'deduction', quantityExpr: '0', unit: '', taxCategory: 'taxable' },
};

export function RateSchemesPage() {
  const clients = useClients();
  const [clientId, setClientId] = useState('');
  const contracts = useContracts(clientId || undefined);
  const [contractId, setContractId] = useState('');
  const q = useQuery({ queryKey: ['rate-schemes', contractId], queryFn: () => api.get<any[]>(`/rate-schemes${qs({ contractId })}`) });
  const { can } = useAuth();
  const { run } = useAction();
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);
  const [importFor, setImportFor] = useState<string | null>(null);
  const [pickContract, setPickContract] = useState(false);
  const [f, setF] = useState({ contract_id: '', name: '', description: '' });
  return (
    <>
      <PageHead title="Rate Schemes" sub="Versioned, effective-dated billing rules per contract, vehicle category and duty type. Only approved versions are used for bills.">
        <select value={clientId} onChange={(e) => { setClientId(e.target.value); setContractId(''); }}><option value="">All departments</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <select value={contractId} onChange={(e) => setContractId(e.target.value)}><option value="">All contracts</option>{contracts.data?.map((k) => <option key={k.id} value={k.id}>{k.reference_no}</option>)}</select>
        {can('rate.write') && <button className="btn" onClick={() => (contractId ? setImportFor(contractId) : setPickContract(true))}>Import rate card</button>}
        {can('rate.write') && <button className="btn primary" onClick={() => { setF({ contract_id: contractId, name: '', description: '' }); setAdding(true); }}>New scheme</button>}
      </PageHead>
      <ErrorBox error={q.error} />
      <div className="panel tight">
        {q.isLoading ? <Loading /> : (
          <table className="t">
            <thead><tr><th>Department / contract</th><th>Scheme</th><th>Versions</th><th /></tr></thead>
            <tbody>
              {q.data?.map((s) => (
                <tr key={s.id}><td>{s.client_name}<div className="small muted">{s.reference_no}</div></td><td>{s.name}<div className="small muted">{s.description}</div></td>
                  <td>{(s.versions ?? []).map((v: any) => <div key={v.id}><Link to={`/rates/versions/${v.id}`}>v{v.version_no}</Link> <Status s={v.status} /> <span className="small muted">{MODELS.find((m) => m[0] === v.billing_model)?.[1]} · {d(v.effective_from)} – {v.effective_to ? d(v.effective_to) : 'open'}</span></div>)}</td>
                  <td>{can('rate.write') && <button className="btn sm" onClick={async () => { const r = await run(() => api.post(`/rate-schemes/${s.id}/versions`, { effective_from: new Date().toISOString().slice(0, 10), config: blankConfig() })); if (r) nav(`/rates/versions/${r.id}`); }}>New version</button>}</td></tr>
              ))}
              {q.data?.length === 0 && <tr><td colSpan={4} className="empty">No rate schemes.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      {pickContract && (
        <Modal title="Import rate card — choose the contract" onClose={() => setPickContract(false)}>
          <ContractPicker value={f.contract_id} onChange={(v) => setF({ ...f, contract_id: v })} />
          <div className="row end" style={{ marginTop: 12 }}><button className="btn" onClick={() => setPickContract(false)}>Cancel</button>
            <button className="btn primary" disabled={!f.contract_id} onClick={() => { setPickContract(false); setImportFor(f.contract_id); }}>Continue</button></div>
        </Modal>
      )}
      {importFor && <ImportDialog entity="rate_card" contractId={importFor} contextLabel={(() => { const k = contracts.data?.find((x) => x.id === importFor); return k ? `${k.client_name} — ${k.reference_no}` : undefined; })()} onClose={() => setImportFor(null)} onDone={() => q.refetch()} />}
      {adding && (
        <Modal title="New rate scheme" onClose={() => setAdding(false)}>
          <div className="grid">
            <ContractPicker value={f.contract_id} onChange={(v) => setF({ ...f, contract_id: v })} />
            <Field label="Scheme name" required hint="e.g. Innova — 80 km / 8 hrs package"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Description"><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
            <div className="row end"><button className="btn" onClick={() => setAdding(false)}>Cancel</button>
              <button className="btn primary" disabled={!f.contract_id || !f.name} onClick={async () => {
                const s = await run(() => api.post('/rate-schemes', f));
                if (!s) return;
                const v = await run(() => api.post(`/rate-schemes/${s.id}/versions`, { effective_from: new Date().toISOString().slice(0, 10), config: blankConfig() }));
                if (v) nav(`/rates/versions/${v.id}`);
              }}>Create and configure</button></div>
          </div>
        </Modal>
      )}
    </>
  );
}

function ContractPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const contracts = useContracts();
  return <Field label="Contract" required><select value={value} onChange={(e) => onChange(e.target.value)}><option value="">Select…</option>{contracts.data?.map((k) => <option key={k.id} value={k.id}>{k.client_name} — {k.reference_no}</option>)}</select></Field>;
}

export function RateVersionPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['rate-version', id], queryFn: () => api.get(`/rate-versions/${id}`) });
  const vars = useQuery({ queryKey: ['rate-vars'], queryFn: () => api.get('/rates/variables') });
  const cats = useCategories();
  const types = useDutyTypes();
  const [v, setV] = useState<any>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [reject, setReject] = useState(false);
  const { run, busy } = useAction();
  const nav = useNavigate();
  useEffect(() => { if (q.data) { setV(structuredClone(q.data)); setDirty(false); } }, [q.data]);
  if (q.isLoading || !v) return q.error ? <ErrorBox error={q.error} /> : <Loading />;
  const editable = ['draft', 'rejected'].includes(q.data.status) && can('rate.write');
  const cfg = v.config;
  const upd = (fn: (c: any) => void) => { const n = structuredClone(v); fn(n.config); setV(n); setDirty(true); };
  const updV = (k: string, val: unknown) => { setV({ ...v, [k]: val }); setDirty(true); };
  const p = cfg.params;
  const save = async () => {
    const r = await run(() => api.put(`/rate-versions/${id}`, { effective_from: v.effective_from, effective_to: v.effective_to || null, vehicle_category_ids: v.vehicle_category_ids, duty_type_codes: v.duty_type_codes, config: cfg, clause_ref: v.clause_ref, notes: v.notes }), 'Saved');
    if (r) { setProblems(r.problems ?? []); q.refetch(); }
  };
  const act = async (path: string, body: unknown = {}, ok = 'Done') => { if (await run(() => api.post(`/rate-versions/${id}/${path}`, body), ok)) q.refetch(); };
  const varNames = Object.keys(vars.data?.duty ?? {});
  return (
    <>
      <PageHead title={`${v.scheme_name} — version ${v.version_no}`} sub={<><Link to={`/contracts/${v.contract_id}`}>{v.contract_title}</Link> · <Status s={q.data.status} /> {v.approved_by_name && <span className="small muted">approved by {v.approved_by_name}</span>}</>}>
        {editable && <button className="btn primary" disabled={!dirty || busy} onClick={save}>Save draft</button>}
        {editable && <button className="btn" disabled={dirty || busy} onClick={() => act('submit', {}, 'Submitted for approval')}>Submit for approval</button>}
        {q.data.status === 'pending_approval' && can('rate.approve') && <><button className="btn ok" disabled={busy} onClick={() => act('approve', {}, 'Approved')}>Approve</button><button className="btn danger" onClick={() => setReject(true)}>Reject</button></>}
        {q.data.status === 'approved' && can('rate.approve') && <button className="btn" onClick={() => act('retire', {}, 'Retired')}>Retire</button>}
        {can('rate.write') && <button className="btn" disabled={busy} onClick={async () => { const r = await run(() => api.post(`/rate-versions/${id}/clone`, {})); if (r) nav(`/rates/versions/${r.id}`); }}>Copy as new version</button>}
      </PageHead>
      {!editable && <div className="alert info">This version is {q.data.status.replace('_', ' ')} and read-only. Copy it as a new version to change rates; bills already calculated keep the version they used.</div>}
      {problems.length > 0 && <div className="alert err">{problems.join('\n')}</div>}
      <fieldset disabled={!editable} style={{ border: 'none', padding: 0, margin: 0 }}>
        <div className="panel">
          <h2>Applicability</h2>
          <div className="grid g4">
            <Field label="Effective from" required><input type="date" value={v.effective_from} onChange={(e) => updV('effective_from', e.target.value)} /></Field>
            <Field label="Effective to" hint="Blank = open-ended"><input type="date" value={v.effective_to ?? ''} onChange={(e) => updV('effective_to', e.target.value || null)} /></Field>
            <Field label="Billing model"><select value={cfg.billingModel} onChange={(e) => upd((c) => (c.billingModel = e.target.value))}>{MODELS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="Contract clause reference"><input value={v.clause_ref ?? ''} onChange={(e) => updV('clause_ref', e.target.value)} /></Field>
          </div>
          <div className="grid g2" style={{ marginTop: 10 }}>
            <Field label="Vehicle categories" hint="None ticked = all categories">
              <div className="row">{cats.data?.map((c) => <label key={c.id} className="check"><input type="checkbox" checked={v.vehicle_category_ids.includes(c.id)} onChange={(e) => updV('vehicle_category_ids', e.target.checked ? [...v.vehicle_category_ids, c.id] : v.vehicle_category_ids.filter((x: string) => x !== c.id))} />{c.name}</label>)}</div>
            </Field>
            <Field label="Duty types" hint="None ticked = all duty types">
              <div className="row">{types.data?.map((t) => <label key={t.code} className="check"><input type="checkbox" checked={v.duty_type_codes.includes(t.code)} onChange={(e) => updV('duty_type_codes', e.target.checked ? [...v.duty_type_codes, t.code] : v.duty_type_codes.filter((x: string) => x !== t.code))} />{t.name}</label>)}</div>
            </Field>
          </div>
        </div>
        <div className="panel">
          <h2>Package parameters</h2>
          <div className="grid g4">
            <Field label="Included km per duty"><input value={p.includedKm} onChange={(e) => upd((c) => (c.params.includedKm = e.target.value))} /></Field>
            <Field label="Included hours per duty"><input value={p.includedHours} onChange={(e) => upd((c) => (c.params.includedHours = e.target.value))} /></Field>
            <Field label="Km adjustment" hint="Added to actual km (e.g. garage-to-garage)"><input value={p.kmAdjustment} onChange={(e) => upd((c) => (c.params.kmAdjustment = e.target.value))} /></Field>
            <Field label="Km rounding"><div className="row"><select value={p.kmRounding.mode} onChange={(e) => upd((c) => (c.params.kmRounding.mode = e.target.value))}><option value="exact">Exact</option><option value="ceil">Round up</option><option value="floor">Round down</option><option value="nearest">Nearest</option></select><input style={{ width: 70 }} value={p.kmRounding.unit} onChange={(e) => upd((c) => (c.params.kmRounding.unit = e.target.value))} title="to multiple of (km)" /></div></Field>
            <Field label="Hour rounding" hint="Unit in minutes (60 = whole hours, 30 = half hours)"><div className="row"><select value={p.hourRounding.mode} onChange={(e) => upd((c) => (c.params.hourRounding.mode = e.target.value))}><option value="exact">Exact</option><option value="ceil">Round up</option><option value="floor">Round down</option><option value="nearest">Nearest</option></select><input style={{ width: 70 }} value={p.hourRounding.unit} onChange={(e) => upd((c) => (c.params.hourRounding.unit = e.target.value))} /></div></Field>
            <Field label="Grace minutes"><input type="number" value={p.graceMinutes} onChange={(e) => upd((c) => (c.params.graceMinutes = Number(e.target.value)))} /></Field>
            <Field label="Grace rule"><select value={p.graceMode} onChange={(e) => upd((c) => (c.params.graceMode = e.target.value))}><option value="waive_within">Waive excess within grace</option><option value="deduct">Deduct grace from excess</option></select></Field>
            <Field label="Monthly included km / hours" hint="For monthly-limit models"><div className="row"><input style={{ width: 90 }} value={p.monthlyIncludedKm} onChange={(e) => upd((c) => (c.params.monthlyIncludedKm = e.target.value))} /><input style={{ width: 90 }} value={p.monthlyIncludedHours} onChange={(e) => upd((c) => (c.params.monthlyIncludedHours = e.target.value))} /></div></Field>
          </div>
          <h3 style={{ marginTop: 12 }}>Night charge window</h3>
          <div className="row">
            <label className="check"><input type="checkbox" checked={p.night.enabled} onChange={(e) => upd((c) => (c.params.night.enabled = e.target.checked))} />Count nights</label>
            from <input type="time" value={p.night.start} onChange={(e) => upd((c) => (c.params.night.start = e.target.value))} />
            to <input type="time" value={p.night.end} onChange={(e) => upd((c) => (c.params.night.end = e.target.value))} />
            min. overlap <input type="number" style={{ width: 70 }} value={p.night.minOverlapMinutes} onChange={(e) => upd((c) => (c.params.night.minOverlapMinutes = Number(e.target.value)))} /> min
            <select value={p.night.countMode} onChange={(e) => upd((c) => (c.params.night.countMode = e.target.value))}><option value="per_night">per night</option><option value="once_per_duty">once per duty</option></select>
          </div>
        </div>
        <div className="panel">
          <div className="row"><h2 style={{ margin: 0 }}>Charge components</h2><span className="spacer" />
            {editable && <select value="" onChange={(e) => { const pr = PRESETS[e.target.value]; if (pr) upd((c) => c.components.push({ rate: '0', quantityDp: 2, quantityRoundMode: 'half_up', showWhenZero: false, ...structuredClone(pr) })); }}>
              <option value="">Add component…</option>{Object.keys(PRESETS).map((k) => <option key={k}>{k}</option>)}</select>}</div>
          <p className="small muted">Components are evaluated in order. Quantity and condition are formulas over the variables listed below (e.g. <code>extra_km</code>, <code>max(0, billable_hours - 12)</code>, <code>duty_type == 'OUTSTATION'</code>). Rates must come from the approved contract — presets start at 0.</p>
          <div className="scroll">
            <table className="t cols-editor">
              <thead><tr><th>Code</th><th>Label on bill</th><th>Scope</th><th>Kind</th><th>Quantity formula</th><th>Rate (₹)</th><th>Unit</th><th>Tax</th><th>Condition (optional)</th><th>Min / max ₹</th><th>Clause</th><th /></tr></thead>
              <tbody>
                {cfg.components.map((c: any, i: number) => {
                  const set = (k: string, val: unknown) => upd((cc) => { cc.components[i][k] = val === '' && ['minAmount', 'maxAmount', 'condition', 'clauseRef'].includes(k) ? undefined : val; });
                  return (
                    <tr key={i}>
                      <td><input style={{ width: 70 }} value={c.code} onChange={(e) => set('code', e.target.value.toUpperCase())} /></td>
                      <td><input value={c.label} onChange={(e) => set('label', e.target.value)} /></td>
                      <td><select value={c.scope} onChange={(e) => set('scope', e.target.value)}><option value="duty">Per duty</option><option value="vehicle_period">Per vehicle / period</option><option value="bill">Per bill</option></select></td>
                      <td><select value={c.kind} onChange={(e) => set('kind', e.target.value)}><option value="charge">Charge</option><option value="reimbursement">Reimbursement</option><option value="deduction">Deduction</option></select></td>
                      <td><input className="mono" list="vars" value={c.quantityExpr} onChange={(e) => set('quantityExpr', e.target.value)} /></td>
                      <td><input style={{ width: 80 }} value={c.rate} onChange={(e) => set('rate', e.target.value)} inputMode="decimal" /></td>
                      <td><input style={{ width: 55 }} value={c.unit} onChange={(e) => set('unit', e.target.value)} /></td>
                      <td><select value={c.taxCategory} onChange={(e) => set('taxCategory', e.target.value)}><option value="taxable">Taxable</option><option value="non_taxable">Non-taxable</option></select></td>
                      <td><input className="mono" value={c.condition ?? ''} onChange={(e) => set('condition', e.target.value)} /></td>
                      <td className="nowrap"><input style={{ width: 60 }} value={c.minAmount ?? ''} onChange={(e) => set('minAmount', e.target.value)} /><input style={{ width: 60 }} value={c.maxAmount ?? ''} onChange={(e) => set('maxAmount', e.target.value)} /></td>
                      <td><input style={{ width: 90 }} value={c.clauseRef ?? ''} onChange={(e) => set('clauseRef', e.target.value)} /></td>
                      <td className="nowrap">{editable && <><button className="btn sm" disabled={i === 0} onClick={() => upd((cc) => { const x = cc.components.splice(i, 1)[0]; cc.components.splice(i - 1, 0, x); })}>↑</button><button className="btn sm danger" onClick={() => upd((cc) => cc.components.splice(i, 1))}>✕</button></>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <datalist id="vars">{varNames.map((n) => <option key={n} value={n} />)}{Object.keys(vars.data?.period ?? {}).map((n) => <option key={n} value={n} />)}</datalist>
          <h3 style={{ marginTop: 12 }}>Custom variables</h3>
          {(p.variables ?? []).map((x: any, i: number) => (
            <div className="row" key={i} style={{ marginBottom: 4 }}>
              <input className="mono" style={{ width: 160 }} value={x.name} onChange={(e) => upd((c) => (c.params.variables[i].name = e.target.value))} placeholder="name" /> =
              <input className="mono" style={{ flex: 1 }} value={x.expr} onChange={(e) => upd((c) => (c.params.variables[i].expr = e.target.value))} placeholder="formula" />
              {editable && <button className="btn sm danger" onClick={() => upd((c) => c.params.variables.splice(i, 1))}>✕</button>}
            </div>
          ))}
          {editable && <button className="btn sm" onClick={() => upd((c) => c.params.variables.push({ name: '', expr: '' }))}>Add variable</button>}
        </div>
      </fieldset>
      <TestCalculator config={cfg} />
      <details className="panel"><summary><b>Available variables</b></summary>
        <div className="grid g2" style={{ marginTop: 8 }}>
          <table className="t"><thead><tr><th>Per duty</th><th /></tr></thead><tbody>{Object.entries(vars.data?.duty ?? {}).map(([k, l]) => <tr key={k}><td className="mono">{k}</td><td>{String(l)}</td></tr>)}<tr><td className="mono">f_&lt;field&gt;</td><td>Contract-specific duty fields</td></tr></tbody></table>
          <table className="t"><thead><tr><th>Per vehicle / bill</th><th /></tr></thead><tbody>{Object.entries(vars.data?.period ?? {}).map(([k, l]) => <tr key={k}><td className="mono">{k}</td><td>{String(l)}</td></tr>)}</tbody></table>
        </div>
        <p className="small muted">Functions: max, min, ceil(x, unit), floor(x, unit), round(x, dp), abs, if(cond, a, b), in(x, a, b, …). Operators: + − × ÷, comparisons, &amp;&amp;, ||.</p>
      </details>
      {reject && <Confirm text="Send this version back to the author?" needReason="Reason" onClose={() => setReject(false)} yesLabel="Reject" danger onYes={async (note) => { setReject(false); await act('reject', { note }, 'Rejected'); }} />}
    </>
  );
}

function TestCalculator({ config }: { config: any }) {
  const blank = { dutyDate: new Date().toISOString().slice(0, 10), startKm: '1000', endKm: '1080', startAt: '', endAt: '', toll: '', parking: '', dutyTypeCode: 'LOCAL', vehicleRegNo: 'TEST' };
  const [rows, setRows] = useState<any[]>([{ ...blank, startAt: `${blank.dutyDate} 09:00`, endAt: `${blank.dutyDate} 17:00` }]);
  const [res, setRes] = useState<any>(null);
  const { run, busy } = useAction();
  const calc = async () => {
    const r = await run(() => api.post('/rates/test', { config, duties: rows.map((x) => ({ ...x, toll: x.toll || null, parking: x.parking || null, startAt: x.startAt || null, endAt: x.endAt || null })) }));
    if (r) setRes(r);
  };
  return (
    <div className="panel">
      <h2>Test calculator</h2>
      <p className="small muted">Try example readings against the configuration above (saved or not). Nothing is stored. Taxes are not applied here.</p>
      <table className="t cols-editor">
        <thead><tr><th>Date</th><th>Duty type</th><th>Start km</th><th>Closing km</th><th>Start (YYYY-MM-DD HH:MM)</th><th>Closing</th><th>Toll</th><th>Parking</th><th /></tr></thead>
        <tbody>{rows.map((r, i) => {
          const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setRows(rows.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)));
          return <tr key={i}><td><input type="date" value={r.dutyDate} onChange={set('dutyDate')} /></td><td><input value={r.dutyTypeCode} onChange={set('dutyTypeCode')} /></td><td><input value={r.startKm} onChange={set('startKm')} /></td><td><input value={r.endKm} onChange={set('endKm')} /></td>
            <td><input value={r.startAt} onChange={set('startAt')} /></td><td><input value={r.endAt} onChange={set('endAt')} /></td><td><input value={r.toll} onChange={set('toll')} /></td><td><input value={r.parking} onChange={set('parking')} /></td>
            <td><button className="btn sm danger" onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button></td></tr>;
        })}</tbody>
      </table>
      <div className="row" style={{ marginTop: 8 }}><button className="btn sm" onClick={() => setRows([...rows, { ...rows[rows.length - 1] }])}>Add example</button><button className="btn primary" disabled={busy} onClick={calc}>Calculate</button></div>
      {res && (
        <div style={{ marginTop: 12 }}>
          {res.problems?.length > 0 && <div className="alert err">{res.problems.join('\n')}</div>}
          {res.results.map((r: any, i: number) => (
            <div key={r.dutyId} className="panel" style={{ background: '#fbfcfd' }}>
              <b>Example {i + 1}</b>{!r.ok && <div className="alert err" style={{ marginTop: 6 }}>{r.error}</div>}
              {r.ok && (
                <>
                  <div className="small muted" style={{ margin: '4px 0' }}>{['actual_km', 'billable_km', 'extra_km', 'duration_hours', 'billable_hours', 'extra_hours', 'night_count'].filter((k) => r.variables[k] !== undefined).map((k) => `${k} = ${r.variables[k]}`).join(' · ')}</div>
                  <table className="t"><thead><tr><th>Component</th><th>Inputs</th><th>Calculation</th><th className="num">Amount</th></tr></thead>
                    <tbody>{r.lines.map((l: any) => <tr key={l.componentCode}><td>{l.label}<div className="small muted">{l.taxCategory}</div></td><td className="small mono">{l.trace.quantityExpr}<br />{Object.entries(l.trace.inputs).map(([k, x]) => `${k}=${x}`).join(', ')}</td><td className="mono small">{l.trace.formula}</td><td className="num">{inr(l.amount)}</td></tr>)}
                      {r.lines.length === 0 && <tr><td colSpan={4} className="muted">No charges apply.</td></tr>}</tbody>
                    <tfoot><tr><td colSpan={3}>Duty total</td><td className="num">{inr(r.lines.reduce((a: number, l: any) => a + Math.round(Number(l.amount) * 100), 0) / 100)}</td></tr></tfoot></table>
                </>
              )}
            </div>
          ))}
          {res.periodLines?.length > 0 && <div className="panel"><b>Per-vehicle / per-bill components</b><table className="t"><tbody>{res.periodLines.map((l: any, i: number) => <tr key={i}><td>{l.label} {l.vehicleRegNo}</td><td className="mono small">{l.trace.formula}</td><td className="num">{inr(l.amount)}</td></tr>)}</tbody></table></div>}
          <div className="right"><b>All examples: {inr(res.totals.preRoundTotal)}</b> <span className="small muted">(before tax)</span></div>
          <p className="small muted">{res.note}</p>
        </div>
      )}
    </div>
  );
}
