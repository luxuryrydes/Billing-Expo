import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, fileUrl, qs } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Field, Loading, Modal, PageHead, Status, useAction } from '../components/ui';
import { dt } from '../format';
import { useClients, useContracts } from '../lookups';

const DOC_TYPES: [string, string][] = [
  ['contract', 'Contract'], ['tender', 'Tender document'], ['scc', 'Special Conditions (SCC)'], ['acc', 'Additional Conditions (ACC)'], ['rate_schedule', 'Rate schedule'],
  ['work_order', 'Work order / PO'], ['sample_invoice', 'Sample invoice / bill'], ['billing_register', 'Billing register'], ['duty_sheet', 'Duty sheet'], ['other', 'Other'],
];

function UploadForm({ onDone, documentId, contractId }: { onDone: () => void; documentId?: string; contractId?: string }) {
  const clients = useClients();
  const [clientId, setClientId] = useState('');
  const contracts = useContracts(clientId || undefined);
  const [f, setF] = useState({ contract_id: contractId ?? '', doc_type: 'contract', title: '', run_ai: true });
  const [file, setFile] = useState<File | null>(null);
  const { run, busy } = useAction();
  const submit = async () => {
    if (!file) return;
    const fd = new FormData();
    if (documentId) fd.append('document_id', documentId);
    else {
      if (clientId) fd.append('client_id', clientId);
      if (f.contract_id) fd.append('contract_id', f.contract_id);
      fd.append('doc_type', f.doc_type);
      fd.append('title', f.title || file.name);
    }
    fd.append('run_ai', String(f.run_ai));
    fd.append('file', file);
    if (await run(() => api.post('/documents', fd), 'Uploaded — extraction is running')) onDone();
  };
  return (
    <div className="grid">
      {!documentId && (
        <>
          <div className="grid g2">
            <Field label="Department"><select value={clientId} onChange={(e) => setClientId(e.target.value)}><option value="">Select…</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <Field label="Contract" hint="Extracted terms are compared within a contract"><select value={f.contract_id} onChange={(e) => setF({ ...f, contract_id: e.target.value })}><option value="">(none)</option>{contracts.data?.map((k) => <option key={k.id} value={k.id}>{k.reference_no} — {k.title}</option>)}</select></Field>
          </div>
          <div className="grid g2">
            <Field label="Document type" required><select value={f.doc_type} onChange={(e) => setF({ ...f, doc_type: e.target.value })}>{DOC_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="Title"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Defaults to file name" /></Field>
          </div>
        </>
      )}
      <Field label="File" required hint="PDF, Excel (.xlsx), Word (.docx), CSV or scanned image. Max 25 MB. Macro-enabled files are refused.">
        <input type="file" accept=".pdf,.xlsx,.csv,.docx,.png,.jpg,.jpeg,.tif,.tiff" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </Field>
      <label className="check"><input type="checkbox" checked={f.run_ai} onChange={(e) => setF({ ...f, run_ai: e.target.checked })} />Also use AI extraction (only if an API key is configured; every value must quote the document)</label>
      <div className="row end"><button className="btn" onClick={onDone}>Cancel</button><button className="btn primary" disabled={!file || busy} onClick={submit}>Upload</button></div>
    </div>
  );
}

export function DocumentsPage() {
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const clients = useClients();
  const [clientId, setClientId] = useState('');
  const q = useQuery({ queryKey: ['documents', clientId], queryFn: () => api.get<any[]>(`/documents${qs({ clientId })}`), refetchInterval: (qq) => ((qq.state.data ?? []).some((x: any) => ['pending', 'running'].includes(x.extraction_status)) ? 2500 : false) });
  const [upload, setUpload] = useState(!!sp.get('contract'));
  return (
    <>
      <PageHead title="Document Uploads" sub="Contracts, tenders, rate schedules, sample bills and duty sheets. Originals are kept with every version.">
        <select value={clientId} onChange={(e) => setClientId(e.target.value)}><option value="">All departments</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        {can('document.upload') && <button className="btn primary" onClick={() => setUpload(true)}>Upload document</button>}
      </PageHead>
      <ErrorBox error={q.error} />
      <div className="panel tight">
        {q.isLoading ? <Loading /> : (
          <table className="t">
            <thead><tr><th>Document</th><th>Type</th><th>Department / contract</th><th>Version</th><th>Uploaded</th><th>Extraction</th><th className="num">To review</th><th className="num">Conflicts</th></tr></thead>
            <tbody>
              {q.data?.map((x) => (
                <tr key={x.id}><td><Link to={`/documents/${x.id}`}>{x.title}</Link><div className="small muted">{x.original_name}</div></td><td>{DOC_TYPES.find((t) => t[0] === x.doc_type)?.[1]}</td>
                  <td>{x.client_name}<div className="small muted">{x.contract_ref}</div></td><td>v{x.latest_version}</td><td>{dt(x.uploaded_at)}<div className="small muted">{x.uploaded_by_name}</div></td>
                  <td><Status s={x.extraction_status} /></td><td className="num">{x.pending_items || ''}</td><td className="num">{x.conflicts ? <span className="badge err">{x.conflicts}</span> : ''}</td></tr>
              ))}
              {q.data?.length === 0 && <tr><td colSpan={8} className="empty">No documents uploaded.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      {upload && <Modal title="Upload document" onClose={() => setUpload(false)}><UploadForm contractId={sp.get('contract') ?? undefined} onDone={() => { setUpload(false); q.refetch(); }} /></Modal>}
    </>
  );
}

export function DocumentReviewPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const doc = useQuery({ queryKey: ['document', id], queryFn: () => api.get(`/documents/${id}`), refetchInterval: (qq) => (['pending', 'running'].includes(qq.state.data?.versions?.[0]?.extraction_status) ? 2000 : false) });
  const [versionId, setVersionId] = useState<string>('');
  useEffect(() => { if (doc.data && !versionId) setVersionId(doc.data.versions[0]?.id ?? ''); }, [doc.data, versionId]);
  const v = doc.data?.versions.find((x: any) => x.id === versionId);
  const items = useQuery({ queryKey: ['items', versionId, v?.extraction_status], queryFn: () => api.get<any[]>(`/document-versions/${versionId}/items`), enabled: !!versionId });
  const [page, setPage] = useState<number | null>(null);
  const [highlight, setHighlight] = useState('');
  const pageQ = useQuery({ queryKey: ['page', versionId, page], queryFn: () => api.get(`/document-versions/${versionId}/page/${page}`), enabled: !!versionId && page != null });
  const [edit, setEdit] = useState<any>(null);
  const [newVersion, setNewVersion] = useState(false);
  const [filter, setFilter] = useState<'all' | 'pending' | 'conflict'>('all');
  const { run, busy } = useAction();
  if (doc.isLoading) return <Loading />;
  if (doc.error) return <ErrorBox error={doc.error} />;
  const d = doc.data;
  const decide = async (it: any, status: string, extra: Record<string, unknown> = {}) => {
    if (await run(() => api.patch(`/extracted-items/${it.id}`, { status, ...extra }))) { items.refetch(); setEdit(null); }
  };
  const rows = (items.data ?? []).filter((r) => filter === 'all' || (filter === 'pending' ? r.status === 'pending' : r.conflict));
  const showSource = (r: any) => { setPage(r.source_page ?? 1); setHighlight(r.source_text ?? ''); };
  const pageText: string = pageQ.data?.text ?? '';
  const hl = highlight && pageText.includes(highlight.slice(0, 60)) ? highlight.slice(0, 60) : '';
  return (
    <>
      <PageHead title={d.title} sub={<>{d.client_name} {d.contract_ref && <>· <Link to={`/contracts/${d.contract_id}`}>{d.contract_ref}</Link></>} · {d.doc_type}</>}>
        <select value={versionId} onChange={(e) => setVersionId(e.target.value)}>{d.versions.map((x: any) => <option key={x.id} value={x.id}>v{x.version_no} — {x.original_name}</option>)}</select>
        {v && <a className="btn" href={fileUrl(v.file_id, true)} target="_blank" rel="noreferrer">Open original</a>}
        {can('document.upload') && <button className="btn" onClick={() => setNewVersion(true)}>Upload new version</button>}
        {can('document.upload') && v && <button className="btn" disabled={busy} onClick={async () => { if (await run(() => api.post(`/document-versions/${v.id}/extract`, { useAi: true }), 'Extraction restarted')) doc.refetch(); }}>Re-run extraction</button>}
      </PageHead>
      {v && (
        <div className="panel">
          <div className="row"><b>Version {v.version_no}</b> <Status s={v.extraction_status} /> <span className="muted small">{v.extraction_method} · {v.page_count ?? '?'} page(s) · uploaded {dt(v.uploaded_at)} by {v.uploaded_by_name} · SHA-256 <span className="mono">{v.sha256.slice(0, 12)}…</span></span></div>
          {v.extraction_error && <div className="alert err" style={{ marginTop: 8 }}>{v.extraction_error}</div>}
          {(v.warnings ?? []).map((w: string, i: number) => <div key={i} className="alert warn" style={{ marginTop: 8, marginBottom: 0 }}>{w}</div>)}
          {(v.questions ?? []).length > 0 && <div className="alert info" style={{ marginTop: 8, marginBottom: 0 }}><b>Open questions to resolve:</b><ul>{v.questions.map((q: string, i: number) => <li key={i}>{q}</li>)}</ul></div>}
        </div>
      )}
      <div className="alert info">Each value below is a <b>candidate</b>. Nothing becomes a billing rule until a person accepts it here and then configures and approves the rate scheme or tax rule. Click a row to see its source text.</div>
      <div className="split">
        <div className="panel tight">
          <div className="row" style={{ padding: 8 }}>
            <select value={filter} onChange={(e) => setFilter(e.target.value as never)}><option value="all">All candidates</option><option value="pending">Pending review</option><option value="conflict">Conflicts</option></select>
            <span className="spacer" />
            {can('extraction.review') && <button className="btn sm" onClick={() => setEdit({ manual: true, field_key: 'billing_condition', value: '', unit: '', qualifier: '', source_page: page ?? 1, source_text: '' })}>Add term manually</button>}
          </div>
          <div className="scroll">
            <table className="t">
              <thead><tr><th>Term</th><th>Value</th><th>Source</th><th>Conf.</th><th>Status</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => showSource(r)}>
                    <td>{r.label}<div className="small muted">{r.qualifier}</div>{r.conflict && <span className="badge err">conflict</span>}</td>
                    <td><b>{r.edited_value ?? r.value}</b> {r.unit}{r.edited_value && <div className="small muted">was {r.value}</div>}</td>
                    <td className="small">{r.source_page ? `p.${r.source_page}` : '—'} <span className="badge">{r.method}</span></td>
                    <td className="small">{r.confidence != null ? Number(r.confidence).toFixed(2) : ''}</td>
                    <td><Status s={r.status} />{r.reviewed_by_name && <div className="small muted">{r.reviewed_by_name}</div>}</td>
                    <td className="nowrap" onClick={(e) => e.stopPropagation()}>
                      {can('extraction.review') && <>
                        <button className="btn sm ok" disabled={busy || r.status === 'accepted'} onClick={() => decide(r, 'accepted')}>Accept</button>{' '}
                        <button className="btn sm" onClick={() => setEdit(r)}>Edit</button>{' '}
                        <button className="btn sm danger" disabled={busy || r.status === 'rejected'} onClick={() => decide(r, 'rejected')}>Reject</button>
                      </>}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={6} className="empty">{v?.extraction_status === 'done' ? 'No candidate terms found. Add terms manually from the source text.' : 'Waiting for extraction…'}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <div className="row"><h3 style={{ margin: 0 }}>Source text</h3><span className="spacer" />
            <button className="btn sm" disabled={!page || page <= 1} onClick={() => setPage((p) => (p ?? 1) - 1)}>‹</button>
            <span className="small">page {page ?? '—'} / {v?.page_count ?? '?'}</span>
            <button className="btn sm" disabled={!page || page >= (v?.page_count ?? 1)} onClick={() => setPage((p) => (p ?? 0) + 1)}>›</button>
            {!page && <button className="btn sm" onClick={() => setPage(1)}>Show page 1</button>}</div>
          {highlight && <div className="trace" style={{ margin: '8px 0' }}>“{highlight}”</div>}
          {pageQ.isLoading && page ? <Loading /> : page ? (
            <div className="pagetext">{hl ? <>{pageText.split(hl)[0]}<mark>{hl}</mark>{pageText.split(hl).slice(1).join(hl)}</> : pageText || '(no text on this page)'}</div>
          ) : <p className="muted">Select a candidate to see where it came from.</p>}
        </div>
      </div>
      {edit && <EditItem item={edit} versionId={versionId} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); items.refetch(); }} />}
      {newVersion && <Modal title="Upload a new version" onClose={() => setNewVersion(false)}><UploadForm documentId={d.id} onDone={() => { setNewVersion(false); setVersionId(''); doc.refetch(); }} /></Modal>}
    </>
  );
}

function EditItem({ item, versionId, onClose, onSaved }: { item: any; versionId: string; onClose: () => void; onSaved: () => void }) {
  const fields = useQuery({ queryKey: ['extraction-fields'], queryFn: () => api.get<Record<string, string>>('/extraction/fields') });
  const [f, setF] = useState<any>({ ...item, edited_value: item.edited_value ?? item.value ?? '', review_note: item.review_note ?? '' });
  const { run, busy } = useAction();
  const save = async () => {
    const r = item.manual
      ? await run(() => api.post(`/document-versions/${versionId}/items`, { field_key: f.field_key, value: f.edited_value, unit: f.unit, qualifier: f.qualifier, source_page: Number(f.source_page) || null, source_text: f.source_text }), 'Term added')
      : await run(() => api.patch(`/extracted-items/${item.id}`, { status: 'edited', edited_value: f.edited_value, review_note: f.review_note }), 'Saved');
    if (r) onSaved();
  };
  return (
    <Modal title={item.manual ? 'Add term' : `Correct: ${item.label}`} onClose={onClose}>
      <div className="grid">
        {item.manual ? (
          <>
            <div className="grid g2">
              <Field label="Term" required><select value={f.field_key} onChange={(e) => setF({ ...f, field_key: e.target.value })}>{Object.entries(fields.data ?? {}).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
              <Field label="Applies to (vehicle / tax type)"><input value={f.qualifier} onChange={(e) => setF({ ...f, qualifier: e.target.value })} /></Field>
              <Field label="Value" required><input value={f.edited_value} onChange={(e) => setF({ ...f, edited_value: e.target.value })} /></Field>
              <Field label="Unit"><input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} /></Field>
              <Field label="Page"><input type="number" value={f.source_page} onChange={(e) => setF({ ...f, source_page: e.target.value })} /></Field>
            </div>
            <Field label="Quote the clause exactly" required><textarea value={f.source_text} onChange={(e) => setF({ ...f, source_text: e.target.value })} /></Field>
          </>
        ) : (
          <>
            <div className="trace">“{item.source_text}”</div>
            <Field label="Corrected value" required><input value={f.edited_value} onChange={(e) => setF({ ...f, edited_value: e.target.value })} /></Field>
            <Field label="Note"><textarea value={f.review_note} onChange={(e) => setF({ ...f, review_note: e.target.value })} /></Field>
          </>
        )}
        <div className="row end"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Save</button></div>
      </div>
    </Modal>
  );
}
