import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Field, Modal, useAction } from './ui';
import { dt } from '../format';

export const DOC_TYPES: [string, string][] = [
  ['contract', 'Contract / GeM order'], ['tender', 'Tender document'], ['scc', 'Special Conditions (SCC)'], ['acc', 'Additional Conditions (ACC)'], ['rate_schedule', 'Rate schedule'],
  ['work_order', 'Work order / PO'], ['sample_invoice', 'Sample bill / invoice'], ['billing_register', 'Billing register'], ['duty_sheet', 'Duty sheet'], ['other', 'Other'],
];

async function sha256(f: File): Promise<string | undefined> {
  try {
    const h = await crypto.subtle.digest('SHA-256', await f.arrayBuffer());
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return undefined; }
}

/**
 * Uploads a document for a department / contract. If a document of the same type already exists
 * there, the user chooses to update it (a new version — older versions stay available) or to keep
 * the file as a separate document. Documents of other departments or contracts are never offered.
 */
export function DocumentUploader({ clientId, contractId, defaultType = 'contract', label = 'Upload document', onDone }: { clientId: string; contractId?: string; defaultType?: string; label?: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [docType, setDocType] = useState(defaultType);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [useAi, setUseAi] = useState(true);
  const [match, setMatch] = useState<{ matches: any[]; identical: any } | null>(null);
  const [target, setTarget] = useState<string>('');
  const { run, busy } = useAction();

  const reset = () => { setOpen(false); setFile(null); setTitle(''); setNote(''); setMatch(null); setTarget(''); };
  const check = async () => {
    if (!file) return;
    const m = await run(async () => api.post('/documents/match', { client_id: clientId, contract_id: contractId ?? null, doc_type: docType, file_name: file.name, sha256: await sha256(file) }));
    if (!m) return;
    if (m.matches.length) { setMatch(m); setTarget(m.matches.find((x: any) => x.sameName || x.sameFile)?.id ?? m.matches[0].id); }
    else await send(null);
  };
  const send = async (documentId: string | null) => {
    const fd = new FormData();
    if (documentId) fd.append('document_id', documentId);
    fd.append('client_id', clientId);
    if (contractId) fd.append('contract_id', contractId);
    fd.append('doc_type', docType);
    fd.append('title', title || file!.name.replace(/\.[^.]+$/, ''));
    if (note) fd.append('note', note);
    fd.append('run_ai', String(useAi));
    fd.append('file', file!);
    const r = await run(() => api.post('/documents', fd), documentId ? 'New version saved — earlier versions are kept' : 'Uploaded — reading the document');
    if (r) { reset(); onDone(); }
  };

  return (
    <>
      <button className="btn primary" onClick={() => setOpen(true)}>{label}</button>
      {open && (
        <Modal title={match ? 'This document already exists' : label} onClose={reset}>
          {!match ? (
            <div className="grid">
              <Field label="File" required hint="PDF, Excel, Word, CSV or scanned image, up to 25 MB"><input type="file" accept=".pdf,.xlsx,.xls,.csv,.docx,.png,.jpg,.jpeg,.tif,.tiff" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
              <div className="grid g2">
                <Field label="Document type"><select value={docType} onChange={(e) => setDocType(e.target.value)}>{DOC_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
                <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Defaults to the file name" /></Field>
              </div>
              <Field label="Note (optional)" hint="e.g. Revised rate schedule from the department"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              <label className="check"><input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} />Also use AI reading where configured</label>
              <div className="row end"><button className="btn" onClick={reset}>Cancel</button><button className="btn primary" disabled={!file || busy} onClick={check}>Upload</button></div>
            </div>
          ) : (
            <div className="grid">
              {match.identical && <div className="alert warn">This exact file is already the current version of “{match.identical.title}” (v{match.identical.latest_version}). Uploading it again only adds another copy.</div>}
              <p>A {DOC_TYPES.find((d) => d[0] === docType)?.[1].toLowerCase()} already exists here. Update it with <b>{file?.name}</b>?</p>
              <table className="t"><tbody>{match.matches.map((m) => (
                <tr key={m.id}><td><input type="radio" name="target" checked={target === m.id} onChange={() => setTarget(m.id)} /></td>
                  <td><Link to={`/documents/${m.id}`} target="_blank">{m.title}</Link> {m.sameName && <span className="badge brand">same name</span>} {m.sameFile && <span className="badge warn">identical file</span>}
                    <div className="small muted">v{m.latest_version} · {m.original_name} · {dt(m.uploaded_at)}{m.uploaded_by_name ? ` by ${m.uploaded_by_name}` : ''}</div></td></tr>
              ))}</tbody></table>
              <div className="alert info small">Updating adds the file as a new version. The previous versions stay in the document's history and can be restored; review decisions on them are kept.</div>
              <div className="row end">
                <button className="btn" onClick={reset}>Cancel</button>
                <button className="btn" disabled={busy} onClick={() => send(null)}>Keep as a separate document</button>
                <button className="btn primary" disabled={busy || !target} onClick={() => send(target)}>Update existing document</button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

/** Documents of a department or contract with their version history. */
export function DocumentList({ docs, reload }: { docs: any[]; reload: () => void }) {
  const { run } = useAction();
  const [history, setHistory] = useState<any>(null);
  const openHistory = async (id: string) => setHistory(await api.get(`/documents/${id}`));
  return (
    <>
      <table className="t">
        <thead><tr><th>Document</th><th>Type</th><th>Current version</th><th>Updated</th><th>Reading</th><th /></tr></thead>
        <tbody>
          {docs.map((x) => (
            <tr key={x.id}><td><Link to={`/documents/${x.id}`}>{x.title}</Link><div className="small muted">{x.original_name}</div></td><td>{DOC_TYPES.find((t) => t[0] === x.doc_type)?.[1] ?? x.doc_type}</td>
              <td>v{x.latest_version}</td><td>{dt(x.uploaded_at ?? x.created_at)}<div className="small muted">{x.uploaded_by_name}</div></td>
              <td>{x.extraction_status}{x.pending_items ? <span className="badge warn"> {x.pending_items} to review</span> : ''}</td>
              <td><button className="btn sm" onClick={() => openHistory(x.id)}>History</button></td></tr>
          ))}
          {docs.length === 0 && <tr><td colSpan={6} className="empty">No documents yet.</td></tr>}
        </tbody>
      </table>
      {history && (
        <Modal title={`${history.title} — versions`} onClose={() => setHistory(null)}>
          <table className="t"><thead><tr><th>Version</th><th>File</th><th>Uploaded</th><th>Note</th><th /></tr></thead>
            <tbody>{history.versions.map((v: any, i: number) => (
              <tr key={v.id}><td>v{v.version_no}{i === 0 && <span className="badge ok"> current</span>}</td><td><a href={`/api/files/${v.file_id}/download`}>{v.original_name}</a></td><td>{dt(v.uploaded_at)}<div className="small muted">{v.uploaded_by_name}</div></td><td className="small">{v.note}</td>
                <td>{i > 0 && <button className="btn sm" onClick={async () => { if (confirm(`Make version ${v.version_no} current again? It is added as a new version; nothing is deleted.`) && await run(() => api.post(`/document-versions/${v.id}/restore`), 'Version restored')) { setHistory(await api.get(`/documents/${history.id}`)); reload(); } }}>Restore</button>}</td></tr>
            ))}</tbody></table>
        </Modal>
      )}
    </>
  );
}
