import { useState } from 'react';
import { api, downloadBlob } from '../api';
import { ErrorBox, Field, Modal } from './ui';

type Entity = 'departments' | 'institutions' | 'rate_card';
const TITLES: Record<Entity, string> = { departments: 'Import departments', institutions: 'Import institutions', rate_card: 'Import rate card' };
const ACCEPT: Record<Entity, string> = { departments: '.xlsx,.xls,.csv', institutions: '.xlsx,.xls,.csv', rate_card: '.xlsx,.xls,.csv,.pdf' };
const ACTION_LABEL: Record<string, string> = { add: 'New', update: 'Update', unchanged: 'No change', error: 'Error' };
const ACTION_TONE: Record<string, string> = { add: 'ok', update: 'brand', unchanged: '', error: 'err' };

const show = (v: unknown) => (v == null || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : /^\d+\.\d+$/.test(String(v)) ? String(Number(v)) : String(v));

function csv(rows: (string | number)[][]) {
  return '﻿' + rows.map((r) => r.map((c) => { const s = String(c ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\r\n');
}

/**
 * Upload → preview (sheet, mapping, summary, sample, row results) → confirm.
 * Nothing is saved until "Confirm import"; the commit is all-or-nothing unless the
 * user chooses to import only the valid rows.
 */
export function ImportDialog({ entity, contractId, contextLabel, onClose, onDone }: { entity: Entity; contractId?: string; contextLabel?: string; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [p, setP] = useState<any>(null);
  const [fileId, setFileId] = useState('');
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [extras, setExtras] = useState<number[]>([]);
  const [sheet, setSheet] = useState('');
  const [opts, setOpts] = useState({ effectiveFrom: new Date().toISOString().slice(0, 10), hourRoundingMode: 'ceil', hourRoundingUnit: '30', nightStart: '22:00', nightEnd: '06:00' });
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [submit, setSubmit] = useState(false);
  const [filter, setFilter] = useState<'all' | 'changes' | 'error'>('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<any>(null);

  const take = (r: any) => { setP(r); setMapping(r.mapping ?? {}); setExtras(r.extras ?? []); setSheet(r.sheet ?? ''); };
  const body = (over: Record<string, unknown> = {}) => ({ fileId, sheet, mapping, extras, contractId, options: opts, skipInvalid, submitForApproval: submit, ...over });

  const upload = async (f: File) => {
    setFile(f); setBusy(true); setError(null); setDone(null);
    try {
      const fd = new FormData();
      if (contractId) fd.append('contract_id', contractId);
      fd.append('file', f);
      const r = await api.post(`/imports/${entity}/upload`, fd);
      setFileId(r.fileId);
      take(r);
      if (r.problem) setError(new Error(r.problem));
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const recheck = async (over: Record<string, unknown> = {}) => {
    setBusy(true); setError(null);
    try { take(await api.post(`/imports/${entity}/analyze`, body(over))); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const commit = async () => {
    setBusy(true); setError(null);
    try { setDone(await api.post(`/imports/${entity}/commit`, body())); onDone(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const errorReport = () => {
    const rows = (p?.results ?? []).filter((r: any) => r.errors.length || r.warnings.length);
    const blob = new Blob([csv([['Row', 'Record', 'Result', 'Errors', 'Warnings'], ...rows.map((r: any) => [r.rowNumber, r.key ?? `${r.category} / ${r.dutyTypeName}`, ACTION_LABEL[r.action], r.errors.join('; '), r.warnings.join('; ')])])], { type: 'text/csv' });
    downloadBlob(blob, `${entity}-import-errors.csv`);
  };

  const s = p?.summary;
  const results: any[] = (p?.results ?? []).filter((r: any) => filter === 'all' || (filter === 'error' ? r.action === 'error' : r.action === 'add' || r.action === 'update'));
  const usedCols = new Set(Object.values(mapping));

  return (
    <Modal title={TITLES[entity]} onClose={onClose} wide>
      {contextLabel && <div className="small muted" style={{ marginBottom: 8 }}>For: <b>{contextLabel}</b></div>}
      <ErrorBox error={error} />
      {done ? (
        <div className="grid">
          <div className="alert ok">
            Import complete: <b>{done.added}</b> added, <b>{done.updated}</b> updated, {done.unchanged} unchanged{done.skipped ? <>, <b>{done.skipped}</b> invalid row(s) skipped</> : ''}.
            {entity === 'rate_card' && done.created?.length > 0 && <div style={{ marginTop: 4 }}>New rate versions were created as {submit ? 'submitted for approval' : 'drafts'}; they apply to bills only after approval. Bills already calculated keep their earlier rates.</div>}
          </div>
          <div className="row end">
            {done.skipped > 0 && <a className="btn" href={`/api/imports/runs/${done.runId}/report.csv`}>Download error report</a>}
            <button className="btn primary" onClick={onClose}>Close</button>
          </div>
        </div>
      ) : !p ? (
        <div className="grid">
          <label className={`dropzone ${drag ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) upload(f); }}>
            <input type="file" accept={ACCEPT[entity]} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
            {busy ? 'Reading the file…' : <>Drop the {entity === 'rate_card' ? 'rate card (Excel, CSV or PDF rate schedule)' : 'Excel or CSV file'} here, or <u>choose a file</u></>}
            {file && !busy && <div className="small muted">{file.name}</div>}
          </label>
          <div className="row"><a className="btn sm" href={`/api/imports/${entity}/template.xlsx`}>Download template</a>
            {entity !== 'rate_card' && <a className="btn sm" href={`/api/imports/${entity}/export.xlsx`}>Download current records</a>}
            <span className="small muted">Matching records are updated, new ones added; nothing is deleted because it is missing from the file. Blank cells do not clear existing values.</span></div>
        </div>
      ) : (
        <div className="grid">
          <div className="row small">
            <span>File <b>{p.fileName}</b></span>
            {p.sheets?.length > 1 ? <>· Worksheet <select value={sheet} onChange={(e) => { setSheet(e.target.value); recheck({ sheet: e.target.value, mapping: undefined, extras: undefined }); }}>{p.sheets.map((x: string) => <option key={x}>{x}</option>)}</select></> : <span>· Worksheet <b>{p.sheet}</b></span>}
            {p.headerRow > 0 && <span>· headings on row {p.headerRow}</span>}
            <span className="spacer" /><button className="btn sm" onClick={() => { setP(null); setFile(null); }}>Choose another file</button>
          </div>

          {p.headers?.length > 0 && (
            <details open={!s || s.errors > 0}>
              <summary><b>Column mapping</b> <span className="small muted">({Object.keys(mapping).length} of {p.fields.length} fields mapped)</span></summary>
              <div className="grid g3" style={{ marginTop: 8 }}>
                {p.fields.map((f: any) => (
                  <Field key={f.key} label={f.label} required={f.required}>
                    <select value={mapping[f.key] ?? ''} onChange={(e) => { const m = { ...mapping }; if (e.target.value === '') delete m[f.key]; else m[f.key] = Number(e.target.value); setMapping(m); }}>
                      <option value="">— not in file —</option>{p.headers.map((h: string, i: number) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                    </select>
                  </Field>
                ))}
              </div>
              {entity !== 'rate_card' && p.headers.some((_: string, i: number) => !usedCols.has(i) && p.headers[i]) && (
                <div style={{ marginTop: 8 }} className="small">Other columns — keep as extra fields on the record:{' '}
                  {p.headers.map((h: string, i: number) => !usedCols.has(i) && h ? <label key={i} className="check" style={{ display: 'inline-flex', marginRight: 10 }}><input type="checkbox" checked={extras.includes(i)} onChange={(e) => setExtras(e.target.checked ? [...extras, i] : extras.filter((x) => x !== i))} />{h}</label> : null)}
                </div>
              )}
            </details>
          )}

          {entity === 'rate_card' && (
            <div className="row small">
              New rates effective from <input type="date" value={opts.effectiveFrom} onChange={(e) => setOpts({ ...opts, effectiveFrom: e.target.value })} />
              · extra hours <select value={opts.hourRoundingMode} onChange={(e) => setOpts({ ...opts, hourRoundingMode: e.target.value })}><option value="ceil">rounded up</option><option value="nearest">rounded</option><option value="exact">exact</option></select>
              to <select value={opts.hourRoundingUnit} onChange={(e) => setOpts({ ...opts, hourRoundingUnit: e.target.value })}><option value="30">30 min</option><option value="60">1 hour</option><option value="15">15 min</option></select>
              · night <input type="time" value={opts.nightStart} onChange={(e) => setOpts({ ...opts, nightStart: e.target.value })} />–<input type="time" value={opts.nightEnd} onChange={(e) => setOpts({ ...opts, nightEnd: e.target.value })} />
              <span className="muted">(used for new rates; existing rates keep their own rounding and night window)</span>
            </div>
          )}
          <div className="row"><button className="btn" disabled={busy} onClick={() => recheck()}>{busy ? 'Checking…' : 'Re-check with these settings'}</button></div>

          {s && (
            <div className="kpis" style={{ marginBottom: 0 }}>
              <div className="kpi"><div className="v">{s.rows}</div><div className="l">Rows read</div></div>
              <div className="kpi"><div className="v" style={{ color: 'var(--ok)' }}>{s.add}</div><div className="l">To add</div></div>
              <div className="kpi"><div className="v" style={{ color: 'var(--brand)' }}>{s.update}</div><div className="l">To update</div></div>
              <div className="kpi"><div className="v">{s.unchanged}</div><div className="l">Unchanged</div></div>
              <div className={`kpi ${s.errors ? 'alert-kpi' : ''}`}><div className="v">{s.errors}</div><div className="l">Invalid / duplicate</div></div>
            </div>
          )}

          {p.sample?.length > 0 && (
            <details><summary><b>Sample of the file</b></summary>
              <div className="scroll" style={{ maxHeight: 200 }}><table className="t"><thead><tr><th>Row</th>{p.headers.map((h: string, i: number) => <th key={i}>{h}</th>)}</tr></thead>
                <tbody>{p.sample.map((r: any) => <tr key={r.rowNumber}><td className="muted">{r.rowNumber}</td>{r.cells.map((c: string, i: number) => <td key={i} className="small">{c}</td>)}</tr>)}</tbody></table></div>
            </details>
          )}

          {p.results?.length > 0 && (
            <>
              <div className="row"><b>What will happen</b><span className="spacer" />
                <select value={filter} onChange={(e) => setFilter(e.target.value as never)}><option value="all">All rows</option><option value="changes">New and updated</option><option value="error">Errors only</option></select></div>
              <div className="scroll" style={{ maxHeight: 320 }}>
                <table className="t">
                  <thead><tr><th>Row</th><th>Record</th><th>Result</th><th>{entity === 'rate_card' ? 'Current → incoming' : 'Changes'}</th><th>Problems</th></tr></thead>
                  <tbody>{results.map((r) => (
                    <tr key={r.rowNumber}>
                      <td className="muted">{r.rowNumber}</td>
                      <td>{entity === 'rate_card' ? <>{r.categoryName ?? r.category}{r.newCategory && <span className="badge warn"> new category</span>}<div className="small muted">{r.dutyTypeName}{r.newDutyType ? ' (new)' : ''} · from {r.effectiveFrom}</div></> : r.key || '—'}</td>
                      <td><span className={`badge ${ACTION_TONE[r.action]}`}>{ACTION_LABEL[r.action]}</span></td>
                      <td className="small">
                        {entity === 'rate_card'
                          ? Object.entries(r.incoming).map(([k, v]) => <div key={k}>{k}: {r.changes[k] ? <><s className="muted">{r.changes[k].from ?? '—'}</s> → <b>{String(v)}</b></> : String(v)}</div>)
                          : r.action === 'update' ? Object.entries(r.changes).map(([k, c]: [string, any]) => <div key={k}>{k}: <s className="muted">{show(c.from)}</s> → <b>{show(c.to)}</b></div>) : r.action === 'add' ? <span className="muted">new record</span> : ''}
                      </td>
                      <td className="small">{r.errors.map((e: string, i: number) => <div key={i} style={{ color: 'var(--err)' }}>{e}</div>)}{r.warnings.map((w: string, i: number) => <div key={i} style={{ color: 'var(--warn)' }}>{w}</div>)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </>
          )}

          <div className="row end">
            {s?.errors > 0 && <label className="check"><input type="checkbox" checked={skipInvalid} onChange={(e) => setSkipInvalid(e.target.checked)} />Import the valid rows only and skip {s.errors} invalid row(s)</label>}
            {entity === 'rate_card' && <label className="check"><input type="checkbox" checked={submit} onChange={(e) => setSubmit(e.target.checked)} />Submit new rates for approval</label>}
            {(s?.errors > 0 || p.results?.some((r: any) => r.warnings.length)) && <button className="btn" onClick={errorReport}>Download error report</button>}
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={busy || !s || (s.add + s.update === 0) || (s.errors > 0 && !skipInvalid)} onClick={commit}
              title={s && s.add + s.update === 0 ? 'Nothing to add or update' : undefined}>{busy ? 'Working…' : `Confirm import (${s ? s.add + s.update : 0})`}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
