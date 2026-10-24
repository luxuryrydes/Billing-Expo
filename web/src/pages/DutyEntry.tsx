import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, errorText, qs } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Field, Modal, PageHead, useAction, useToast } from '../components/ui';
import { today } from '../format';
import { useCategories, useContracts, useDutyTypes, type Contract } from '../lookups';

interface Row {
  key: string;
  id?: string;
  dutyDate: string;
  vendorName: string;
  vehicleCategoryId: string;
  vehicleRegNo: string;
  driverName: string;
  fieldOfficer: string;
  dutyTypeCode: string;
  startKm: string;
  endKm: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  toll: string;
  parking: string;
  otherCharges: string;
  remarks: string;
  supportingDocRef: string;
  customFields: Record<string, string>;
  issues?: { code: string; severity: string; message: string; field?: string }[];
  dirty?: boolean;
  status?: string;
}

const COLS: { k: keyof Row; label: string; w: number; type?: string }[] = [
  { k: 'dutyDate', label: 'Duty date', w: 128, type: 'date' },
  { k: 'vendorName', label: 'Vendor', w: 100 },
  { k: 'vehicleCategoryId', label: 'Vehicle type', w: 110, type: 'cat' },
  { k: 'vehicleRegNo', label: 'Vehicle no.', w: 110 },
  { k: 'driverName', label: 'Driver', w: 120 },
  { k: 'fieldOfficer', label: 'User / officer', w: 120 },
  { k: 'dutyTypeCode', label: 'Duty type', w: 100, type: 'dtype' },
  { k: 'startKm', label: 'Start km', w: 80 },
  { k: 'endKm', label: 'Closing km', w: 80 },
  { k: 'startDate', label: 'Start date', w: 128, type: 'date' },
  { k: 'startTime', label: 'Start time', w: 84, type: 'time' },
  { k: 'endDate', label: 'Closing date', w: 128, type: 'date' },
  { k: 'endTime', label: 'Closing time', w: 84, type: 'time' },
  { k: 'toll', label: 'Toll', w: 70 },
  { k: 'parking', label: 'Parking', w: 70 },
  { k: 'otherCharges', label: 'Other', w: 70 },
  { k: 'remarks', label: 'Remarks', w: 140 },
  { k: 'supportingDocRef', label: 'Slip / doc ref.', w: 110 },
];

let seq = 0;
const blank = (date: string): Row => ({
  key: `n${++seq}`, dutyDate: date, vendorName: '', vehicleCategoryId: '', vehicleRegNo: '', driverName: '', fieldOfficer: '', dutyTypeCode: 'LOCAL',
  startKm: '', endKm: '', startDate: date, startTime: '', endDate: date, endTime: '', toll: '', parking: '', otherCharges: '', remarks: '', supportingDocRef: '', customFields: {}, dirty: false,
});

function fromApi(r: any): Row {
  return {
    key: r.id, id: r.id, dutyDate: r.dutyDate, vendorName: r.vendorName ?? '', vehicleCategoryId: r.vehicleCategoryId ?? '', vehicleRegNo: r.vehicleRegNo, driverName: r.driverName ?? '',
    fieldOfficer: r.fieldOfficer ?? '', dutyTypeCode: r.dutyTypeCode ?? '', startKm: r.startKm ?? '', endKm: r.endKm ?? '', startDate: r.startAt?.slice(0, 10) ?? r.dutyDate,
    startTime: r.startAt?.slice(11, 16) ?? '', endDate: r.endAt?.slice(0, 10) ?? r.dutyDate, endTime: r.endAt?.slice(11, 16) ?? '', toll: r.toll ?? '', parking: r.parking ?? '',
    otherCharges: r.otherCharges ?? '', remarks: r.remarks ?? '', supportingDocRef: r.supportingDocRef ?? '', customFields: r.customFields ?? {}, issues: r.issues, status: r.status,
  };
}

function toApi(r: Row, contractId: string) {
  return {
    id: r.id, contractId, dutyDate: r.dutyDate, vendorName: r.vendorName, vehicleCategoryId: r.vehicleCategoryId || null, vehicleRegNo: r.vehicleRegNo, driverName: r.driverName,
    fieldOfficer: r.fieldOfficer, dutyTypeCode: r.dutyTypeCode || null, startKm: r.startKm, endKm: r.endKm,
    startAt: r.startDate && r.startTime ? `${r.startDate} ${r.startTime}` : null, endAt: r.endDate && r.endTime ? `${r.endDate} ${r.endTime}` : null,
    toll: r.toll, parking: r.parking, otherCharges: r.otherCharges, remarks: r.remarks, supportingDocRef: r.supportingDocRef, customFields: r.customFields,
  };
}

/** Normalises pasted times like "9.30", "930", "9:30 PM". */
function normTime(s: string): string {
  const t = s.trim().toLowerCase();
  let m = /^(\d{1,2})[:.](\d{2})\s*([ap])?\.?m?\.?$/.exec(t);
  if (m) { let h = Number(m[1]); if (m[3] === 'p' && h < 12) h += 12; if (m[3] === 'a' && h === 12) h = 0; return `${String(h).padStart(2, '0')}:${m[2]}`; }
  m = /^(\d{2})(\d{2})$/.exec(t);
  if (m) return `${m[1]}:${m[2]}`;
  return s.trim();
}
function normDate(s: string): string {
  const t = s.trim();
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(t);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return t;
}

export function DutyEntryPage() {
  const { can } = useAuth();
  const contracts = useContracts();
  const cats = useCategories();
  const types = useDutyTypes();
  const toast = useToast();
  const qc = useQueryClient();
  const [contractId, setContractId] = useState('');
  const [date, setDate] = useState(today());
  const [rows, setRows] = useState<Row[]>([]);
  const [loaded, setLoaded] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [importing, setImporting] = useState(false);
  const tableRef = useRef<HTMLTableElement>(null);
  const contract: Contract | undefined = contracts.data?.find((k) => k.id === contractId);
  const custom = contract?.custom_fields ?? [];
  const catByName = useMemo(() => new Map((cats.data ?? []).map((c) => [c.name.toLowerCase(), c.id])), [cats.data]);

  const load = async (cid = contractId, dd = date) => {
    if (!cid) return;
    setError(null);
    try {
      const r = await api.get(`/duties${qs({ contractId: cid, from: dd, to: dd, pageSize: 1000 })}`);
      const existing = r.rows.map(fromApi);
      setRows([...existing, blank(dd)]);
      setLoaded(`${cid}|${dd}`);
    } catch (e) { setError(e); }
  };

  const update = (i: number, k: keyof Row, v: string) => {
    setRows((rs) => {
      const n = [...rs];
      const r = { ...n[i], [k]: v, dirty: true };
      if (k === 'dutyDate') { if (!n[i].startDate || n[i].startDate === n[i].dutyDate) r.startDate = v; if (!n[i].endDate || n[i].endDate === n[i].dutyDate) r.endDate = v; }
      // Overnight helper: a closing time earlier than the start on the same date most often means the next day — we suggest it visibly, never silently.
      n[i] = r;
      if (i === n.length - 1) n.push(blank(date));
      return n;
    });
  };
  const setCustom = (i: number, key: string, v: string) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, customFields: { ...r.customFields, [key]: v }, dirty: true } : r)));

  const copyPrev = (i: number) => {
    if (i === 0) return;
    const p = rows[i - 1];
    setRows((rs) => {
      const n = [...rs];
      n[i] = { ...p, key: `n${++seq}`, id: undefined, issues: undefined, status: undefined, startKm: p.endKm, endKm: '', startTime: '', endTime: '', toll: '', parking: '', otherCharges: '', remarks: '', supportingDocRef: '', dirty: true };
      if (i === n.length - 1) n.push(blank(date));
      return n;
    });
  };

  /** Paste a block copied from Excel, starting at the focused cell. */
  const onPaste = (e: React.ClipboardEvent, i: number, colIndex: number) => {
    const text = e.clipboardData.getData('text/plain');
    if (!text.includes('\t') && !text.includes('\n')) return;
    e.preventDefault();
    const lines = text.replace(/\r/g, '').split('\n').filter((l, idx, arr) => l.length > 0 || idx < arr.length - 1);
    setRows((rs) => {
      const n = [...rs];
      lines.forEach((line, li) => {
        const cells = line.split('\t');
        const ri = i + li;
        while (n.length <= ri) n.push(blank(date));
        const r = { ...n[ri], dirty: true };
        cells.forEach((cell, ci) => {
          const col = COLS[colIndex + ci];
          if (!col) return;
          let v = cell.trim();
          if (col.type === 'date') v = normDate(v);
          if (col.type === 'time') v = normTime(v);
          if (col.type === 'cat') v = catByName.get(v.toLowerCase()) ?? v;
          (r as any)[col.k] = v;
        });
        if (colIndex === 0) { r.startDate ||= r.dutyDate; r.endDate ||= r.dutyDate; }
        n[ri] = r;
      });
      if (n[n.length - 1].dirty) n.push(blank(date));
      return n;
    });
  };

  const onKey = (e: React.KeyboardEvent, i: number, c: number) => {
    const move = (di: number, dc: number) => {
      const el = tableRef.current?.querySelector<HTMLElement>(`[data-cell="${i + di}-${c + dc}"]`);
      if (el) { e.preventDefault(); el.focus(); }
    };
    if (e.key === 'Enter' || (e.key === 'ArrowDown' && (e.target as HTMLElement).tagName !== 'SELECT')) move(1, 0);
    else if (e.key === 'ArrowUp' && (e.target as HTMLElement).tagName !== 'SELECT') move(-1, 0);
    else if (e.key === 'd' && e.ctrlKey) { e.preventDefault(); copyPrev(i); }
  };

  const save = async () => {
    const dirty = rows.filter((r) => r.dirty && (r.vehicleRegNo || r.startKm || r.endKm));
    if (!dirty.length) { toast('Nothing to save'); return; }
    // Same-date closing earlier than start: ask instead of guessing.
    const suspicious = dirty.filter((r) => r.startDate === r.endDate && r.startTime && r.endTime && r.endTime < r.startTime);
    if (suspicious.length && !confirm(`${suspicious.length} row(s) close earlier than they start on the same date. Set those closing dates to the next day?\n\nOK = next day · Cancel = save as entered (they will be flagged as errors).`)) {
      /* save as entered */
    } else if (suspicious.length) {
      for (const r of suspicious) { const t = new Date(`${r.startDate}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); r.endDate = t.toISOString().slice(0, 10); }
    }
    let reason: string | null = null;
    if (dirty.some((r) => r.status === 'verified' || r.status === 'billed')) {
      reason = prompt('Some rows were already verified. Enter the correction reason (recorded in the audit log):');
      if (!reason) return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await api.post('/duties/bulk', { rows: dirty.map((r) => ({ ...toApi(r, contractId), correctionReason: reason })) });
      const saved = new Map<string, Row>();
      dirty.forEach((r, idx) => saved.set(r.key, fromApi(res.rows[idx])));
      setRows((rs) => {
        const n = rs.map((r) => saved.get(r.key) ?? r);
        if (n[n.length - 1].dirty || n[n.length - 1].id) n.push(blank(date));
        return n;
      });
      const errs = res.rows.filter((r: any) => r.errorCount > 0).length;
      const warns = res.rows.filter((r: any) => r.warningCount > 0).length;
      toast(`Saved ${res.rows.length} duty row(s)${errs ? ` — ${errs} with errors` : ''}${warns ? `, ${warns} with warnings` : ''}`, errs > 0);
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (e) {
      setError(e);
      toast(errorText(e), true);
    } finally {
      setSaving(false);
    }
  };

  const dirtyCount = rows.filter((r) => r.dirty).length;
  const issueText = (r: Row) => (r.issues ?? []).map((x) => `${x.severity === 'error' ? '✖' : '⚠'} ${x.message}`).join('\n');
  const badField = (r: Row, k: string) => (r.issues ?? []).some((x) => x.severity === 'error' && (x.field === k || (k === 'endTime' && x.field === 'endAt') || (k === 'startTime' && x.field === 'startAt')));

  return (
    <>
      <PageHead title="Daily Duty Entry" sub="Type or paste rows from Excel (Ctrl+V on any cell). Enter moves down, Ctrl+D copies the previous row. Vehicle numbers are stored exactly as typed.">
        <select value={contractId} onChange={(e) => { setContractId(e.target.value); load(e.target.value, date); }}><option value="">Select contract…</option>{contracts.data?.filter((k) => k.status !== 'terminated').map((k) => <option key={k.id} value={k.id}>{k.client_name} — {k.reference_no}</option>)}</select>
        <input type="date" value={date} onChange={(e) => { setDate(e.target.value); load(contractId, e.target.value); }} />
        {can('duty.write') && <button className="btn" disabled={!contractId} onClick={() => setImporting(true)}>Import Excel / CSV</button>}
        {can('duty.write') && <button className="btn primary" disabled={!contractId || saving || dirtyCount === 0} onClick={save}>Save {dirtyCount ? `(${dirtyCount})` : ''}</button>}
      </PageHead>
      <ErrorBox error={error} />
      {!contractId ? <div className="panel empty">Select a contract to enter duties.</div> : loaded !== `${contractId}|${date}` ? <div className="panel empty">Loading…</div> : (
        <>
          <div className="grid-wrap">
            <table className="sheet" ref={tableRef}>
              <thead><tr><th>#</th>{COLS.map((c) => <th key={c.k} style={{ minWidth: c.w }}>{c.label}</th>)}{custom.map((f) => <th key={f.key}>{f.label}{f.required ? ' *' : ''}</th>)}<th>Status</th><th /></tr></thead>
              <tbody>
                {rows.map((r, i) => {
                  const errs = (r.issues ?? []).some((x) => x.severity === 'error');
                  const warns = (r.issues ?? []).some((x) => x.severity === 'warning');
                  return (
                    <tr key={r.key} className={`${errs ? 'err' : warns ? 'warn' : ''} ${r.dirty ? 'dirty' : ''}`} title={issueText(r)}>
                      <td className="ro">{i + 1}</td>
                      {COLS.map((c, ci) => (
                        <td key={c.k} className={badField(r, c.k) ? 'bad' : ''}>
                          {c.type === 'cat' ? (
                            <select data-cell={`${i}-${ci}`} value={r.vehicleCategoryId} onChange={(e) => update(i, 'vehicleCategoryId', e.target.value)} onKeyDown={(e) => onKey(e, i, ci)} onPaste={(e) => onPaste(e, i, ci)}>
                              <option value="">—</option>{cats.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                            </select>
                          ) : c.type === 'dtype' ? (
                            <select data-cell={`${i}-${ci}`} value={r.dutyTypeCode} onChange={(e) => update(i, 'dutyTypeCode', e.target.value)} onKeyDown={(e) => onKey(e, i, ci)}>
                              <option value="">—</option>{types.data?.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
                            </select>
                          ) : (
                            <input data-cell={`${i}-${ci}`} type={c.type === 'date' ? 'date' : c.type === 'time' ? 'time' : 'text'} value={(r as any)[c.k] ?? ''} inputMode={['startKm', 'endKm', 'toll', 'parking', 'otherCharges'].includes(c.k) ? 'decimal' : undefined}
                              onChange={(e) => update(i, c.k, e.target.value)} onKeyDown={(e) => onKey(e, i, ci)} onPaste={(e) => onPaste(e, i, ci)} />
                          )}
                        </td>
                      ))}
                      {custom.map((f) => <td key={f.key}><input value={r.customFields?.[f.key] ?? ''} onChange={(e) => setCustom(i, f.key, e.target.value)} /></td>)}
                      <td className="ro small">{r.dirty ? 'unsaved' : r.status ?? ''}{errs ? ' ✖' : warns ? ' ⚠' : ''}</td>
                      <td className="ro"><button className="btn sm link" title="Copy previous row (Ctrl+D)" onClick={() => copyPrev(i)}>⧉</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.some((r) => r.issues?.length) && (
            <div className="panel" style={{ marginTop: 12 }}>
              <h3>Validation results</h3>
              <ul className="small">{rows.flatMap((r, i) => (r.issues ?? []).map((x, j) => <li key={`${i}-${j}`} style={{ color: x.severity === 'error' ? 'var(--err)' : 'var(--warn)' }}>Row {i + 1} ({r.vehicleRegNo}): {x.message}</li>))}</ul>
              <p className="small muted">Warnings do not block saving. Errors must be corrected before the duty can be verified or billed. Readings are never changed automatically.</p>
            </div>
          )}
          <p className="small muted">Saved duties for other dates are in the <Link to="/duties">Duty Register</Link>.</p>
        </>
      )}
      {importing && <ImportWizard contractId={contractId} onClose={() => setImporting(false)} onDone={() => { setImporting(false); load(); }} />}
    </>
  );
}

const FIELD_LABELS: Record<string, string> = {
  dutyDate: 'Duty date', vendorName: 'Vendor', vehicleCategory: 'Vehicle type', vehicleRegNo: 'Vehicle no.', driverName: 'Driver', department: 'Department (ignored)', fieldOfficer: 'User / officer',
  startKm: 'Starting km', endKm: 'Closing km', startTime: 'Starting time', endTime: 'Closing time', endDate: 'Closing date', dutyType: 'Duty type', toll: 'Toll', parking: 'Parking', remarks: 'Remarks',
};

function ImportWizard({ contractId, onClose, onDone }: { contractId: string; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [prev, setPrev] = useState<any>(null);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [overnight, setOvernight] = useState<'next_day' | 'flag'>('next_day');
  const [dutyType, setDutyType] = useState('LOCAL');
  const [dry, setDry] = useState<any>(null);
  const { run, busy } = useAction();
  const types = useDutyTypes();
  const upload = async () => {
    const fd = new FormData();
    fd.append('file', file!);
    const r = await run(() => api.post('/duties/import/preview', fd));
    if (r) { setPrev(r); setMapping(r.mapping); setDry(null); }
  };
  const body = (dryRun: boolean) => ({ fileId: prev.fileId, contractId, mapping, overnightRule: overnight, defaultDutyType: dutyType, dryRun });
  return (
    <Modal title="Import duty sheet" onClose={onClose} wide>
      {!prev ? (
        <div className="grid">
          <Field label="Excel (.xlsx) or CSV duty sheet" required><input type="file" accept=".xlsx,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
          <p className="small muted">The header row is detected automatically. Vehicle numbers are read as displayed in the sheet (leading zeros kept). Nothing is saved until you confirm.</p>
          <div className="row end"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!file || busy} onClick={upload}>Read sheet</button></div>
        </div>
      ) : (
        <div className="grid">
          <div className="small muted">Sheet “{prev.sheetName}”, header row {prev.headerRow}, {prev.rowCount} data rows.</div>
          <div className="grid g4">
            {Object.keys(FIELD_LABELS).map((f) => (
              <Field key={f} label={FIELD_LABELS[f]}>
                <select value={mapping[f] ?? ''} onChange={(e) => { const n = { ...mapping }; if (e.target.value === '') delete n[f]; else n[f] = Number(e.target.value); setMapping(n); setDry(null); }}>
                  <option value="">(not in sheet)</option>{prev.headers.map((h: string, i: number) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                </select>
              </Field>
            ))}
          </div>
          <div className="grid g2">
            <Field label="Closing time earlier than starting time (no closing date column)"><select value={overnight} onChange={(e) => setOvernight(e.target.value as never)}><option value="next_day">Treat as next day and flag a warning to confirm</option><option value="flag">Keep as entered (will be an error)</option></select></Field>
            <Field label="Duty type when not in sheet"><select value={dutyType} onChange={(e) => setDutyType(e.target.value)}>{types.data?.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></Field>
          </div>
          <div className="scroll" style={{ maxHeight: 220 }}>
            <table className="t"><thead><tr>{prev.headers.map((h: string, i: number) => <th key={i}>{h}</th>)}</tr></thead>
              <tbody>{prev.sample.map((r: any) => <tr key={r.rowNumber}>{r.cells.map((c: string, i: number) => <td key={i} className="small">{c}</td>)}</tr>)}</tbody></table>
          </div>
          {dry && (
            <div className="panel">
              <b>Check result:</b> {dry.total} rows · {dry.withErrors} with errors · {dry.withWarnings} with warnings · {dry.notImported} cannot be imported
              <div className="scroll" style={{ maxHeight: 220 }}><table className="t"><tbody>
                {dry.results.filter((r: any) => r.parseError || r.issues.length).map((r: any) => <tr key={r.rowNumber}><td>Row {r.rowNumber}</td><td className="small">{r.parseError && <span style={{ color: 'var(--err)' }}>{r.parseError}</span>}{r.issues.map((x: any, i: number) => <div key={i} style={{ color: x.severity === 'error' ? 'var(--err)' : 'var(--warn)' }}>{x.message}</div>)}</td></tr>)}
              </tbody></table></div>
            </div>
          )}
          <div className="row end">
            <button className="btn" onClick={() => setPrev(null)}>Back</button>
            <button className="btn" disabled={busy} onClick={async () => { const r = await run(() => api.post('/duties/import/commit', body(true))); if (r) setDry(r); }}>Check rows</button>
            <button className="btn primary" disabled={busy || !dry} onClick={async () => { const r = await run(() => api.post('/duties/import/commit', body(false))); if (r) { alert(`Imported ${r.imported} duty row(s). ${r.withErrors} have errors and ${r.withWarnings} have warnings — review them in the Duty Register.`); onDone(); } }}>Import {dry ? dry.total - dry.notImported : ''} rows</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
