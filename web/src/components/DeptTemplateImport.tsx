/**
 * Import the department bill workbooks (the LR bill-sheet format): each file is matched to a department, its header details are offered
 * for the department record, and an LR Standard template is created for it, to be approved in the usual way.
 */
import { useState } from 'react';
import { api } from '../api';
import { useClients } from '../lookups';
import { Modal, useAction } from './ui';

interface Choice { clientId: string; contractId: string; updateDetails: boolean }

export function DeptTemplateImport({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const clients = useClients();
  const { run, busy } = useAction();
  const [files, setFiles] = useState<File[]>([]);
  const [rows, setRows] = useState<any[] | null>(null);
  const [choice, setChoice] = useState<Record<string, Choice>>({});
  const [result, setResult] = useState<any[] | null>(null);
  const form = (mode: string) => {
    const fd = new FormData();
    fd.append('mode', mode);
    if (mode === 'apply') fd.append('choices', JSON.stringify(Object.fromEntries(Object.entries(choice).map(([k, c]) => [k, { clientId: c.clientId || undefined, contractId: c.contractId || null, updateDetails: c.updateDetails }]))));
    files.forEach((f) => fd.append('file', f));
    return fd;
  };
  const preview = async () => {
    const r = await run(() => api.post<any>('/templates/department-import', form('preview')));
    if (!r) return;
    setRows(r.results);
    setChoice(Object.fromEntries(r.results.filter((x: any) => !x.error).map((x: any) => [x.file, { clientId: x.matched?.id ?? '', contractId: x.contracts?.length === 1 ? x.contracts[0].id : '', updateDetails: (x.changes?.length ?? 0) > 0 }])));
  };
  const apply = async () => {
    const r = await run(() => api.post<any>('/templates/department-import', form('apply')), 'Templates created');
    if (r) { setResult(r.results); onDone(); }
  };
  const ready = rows?.filter((x) => !x.error && choice[x.file]?.clientId).length ?? 0;
  return (
    <Modal title="Import department bill templates" onClose={onClose} wide>
      {!rows && !result && (
        <>
          <p className="small muted">Choose the department bill workbooks (.xlsx) in the LR bill-sheet format, all at once. Each is matched to a department; you check the match, then the software fills in the department's header details (only blanks and the header lines), creates an <b>LR Standard</b> bill template for it and keeps the workbook as the reference. The new templates wait for approval, and no rate or contract is changed.</p>
          <input type="file" accept=".xlsx" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []).filter((f) => /\.xlsx$/i.test(f.name)))} />
          <div className="row end" style={{ marginTop: 12 }}><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !files.length} onClick={preview}>Read {files.length || ''} workbook(s)</button></div>
        </>
      )}
      {rows && !result && (
        <>
          <div className="scroll" style={{ maxHeight: '55vh' }}>
            <table className="t">
              <thead><tr><th>Workbook</th><th>Department in the sheet</th><th>Department in the software</th><th>Contract</th><th>Fill in</th></tr></thead>
              <tbody>
                {rows.map((x) => x.error ? <tr key={x.file}><td>{x.file}</td><td colSpan={4} style={{ color: 'var(--err)' }}>{x.error}</td></tr> : (
                  <tr key={x.file}>
                    <td>{x.file}</td>
                    <td>{x.sheet.title && <div className="small muted">{x.sheet.title}</div>}<b>{x.sheet.clientLine}</b><div className="small muted">{x.sheet.address}</div>{x.sheet.clientGstin && <div className="small muted">GSTIN {x.sheet.clientGstin}</div>}</td>
                    <td>
                      <select value={choice[x.file]?.clientId ?? ''} onChange={(e) => setChoice({ ...choice, [x.file]: { ...choice[x.file], clientId: e.target.value, contractId: '' } })} style={{ maxWidth: 230 }}>
                        <option value="">Choose…</option>
                        <option value="new">Create a new department ({x.newShortCode})</option>
                        {(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                      {!x.matched && <div className="small" style={{ color: 'var(--warn)' }}>No department matched: choose one or create it.</div>}
                    </td>
                    <td>{choice[x.file]?.clientId === x.matched?.id && x.contracts.length > 0
                      ? <select value={choice[x.file]?.contractId ?? ''} onChange={(e) => setChoice({ ...choice, [x.file]: { ...choice[x.file], contractId: e.target.value } })}><option value="">All contracts</option>{x.contracts.map((k: any) => <option key={k.id} value={k.id}>{k.reference_no}</option>)}</select> : <span className="muted">All contracts</span>}</td>
                    <td>
                      <label className="check"><input type="checkbox" checked={!!choice[x.file]?.updateDetails} disabled={choice[x.file]?.clientId === 'new'} onChange={(e) => setChoice({ ...choice, [x.file]: { ...choice[x.file], updateDetails: e.target.checked } })} />Update details</label>
                      {x.changes.length > 0 && <ul className="small" style={{ margin: '2px 0 0 14px' }}>{x.changes.map((c: any) => <li key={c.field}>{c.field}: {c.from ? `${c.from} → ` : ''}{c.to}</li>)}</ul>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row end" style={{ marginTop: 12 }}><button className="btn" onClick={() => setRows(null)}>Back</button><button className="btn primary" disabled={busy || !ready} onClick={apply}>Create {ready} template(s)</button></div>
        </>
      )}
      {result && (
        <>
          <ul>{result.map((x) => <li key={x.file}>{x.error ? <span style={{ color: 'var(--err)' }}>{x.file}: {x.error}</span> : x.skipped ? <>{x.file} — {x.skipped}</> : <>{x.file} → <b>{x.department}</b>{x.createdDepartment ? ' (new department)' : ''}: "{x.name}" created</>}</li>)}</ul>
          <p className="small muted">Each new template is a draft: open it, preview it, and have an approver approve it before bills use it.</p>
          <div className="row end"><button className="btn primary" onClick={onClose}>Close</button></div>
        </>
      )}
    </Modal>
  );
}
