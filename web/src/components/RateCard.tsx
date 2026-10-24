import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, downloadBlob, qs } from '../api';
import { useAuth } from '../auth';
import { useCategories } from '../lookups';
import { d } from '../format';
import { Confirm, ErrorBox, Field, Loading, Modal, Tabs, useAction } from './ui';

const today = () => new Date().toISOString().slice(0, 10);
const num = (v: unknown) => (v == null || v === '' ? '—' : String(Number(v)));
const money = (v: unknown) => (v == null || v === '' ? '—' : `₹${Number(v).toLocaleString('en-IN')}`);

const TAX_MODES: [string, string][] = [
  ['', 'No tax stated'], ['GST', 'GST % (IGST or CGST+SGST by state)'], ['CGST_SGST', 'CGST + SGST'], ['IGST', 'IGST'], ['RCM', 'Reverse charge (RCM)'], ['NONE', 'No tax / exempt'],
];

const blank = {
  vehicle: '', package: '', rateType: 'per_km_hr', baseFare: '', includedKm: '', includedHours: '', extraKm: '', extraHour: '',
  nightCharge: '', nightStart: '', nightEnd: '', driverAllowance: '', taxMode: '', gst: '', cgst: '', sgst: '', igst: '', notes: '',
};
const str = (v: unknown) => (v == null ? '' : String(v));

/**
 * One department's rate card: what each vehicle and package is billed at, today.
 * Adding or editing a rate creates a new version from the chosen date; earlier duties and
 * bills keep the rate they were made with. Removing a rate ends it, it never deletes history.
 */
export function RateCardDialog({ clientId, clientName, onClose }: { clientId: string; clientName: string; onClose: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [date, setDate] = useState(today());
  const q = useQuery({ queryKey: ['rate-card', clientId, date], queryFn: () => api.get(`/clients/${clientId}/rate-card${qs({ date })}`) });
  const cats = useCategories();
  const [f, setF] = useState<any>(blank);
  const [schemeId, setSchemeId] = useState<string | null>(null);
  const [from, setFrom] = useState(today());
  const [approve, setApprove] = useState(false);
  const [ending, setEnding] = useState<any>(null);
  const { run, busy } = useAction();
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.type === 'checkbox' ? ((e.target as HTMLInputElement).checked ? 'fixed' : 'per_km_hr') : e.target.value });
  const fixed = f.rateType === 'fixed';
  const data = q.data;

  const edit = (r: any) => {
    const e = r.entry;
    setSchemeId(r.schemeId);
    setF({ ...blank, ...Object.fromEntries(Object.keys(blank).map((k) => [k, str(e[k])])), taxMode: e.taxMode === 'DEFAULT_UNSPECIFIED' ? '' : str(e.taxMode), rateType: e.rateType });
    setFrom(r.effectiveFrom > today() ? r.effectiveFrom : today());
  };
  const reset = () => { setSchemeId(null); setF(blank); };
  const save = async () => {
    const entry = { ...f, taxLabel: f.taxMode === 'GST' && f.gst ? `GST ${f.gst}%` : null };
    const r = await run(() => api.post(`/clients/${clientId}/rate-card`, { entry, schemeId, effectiveFrom: from, approve }), schemeId ? 'Rate changed' : 'Rate added');
    if (r) { reset(); q.refetch(); qc.invalidateQueries({ queryKey: ['rates'] }); }
  };
  const end = async (r: any, lastDay: string) => {
    const ok = await run(() => api.post(`/clients/${clientId}/rate-card/${r.schemeId}/end`, { lastDay }), 'Rate ended');
    if (ok) q.refetch();
  };
  const setContract = async (contractId: string) => {
    const ok = await run(() => api.put(`/clients/${clientId}/rate-card-contract`, { contractId }), 'Rate card contract changed');
    if (ok) q.refetch();
  };

  return (
    <Modal title={`Rate Card — ${clientName}`} onClose={onClose} wide>
      <ErrorBox error={q.error} />
      {q.isLoading || !data ? <Loading /> : (
        <>
          <div className="actions-bar">
            <span className="small muted">Rates in force on</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <span className="small muted">Contract</span>
            {data.contracts.length > 1 && can('rate.write')
              ? <select value={data.contract.id ?? ''} onChange={(e) => setContract(e.target.value)}>{data.contracts.map((k: any) => <option key={k.id} value={k.id}>{k.reference_no || k.title}</option>)}</select>
              : <b className="small">{data.contract.label}</b>}
            {data.contract.warning && <span className="badge warn">{data.contract.warning}</span>}
          </div>
          <div className="scroll">
            <table className="t">
              <thead><tr><th>Vehicle</th><th>Package</th><th>Type</th><th className="num">Base ₹</th><th className="num">Inc. Km</th><th className="num">Inc. Hrs</th><th className="num">Extra/Km</th><th className="num">Extra/Hr</th><th className="num">Night ₹</th><th>Night slot</th><th className="num">Driver allow. ₹/day</th><th>Tax</th><th>From</th><th /></tr></thead>
              <tbody>
                {data.rates.map((r: any) => {
                  const e = r.entry;
                  return (
                    <tr key={r.schemeId} className={schemeId === r.schemeId ? 'sel' : ''}>
                      <td><b>{e.vehicle}</b></td><td>{e.package}</td>
                      <td>{e.rateType === 'fixed' ? <span className="badge brand">Fixed</span> : 'Per km/hr'}</td>
                      <td className="num">{money(e.baseFare)}</td><td className="num">{num(e.includedKm)}</td><td className="num">{num(e.includedHours)}</td>
                      <td className="num">{money(e.extraKm)}</td><td className="num">{money(e.extraHour)}</td><td className="num">{money(e.nightCharge)}</td>
                      <td className="small">{e.nightStart && e.nightEnd ? `${e.nightStart}–${e.nightEnd}` : '—'}</td>
                      <td className="num">{money(e.driverAllowance)}</td>
                      <td className="small" style={{ whiteSpace: 'nowrap' }}>{r.taxShown}</td>
                      <td className="small" style={{ whiteSpace: 'nowrap' }}>{d(r.effectiveFrom)}{r.pending && <div><span className="badge warn">awaiting approval</span></div>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {can('rate.write') && <button className="btn sm" title="Edit" aria-label={`Edit ${e.vehicle} ${e.package}`} onClick={() => edit(r)}>✎</button>}{' '}
                        {can('rate.approve') && <button className="btn sm danger" title="Stop this rate" aria-label={`Stop ${e.vehicle} ${e.package}`} onClick={() => setEnding(r)}>🗑</button>}
                      </td>
                    </tr>
                  );
                })}
                {data.rates.length === 0 && <tr><td colSpan={14} className="empty">No rates on {d(date)}. Add one below, or import the rate register.</td></tr>}
              </tbody>
            </table>
          </div>

          {can('rate.write') && (
            <div className="panel" style={{ marginTop: 12 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <h3 style={{ margin: 0 }}>{schemeId ? `Change ${f.vehicle} — ${f.package}` : 'Add rate'}</h3>
                {schemeId && <button className="btn sm" onClick={reset}>Cancel edit</button>}
              </div>
              <label className="row" style={{ gap: 6, margin: '8px 0' }}>
                <input type="checkbox" checked={fixed} onChange={set('rateType')} />
                <span><b>Fixed price package</b> <span className="small muted">— bills the base fare only; extra km/hr and night charges are ignored. Parking, tolls and taxes are still added.</span></span>
              </label>
              <div className="grid g4">
                <Field label="Vehicle" required>
                  <input list="rc-vehicles" value={f.vehicle} onChange={set('vehicle')} placeholder="Crysta" disabled={!!schemeId} />
                  <datalist id="rc-vehicles">{(cats.data ?? []).map((c) => <option key={c.id} value={c.name} />)}</datalist>
                </Field>
                <Field label="Package" required hint="e.g. 8hr/80km, Local 12hr/120km, Outstation 300km/day"><input value={f.package} onChange={set('package')} placeholder="8hr/80km" disabled={!!schemeId} /></Field>
                <Field label="Base fare ₹" required><input value={f.baseFare} onChange={set('baseFare')} inputMode="decimal" /></Field>
                <Field label="Inc. km"><input value={f.includedKm} onChange={set('includedKm')} inputMode="decimal" /></Field>
                <Field label="Inc. hrs"><input value={f.includedHours} onChange={set('includedHours')} inputMode="decimal" /></Field>
                <Field label="Extra / km ₹"><input value={f.extraKm} onChange={set('extraKm')} inputMode="decimal" disabled={fixed} /></Field>
                <Field label="Extra / hr ₹"><input value={f.extraHour} onChange={set('extraHour')} inputMode="decimal" disabled={fixed} /></Field>
              </div>
              <h3>Night charge <span className="small muted">(optional)</span></h3>
              <div className="grid g4">
                <Field label="Night charge ₹ (per trip)"><input value={f.nightCharge} onChange={set('nightCharge')} inputMode="decimal" disabled={fixed} /></Field>
                <Field label="Night starts at"><input type="time" value={f.nightStart} onChange={set('nightStart')} disabled={fixed} /></Field>
                <Field label="Night ends at"><input type="time" value={f.nightEnd} onChange={set('nightEnd')} disabled={fixed} /></Field>
                <Field label="Driver allowance ₹ (per day)"><input value={f.driverAllowance} onChange={set('driverAllowance')} inputMode="decimal" /></Field>
              </div>
              <h3>GST / Taxes</h3>
              <div className="grid g4">
                <Field label="Tax mode"><select value={f.taxMode} onChange={set('taxMode')}>{TAX_MODES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
                {f.taxMode === 'GST' && <Field label="GST %" hint="IGST if the department is in another state, else split CGST + SGST"><input value={f.gst} onChange={set('gst')} inputMode="decimal" /></Field>}
                {f.taxMode === 'CGST_SGST' && <><Field label="CGST %"><input value={f.cgst} onChange={set('cgst')} inputMode="decimal" /></Field><Field label="SGST %"><input value={f.sgst} onChange={set('sgst')} inputMode="decimal" /></Field></>}
                {f.taxMode === 'IGST' && <Field label="IGST %"><input value={f.igst} onChange={set('igst')} inputMode="decimal" /></Field>}
              </div>
              <div className="row end" style={{ marginTop: 10, gap: 10, flexWrap: 'wrap' }}>
                <Field label="Applies to duties from" hint={schemeId ? 'Earlier duties keep the old rate' : undefined}><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
                {data.canApprove && <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={approve} onChange={(e) => setApprove(e.target.checked)} /> Approve now</label>}
                <button className="btn primary" disabled={busy || !f.vehicle || !f.package || f.baseFare === ''} onClick={save}>{schemeId ? 'Save change' : '+ Add'}</button>
              </div>
              {!data.canApprove && <p className="small muted">New and changed rates wait for an approver before they are used on bills.</p>}
            </div>
          )}
          <div className="row end" style={{ marginTop: 10 }}><button className="btn" onClick={onClose}>Close</button></div>
        </>
      )}
      {ending && <EndRate r={ending} onClose={() => setEnding(null)} onYes={(day) => { end(ending, day); setEnding(null); }} />}
    </Modal>
  );
}

function EndRate({ r, onClose, onYes }: { r: any; onClose: () => void; onYes: (lastDay: string) => void }) {
  const [day, setDay] = useState(today());
  return (
    <Modal title={`Stop ${r.entry.vehicle} — ${r.entry.package}`} onClose={onClose}>
      <p>Duties after the last day can no longer be billed at this rate. Duties and bills up to that day keep it; nothing is deleted.</p>
      <Field label="Last day this rate applies"><input type="date" value={day} min={r.effectiveFrom} onChange={(e) => setDay(e.target.value)} /></Field>
      <div className="row end"><button className="btn" onClick={onClose}>Cancel</button><button className="btn danger" onClick={() => onYes(day)}>Stop rate</button></div>
    </Modal>
  );
}

const ACTION_LABEL: Record<string, string> = { add: 'New', update: 'Update', unchanged: 'No change', error: 'Error' };
const ACTION_TONE: Record<string, string> = { add: 'ok', update: 'brand', unchanged: '', error: 'err' };
const show = (v: unknown) => (v == null || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : String(v));

/**
 * Upload the Department & Rate Register (or the sheet exported from here, edited) →
 * see exactly what would change → confirm. Only departments and rates that differ from what is
 * saved are written; everything else stays as it is, and nothing is removed because a row is missing.
 */
export function RegisterImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const fy = (() => { const t = today(); const y = Number(t.slice(0, 4)) - (Number(t.slice(5, 7)) < 4 ? 1 : 0); return `${y}-04-01`; })();
  const [p, setP] = useState<any>(null);
  const [opts, setOpts] = useState<any>({ newRatesFrom: fy, changesFrom: today(), approve: false, hourRoundingMode: 'ceil', hourRoundingUnit: '30' });
  const [tab, setTab] = useState<'changes' | 'departments' | 'rates' | 'errors'>('changes');
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<any>(null);
  const [confirm, setConfirm] = useState(false);

  const upload = async (file: File) => {
    setBusy(true); setError(null); setDone(null);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await api.post('/imports/register/upload', fd);
      setP(r); setOpts({ ...opts, ...r.options, approve: r.canApprove && r.options.approve });
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const recheck = async (o = opts) => {
    setOpts(o); setBusy(true); setError(null);
    try { setP({ ...p, ...(await api.post('/imports/register/analyze', { fileId: p.fileId, options: o })) }); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const commit = async () => {
    setConfirm(false); setBusy(true); setError(null);
    try { setDone(await api.post('/imports/register/commit', { fileId: p.fileId, options: opts, skipInvalid })); onDone(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const errorReport = () => {
    const rows = [['Sheet', 'Row', 'Record', 'Errors', 'Warnings'],
      ...p.departments.filter((x: any) => x.errors.length || x.warnings.length).map((x: any) => [p.sheets.master, x.rowNumber, x.name, x.errors.join('; '), x.warnings.join('; ')]),
      ...p.rates.filter((x: any) => x.errors.length || x.warnings.length).map((x: any) => [p.sheets.rates, x.rowNumber, `${x.department} — ${x.vehicle} — ${x.package}`, x.errors.join('; '), x.warnings.join('; ')])];
    const csv = '﻿' + rows.map((r) => r.map((c: unknown) => { const s = String(c ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\r\n');
    downloadBlob(new Blob([csv], { type: 'text/csv' }), 'rate-register-errors.csv');
  };

  const s = p?.summary;
  const changes = p ? [...p.departments.filter((x: any) => x.action === 'add' || x.action === 'update').map((x: any) => ({ kind: 'dept', ...x })), ...p.rates.filter((x: any) => x.action === 'add' || x.action === 'update').map((x: any) => ({ kind: 'rate', ...x }))] : [];
  const errs = p ? [...p.departments.filter((x: any) => x.errors.length), ...p.rates.filter((x: any) => x.errors.length)] : [];
  const nothing = s && !s.departments.add && !s.departments.update && !s.rates.add && !s.rates.update && !s.taxChanges;

  return (
    <Modal title="Import Department & Rate Register" onClose={onClose} wide>
      {!p && (
        <>
          <p>Upload the register workbook — the original one or a copy exported from here and edited. You will see every change before anything is saved.</p>
          <ul className="small">
            <li>Only departments and rates that differ from what is saved are updated; everything else stays as it is.</li>
            <li>A department or rate missing from the sheet is <b>not</b> removed. Blank cells never clear a saved value.</li>
            <li>A changed rate becomes a new version from the date you choose — earlier duties and bills keep their rate.</li>
          </ul>
          <input type="file" accept=".xlsx,.xls" disabled={busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          {busy && <Loading />}
        </>
      )}
      <ErrorBox error={error} />
      {p && !done && (
        <>
          <div className="small muted" style={{ marginBottom: 8 }}>{p.fileName} · sheets: {[p.sheets.master, p.sheets.rates].filter(Boolean).join(', ')}</div>
          <div className="grid g4">
            <Field label="New rates apply from" hint="For departments, vehicles or packages not yet on the rate card"><input type="date" value={opts.newRatesFrom} onChange={(e) => recheck({ ...opts, newRatesFrom: e.target.value })} /></Field>
            <Field label="Changed rates apply from" hint="Earlier duties keep the old rate"><input type="date" value={opts.changesFrom} onChange={(e) => recheck({ ...opts, changesFrom: e.target.value })} /></Field>
            <Field label="Extra hours rounding"><select value={`${opts.hourRoundingMode}:${opts.hourRoundingUnit}`} onChange={(e) => { const [m, u] = e.target.value.split(':'); recheck({ ...opts, hourRoundingMode: m, hourRoundingUnit: u }); }}>
              <option value="ceil:30">Up to the next 30 min</option><option value="ceil:60">Up to the next hour</option><option value="exact:1">Exact minutes</option><option value="nearest:30">Nearest 30 min</option></select></Field>
            <div>{p.canApprove
              ? <label className="row" style={{ gap: 6, marginTop: 22 }}><input type="checkbox" checked={opts.approve} onChange={(e) => setOpts({ ...opts, approve: e.target.checked })} /> Approve rates and tax now</label>
              : <p className="small muted">Rates and tax will wait for an approver.</p>}</div>
          </div>
          <div className="stats" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '10px 0' }}>
            <span className="badge ok">{s.departments.add} new departments</span><span className="badge brand">{s.departments.update} departments updated</span><span className="badge">{s.departments.unchanged} unchanged</span>
            <span className="badge ok">{s.rates.add} new rates</span><span className="badge brand">{s.rates.update} rates changed</span><span className="badge">{s.rates.unchanged} unchanged</span>
            {s.taxChanges > 0 && <span className="badge brand">{s.taxChanges} tax changes</span>}
            {(s.departments.errors + s.rates.errors) > 0 && <span className="badge err">{s.departments.errors + s.rates.errors} errors</span>}
          </div>
          <Tabs<'changes' | 'departments' | 'rates' | 'errors'> tabs={[['changes', `What will change (${changes.length + (s.taxChanges ?? 0)})`], ['departments', `Departments (${p.departments.length})`], ['rates', `Rates (${p.rates.length})`], ['errors', `Errors (${errs.length})`]]} value={tab} onChange={setTab} />
          <div className="scroll" style={{ maxHeight: 380 }}>
            {tab === 'changes' && (
              nothing ? <div className="empty">Everything in this sheet already matches the software. Nothing will be changed.</div> : (
                <table className="t">
                  <thead><tr><th>Row</th><th>Department</th><th>Item</th><th>Change</th><th>Current → new</th></tr></thead>
                  <tbody>
                    {changes.map((x: any) => x.kind === 'dept' ? (
                      <tr key={`d${x.rowNumber}`}><td>{x.rowNumber}</td><td>{x.name}</td><td>Department details</td><td><span className={`badge ${ACTION_TONE[x.action]}`}>{ACTION_LABEL[x.action]}</span></td>
                        <td className="small">{x.action === 'add' ? 'New department' : Object.entries(x.changes).map(([k, c]: any) => <div key={k}><b>{k.replace(/_/g, ' ')}</b>: {show(c.from)} → {show(c.to)}</div>)}</td></tr>
                    ) : (
                      <tr key={`r${x.rowNumber}`}><td>{x.rowNumber}</td><td>{x.clientName}</td><td>{x.vehicle} — {x.package}</td><td><span className={`badge ${ACTION_TONE[x.action]}`}>{ACTION_LABEL[x.action]}</span><div className="small muted">from {d(x.effectiveFrom)}</div></td>
                        <td className="small">{x.action === 'add' ? `Base ${money(x.incoming.baseFare)} · ${x.tax}` : x.changes.map((c: string) => <div key={c}>{c}</div>)}</td></tr>
                    ))}
                    {p.plans.filter((pl: any) => pl.taxChange).map((pl: any) => (
                      <tr key={`t${pl.department}`}><td /><td>{pl.department}</td><td>Tax</td><td><span className="badge brand">Update</span></td><td className="small">{pl.taxChange}</td></tr>
                    ))}
                  </tbody>
                </table>
              )
            )}
            {tab === 'departments' && (
              <table className="t"><thead><tr><th>Row</th><th>Department</th><th>Matched to</th><th>Result</th><th>Notes</th></tr></thead>
                <tbody>{p.departments.map((x: any) => (
                  <tr key={x.rowNumber}><td>{x.rowNumber}</td><td>{x.name}</td><td className="small">{x.matchedTo ?? '—'}{x.how && <div className="muted">{x.how}</div>}</td><td><span className={`badge ${ACTION_TONE[x.action]}`}>{ACTION_LABEL[x.action]}</span></td>
                    <td className="small">{[...x.errors, ...x.warnings].join('; ')}</td></tr>
                ))}</tbody></table>
            )}
            {tab === 'rates' && (
              <table className="t"><thead><tr><th>Row</th><th>Department</th><th>Vehicle</th><th>Package</th><th>Type</th><th className="num">Base ₹</th><th>Tax</th><th>Result</th><th>Notes</th></tr></thead>
                <tbody>{p.rates.map((x: any) => (
                  <tr key={x.rowNumber}><td>{x.rowNumber}</td><td>{x.clientName || x.department}</td><td>{x.vehicle}</td><td>{x.package}</td><td>{x.incoming.rateType === 'fixed' ? 'Fixed' : 'Per km/hr'}</td><td className="num">{money(x.incoming.baseFare)}</td>
                    <td className="small">{x.tax}</td><td><span className={`badge ${ACTION_TONE[x.action]}`}>{ACTION_LABEL[x.action]}</span></td><td className="small">{[...x.errors, ...x.warnings].join('; ')}</td></tr>
                ))}</tbody></table>
            )}
            {tab === 'errors' && (
              errs.length === 0 ? <div className="empty">No errors.</div> : (
                <table className="t"><thead><tr><th>Row</th><th>Record</th><th>Errors</th></tr></thead>
                  <tbody>{errs.map((x: any) => <tr key={`${x.name ?? x.vehicle}${x.rowNumber}`}><td>{x.rowNumber}</td><td>{x.name ?? `${x.department} — ${x.vehicle} — ${x.package}`}</td><td className="small">{x.errors.join('; ')}</td></tr>)}</tbody></table>
              )
            )}
          </div>
          <div className="row end" style={{ marginTop: 10, gap: 10, flexWrap: 'wrap' }}>
            {errs.length > 0 && <><button className="btn" onClick={errorReport}>Download error report</button>
              <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={skipInvalid} onChange={(e) => setSkipInvalid(e.target.checked)} /> Import only the valid rows</label></>}
            <button className="btn" onClick={() => setP(null)}>Choose another file</button>
            <button className="btn primary" disabled={busy || nothing || (errs.length > 0 && !skipInvalid)} onClick={() => setConfirm(true)}>Confirm import</button>
          </div>
        </>
      )}
      {done && (
        <div className="panel">
          <h3>Import complete</h3>
          <p>{done.departmentsAdded} departments added, {done.departmentsUpdated} updated · {done.ratesAdded} rates added, {done.ratesUpdated} changed{done.contractsCreated ? ` · ${done.contractsCreated} rate-card contracts created` : ''}. Everything else was left as it was.</p>
          {done.taxUpdated?.length > 0 && <div className="small">{done.taxUpdated.map((t: string) => <div key={t}>{t}</div>)}</div>}
          {!opts.approve && <p className="small muted">The new rates are waiting for approval under Rate Schemes.</p>}
          <div className="row end"><button className="btn primary" onClick={onClose}>Close</button></div>
        </div>
      )}
      {confirm && <Confirm text={`Save ${changes.length} change(s)${s.taxChanges ? ` and ${s.taxChanges} tax change(s)` : ''}? Unchanged departments and rates are not touched.`} yesLabel="Import" onYes={commit} onClose={() => setConfirm(false)} />}
    </Modal>
  );
}
