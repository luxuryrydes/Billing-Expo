import { useState } from 'react';
import { api } from '../api';
import { Field, Modal, useAction } from './ui';
import { useContracts, useDutyTypes } from '../lookups';

const FIELD_LABELS: Record<string, string> = {
  dutyDate: 'Duty date', vendorName: 'Vendor', vehicleCategory: 'Vehicle type / model', vehicleRegNo: 'Vehicle no.', driverName: 'Driver', department: 'Department (for routing)', fieldOfficer: 'User / officer',
  startKm: 'Starting km', endKm: 'Closing km', startTime: 'Starting time', endTime: 'Closing time', endDate: 'Closing date', dutyType: 'Duty type', toll: 'Toll', parking: 'Parking', remarks: 'Remarks',
};

/**
 * Duty sheet import (Excel, CSV or PDF). A sheet for one contract goes to that contract; a shared
 * sheet with a Department column is split: each department value is routed to a contract or skipped.
 */
export function DutyImportWizard({ contractId, onClose, onDone }: { contractId?: string; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [prev, setPrev] = useState<any>(null);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [overnight, setOvernight] = useState<'next_day' | 'flag'>('next_day');
  const [dutyType, setDutyType] = useState('LOCAL');
  const [dry, setDry] = useState<any>(null);
  const [mode, setMode] = useState<'single' | 'route'>(contractId ? 'single' : 'route');
  const [target, setTarget] = useState(contractId ?? '');
  const [routing, setRouting] = useState<Record<string, string>>({});
  const { run, busy } = useAction();
  const types = useDutyTypes();
  const contracts = useContracts();
  const upload = async () => {
    const fd = new FormData();
    fd.append('file', file!);
    const r = await run(() => api.post('/duties/import/preview', fd));
    if (r) {
      setPrev(r); setMapping(r.mapping); setDry(null);
      setRouting(Object.fromEntries((r.departments ?? []).map((d: any) => [d.value, d.contractId ?? ''])));
      setMode((r.departments ?? []).length > 1 || !contractId ? 'route' : 'single');
    }
  };
  const routed = mode === 'route' && mapping.department !== undefined;
  const body = (dryRun: boolean) => ({ fileId: prev.fileId, ...(routed ? { departmentRouting: routing } : { contractId: target }), mapping, overnightRule: overnight, defaultDutyType: dutyType, dryRun });
  const ready = routed ? Object.values(routing).some(Boolean) : !!target;
  const label = (id: string) => { const k = contracts.data?.find((x) => x.id === id); return k ? `${k.client_name} — ${k.reference_no}` : id; };
  return (
    <Modal title="Import duty sheet" onClose={onClose} wide>
      {!prev ? (
        <div className="grid">
          <Field label="Duty sheet (Excel, CSV or PDF)" required><input type="file" accept=".xlsx,.xls,.csv,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
          <p className="small muted">The heading row is found automatically. A shared sheet covering several departments is split by its Department column. Vehicle numbers keep leading zeros. Nothing is saved until you confirm.</p>
          <div className="row end"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!file || busy} onClick={upload}>{busy ? 'Reading…' : 'Read sheet'}</button></div>
        </div>
      ) : (
        <div className="grid">
          <div className="small muted">{prev.fileName} · {prev.sheetName} · heading row {prev.headerRow} · {prev.rowCount} rows</div>
          <div className="grid g4">
            {Object.keys(FIELD_LABELS).map((f) => (
              <Field key={f} label={FIELD_LABELS[f]}>
                <select value={mapping[f] ?? ''} onChange={(e) => { const n = { ...mapping }; if (e.target.value === '') delete n[f]; else n[f] = Number(e.target.value); setMapping(n); setDry(null); }}>
                  <option value="">(not in sheet)</option>{prev.headers.map((h: string, i: number) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                </select>
              </Field>
            ))}
          </div>
          <div className="panel" style={{ marginBottom: 0 }}>
            <div className="row">
              <label className="check"><input type="radio" checked={mode === 'single'} onChange={() => { setMode('single'); setDry(null); }} />All rows belong to one contract</label>
              <label className="check"><input type="radio" checked={mode === 'route'} disabled={mapping.department === undefined} onChange={() => { setMode('route'); setDry(null); }} />Split by the Department column</label>
            </div>
            {mode === 'single' ? (
              <Field label="Contract"><select value={target} onChange={(e) => { setTarget(e.target.value); setDry(null); }}><option value="">Select…</option>{contracts.data?.map((k) => <option key={k.id} value={k.id}>{k.client_name} — {k.reference_no}</option>)}</select></Field>
            ) : (
              <div className="scroll" style={{ maxHeight: 240, marginTop: 8 }}>
                <table className="t"><thead><tr><th>Department in sheet</th><th className="num">Rows</th><th>Import into contract</th></tr></thead>
                  <tbody>{(prev.departments ?? []).map((d: any) => (
                    <tr key={d.value}><td>{d.value || '(blank)'}</td><td className="num">{d.rows}</td>
                      <td><select value={routing[d.value] ?? ''} onChange={(e) => { setRouting({ ...routing, [d.value]: e.target.value }); setDry(null); }}>
                        <option value="">Skip these rows</option>{contracts.data?.map((k) => <option key={k.id} value={k.id}>{k.client_name} — {k.reference_no}</option>)}</select>
                        {d.contractId && routing[d.value] === d.contractId && <span className="small muted"> matched by department code</span>}</td></tr>
                  ))}</tbody></table>
              </div>
            )}
          </div>
          <div className="grid g2">
            <Field label="Closing time earlier than starting time (no closing date column)"><select value={overnight} onChange={(e) => setOvernight(e.target.value as never)}><option value="next_day">Treat as next day and flag a warning to confirm</option><option value="flag">Keep as entered (will be an error)</option></select></Field>
            <Field label="Duty type when not in sheet"><select value={dutyType} onChange={(e) => setDutyType(e.target.value)}>{types.data?.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></Field>
          </div>
          <details><summary className="small"><b>Sample of the sheet</b></summary>
            <div className="scroll" style={{ maxHeight: 220 }}>
              <table className="t"><thead><tr>{prev.headers.map((h: string, i: number) => <th key={i}>{h}</th>)}</tr></thead>
                <tbody>{prev.sample.map((r: any) => <tr key={r.rowNumber}>{r.cells.map((c: string, i: number) => <td key={i} className="small">{c}</td>)}</tr>)}</tbody></table>
            </div></details>
          {dry && (
            <div className="panel">
              <b>Check result:</b> {dry.total} rows to import · {dry.withErrors} with errors · {dry.withWarnings} with warnings · {dry.notImported} cannot be imported
              {Object.keys(dry.byContract ?? {}).length > 0 && <div className="small">{Object.entries(dry.byContract).map(([k, n]) => `${label(k)}: ${n}`).join(' · ')}</div>}
              {Object.keys(dry.skippedByDepartment ?? {}).length > 0 && <div className="small muted">Skipped: {Object.entries(dry.skippedByDepartment).map(([k, n]) => `${k} ${n}`).join(', ')}</div>}
              <div className="scroll" style={{ maxHeight: 220 }}><table className="t"><tbody>
                {dry.results.filter((r: any) => r.parseError || r.issues.length).map((r: any) => <tr key={r.rowNumber}><td>Row {r.rowNumber}</td><td className="small">{r.parseError && <span style={{ color: 'var(--err)' }}>{r.parseError}</span>}{r.issues.map((x: any, i: number) => <div key={i} style={{ color: x.severity === 'error' ? 'var(--err)' : 'var(--warn)' }}>{x.message}</div>)}</td></tr>)}
              </tbody></table></div>
            </div>
          )}
          <div className="row end">
            <button className="btn" onClick={() => setPrev(null)}>Back</button>
            <button className="btn" disabled={busy || !ready} onClick={async () => { const r = await run(() => api.post('/duties/import/commit', body(true))); if (r) setDry(r); }}>Check rows</button>
            <button className="btn primary" disabled={busy || !dry} onClick={async () => { const r = await run(() => api.post('/duties/import/commit', body(false))); if (r) { alert(`Imported ${r.imported} duty row(s). ${r.withErrors} have errors and ${r.withWarnings} have warnings — review them in the Duty Register.`); onDone(); } }}>Import {dry ? dry.total - dry.notImported : ''} rows</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
