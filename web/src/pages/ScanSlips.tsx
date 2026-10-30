import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, errorText } from '../api';
import { useAuth } from '../auth';
import { useContracts } from '../lookups';
import { ErrorBox, Field, Loading, PageHead, Status, Tabs, useAction, useToast } from '../components/ui';

type Tab = 'pages' | 'review' | 'save';
interface FieldDef { key: string; label: string; kind: string }
const img = (fileId: string) => `/api/files/${fileId}/download`;
const LOW = 0.6;

// --- image tools (done in the browser; the scanned original is kept on the server) ---------------
const loadImage = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('The page image could not be loaded')); i.src = url; });
const toBlob = (c: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not create the image'))), 'image/jpeg', 0.92));
async function rotated(url: string, deg: 90 | -90 | 180): Promise<Blob> {
  const i = await loadImage(url);
  const c = document.createElement('canvas');
  const swap = deg !== 180;
  c.width = swap ? i.naturalHeight : i.naturalWidth;
  c.height = swap ? i.naturalWidth : i.naturalHeight;
  const g = c.getContext('2d')!;
  g.translate(c.width / 2, c.height / 2);
  g.rotate((deg * Math.PI) / 180);
  g.drawImage(i, -i.naturalWidth / 2, -i.naturalHeight / 2);
  return toBlob(c);
}
async function cropped(url: string, r: { x: number; y: number; w: number; h: number }): Promise<Blob> {
  const i = await loadImage(url);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(r.w));
  c.height = Math.max(1, Math.round(r.h));
  c.getContext('2d')!.drawImage(i, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  return toBlob(c);
}

export function ScanSlipsPage() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const batchId = sp.get('batch') ?? '';
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['scan-status'], queryFn: () => api.get<any>('/scan/status') });
  const batches = useQuery({ queryKey: ['scan-batches'], queryFn: () => api.get<any[]>('/scan/batches') });
  const detail = useQuery({
    queryKey: ['scan-batch', batchId], enabled: !!batchId, queryFn: () => api.get<any>(`/scan/batches/${batchId}`),
    refetchInterval: (q) => (q.state.data?.batch?.status === 'scanning' ? 1500 : false),
  });
  const [tab, setTab] = useState<Tab>('pages');
  const open = (id: string) => setSp(id ? { batch: id } : {});
  const reload = () => { qc.invalidateQueries({ queryKey: ['scan-batch', batchId] }); qc.invalidateQueries({ queryKey: ['scan-batches'] }); };

  if (!can('duty.write')) return <><PageHead title="Duty Slip Scanning & Billing" /><div className="alert warn">You need permission to enter duties to scan duty slips.</div></>;
  const st = status.data;
  return (
    <>
      <PageHead title="Duty Slip Scanning & Billing" sub="Scan a stack of duty slips, check what was read, save them as duties and prepare the bill.">
        {st && <span className={`badge ${st.scanner.available ? 'ok' : 'warn'}`}>{st.scanner.available ? 'Scanner ready' : 'No scanner here'}</span>}
        {st && <span className={`badge ${st.ai.configured ? 'ok' : 'err'}`}>{st.ai.configured ? 'AI reading on' : 'AI reading off'}</span>}
      </PageHead>
      <ErrorBox error={status.error ?? batches.error} />
      {st && !st.ai.configured && <div className="alert warn">AI reading is off. Add ANTHROPIC_API_KEY to the settings file (.env) and restart the software; scanned pages can still be saved and filled in by hand.</div>}
      <ScanPanel status={st} onStarted={(id) => { open(id); setTab('pages'); qc.invalidateQueries({ queryKey: ['scan-batches'] }); }} />

      <div className="panel">
        <div className="row" style={{ marginBottom: batchId ? 10 : 0 }}>
          <b>Scanned batches</b>
          <select value={batchId} onChange={(e) => open(e.target.value)} style={{ minWidth: 320 }}>
            <option value="">{batches.data?.length ? 'Choose a batch…' : 'No batches yet'}</option>
            {(batches.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.title} — {b.pages} page(s), {b.read_count} read, {b.saved_count} saved</option>)}
          </select>
        </div>
        {batchId && detail.isLoading && <Loading />}
        <ErrorBox error={detail.error} />
        {detail.data && (
          <>
            <BatchHeader d={detail.data} reload={reload} />
            <Tabs<Tab> tabs={[['pages', `1. Pages (${detail.data.pages.filter((p: any) => !p.deleted).length})`], ['review', '2. Read & review'], ['save', '3. Save as duties & bill']]} value={tab} onChange={setTab} />
            {tab === 'pages' && <PagesTab d={detail.data} status={st} reload={reload} />}
            {tab === 'review' && <ReviewTab d={detail.data} status={st} reload={reload} />}
            {tab === 'save' && <SaveTab d={detail.data} reload={reload} />}
          </>
        )}
      </div>
    </>
  );
}

// --- starting a scan ----------------------------------------------------------------------------
function ScanPanel({ status, onStarted }: { status: any; onStarted: (id: string) => void }) {
  const available = status?.scanner?.available;
  const devices = useQuery({ queryKey: ['scan-devices'], enabled: !!available, queryFn: () => api.get<{ devices: any[] }>('/scan/devices'), retry: 0 });
  const [f, setF] = useState({ deviceId: '', mode: 'color', dpi: 200, source: 'feeder', duplex: false, title: '' });
  const { run, busy } = useAction();
  const dev = devices.data?.devices.find((d) => d.id === (f.deviceId || devices.data?.devices[0]?.id));
  useEffect(() => { if (!f.deviceId && devices.data?.devices[0]) setF((x) => ({ ...x, deviceId: devices.data!.devices[0].id })); }, [devices.data]);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const fd = new FormData();
    Array.from(files).forEach((x) => fd.append('file', x));
    const r = await run(() => api.post('/scan/batches/upload', fd), 'Images added');
    if (r) onStarted(r.batch.id);
  };
  const start = async () => {
    const r = await run(() => api.post('/scan/batches', { ...f, deviceId: f.deviceId || devices.data?.devices[0]?.id, title: f.title || undefined }));
    if (r) onStarted(r.batch.id);
  };
  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>Scan duty slips</h3>
      {!available && <div className="alert info">{status?.scanner?.reason ?? 'Checking the scanner…'} You can still upload scanned images below.</div>}
      {available && (
        <>
          <ErrorBox error={devices.error} />
          <div className="grid g4">
            <Field label="Scanner"><select value={f.deviceId} onChange={(e) => setF({ ...f, deviceId: e.target.value })}>{(devices.data?.devices ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
            <Field label="Colour"><select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}><option value="color">Colour</option><option value="gray">Grey</option><option value="bw">Black &amp; white</option></select></Field>
            <Field label="Resolution"><select value={f.dpi} onChange={(e) => setF({ ...f, dpi: Number(e.target.value) })}>{[100, 150, 200, 300, 400, 600].map((n) => <option key={n} value={n}>{n} DPI{n === 200 ? ' (recommended)' : ''}</option>)}</select></Field>
            <Field label="Load from"><select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}><option value="feeder">Document feeder (ADF) — all pages</option><option value="flatbed">Flatbed — one page</option></select></Field>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <label className="check"><input type="checkbox" checked={f.duplex} disabled={!dev?.duplex} onChange={(e) => setF({ ...f, duplex: e.target.checked })} />Scan both sides {dev && !dev.duplex && <span className="small muted">(this scanner does not support it; scan one side, turn the stack over, then scan again and add the pages)</span>}</label>
            <input placeholder="Batch name (optional)" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} style={{ width: 240 }} />
            <button className="btn primary" disabled={busy || status?.scanner?.busy || !devices.data?.devices.length} onClick={start}>{busy ? 'Starting…' : 'Start scanning'}</button>
          </div>
        </>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <span className="small muted">Or add images scanned elsewhere (JPG / PNG):</span>
        <input type="file" accept=".jpg,.jpeg,.png" multiple disabled={busy} onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
      </div>
    </div>
  );
}

function BatchHeader({ d, reload }: { d: any; reload: () => void }) {
  const b = d.batch;
  const { run } = useAction();
  const [title, setTitle] = useState(b.title);
  useEffect(() => setTitle(b.title), [b.id, b.title]);
  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const fd = new FormData();
    Array.from(files).forEach((x) => fd.append('file', x));
    if (await run(() => api.post(`/scan/batches/${b.id}/pages`, fd), 'Pages added')) reload();
  };
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="row">
        <input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={async () => { if (title.trim() && title !== b.title) { await run(() => api.patch(`/scan/batches/${b.id}`, { title })); reload(); } }} style={{ width: 300, fontWeight: 600 }} aria-label="Batch name" />
        <Status s={b.status} />
        <span className="small muted">{b.source === 'upload' ? 'Uploaded images' : `${b.device_name ?? 'Scanner'} · ${b.color_mode} · ${b.dpi} DPI · ${b.scan_source === 'feeder' ? 'document feeder' : 'flatbed'}`}</span>
        <span className="spacer" />
        <label className="btn sm">Add pages<input type="file" accept=".jpg,.jpeg,.png" multiple style={{ display: 'none' }} onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} /></label>
      </div>
      {b.status === 'scanning' && <div className="alert info" style={{ marginTop: 8 }}>Scanning… {d.pages.length} page(s) so far. Keep the pages in the scanner until it stops.</div>}
      {b.error && <div className="alert err" style={{ marginTop: 8 }}>{b.error}</div>}
    </div>
  );
}

// --- step 1: pages -----------------------------------------------------------------------------
function PagesTab({ d, status, reload }: { d: any; status: any; reload: () => void }) {
  const pages: any[] = d.pages.filter((p: any) => !p.deleted);
  const removed: any[] = d.pages.filter((p: any) => p.deleted);
  const [sel, setSel] = useState<string>('');
  const cur = pages.find((p) => p.id === sel) ?? pages[0];
  const { run, busy } = useAction();
  const move = async (id: string, to: number) => {
    const ids = pages.map((p) => p.id).filter((x) => x !== id);
    ids.splice(Math.max(0, Math.min(ids.length, to)), 0, id);
    if (await run(() => api.post(`/scan/batches/${d.batch.id}/reorder`, { pageIds: ids }))) reload();
  };
  const [dragId, setDragId] = useState('');
  if (!pages.length && !removed.length) return <div className="empty">No pages yet.</div>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 340px) minmax(0, 1fr)', gap: 14 }}>
      <div>
        <div className="small muted" style={{ marginBottom: 6 }}>Drag a page to a new place, or select it and use the buttons.</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 8, maxHeight: '66vh', overflow: 'auto' }}>
          {pages.map((p, i) => (
            <div key={p.id} draggable onDragStart={() => setDragId(p.id)} onDragOver={(e) => e.preventDefault()} onDrop={() => { if (dragId && dragId !== p.id) move(dragId, i); setDragId(''); }}
              onClick={() => setSel(p.id)} style={{ border: `2px solid ${cur?.id === p.id ? 'var(--brand)' : 'var(--line)'}`, borderRadius: 6, padding: 3, cursor: 'pointer', background: '#fff' }}>
              <img src={img(p.fileId)} alt={`Page ${i + 1}`} style={{ width: '100%', height: 110, objectFit: 'contain', background: '#f3f4f6' }} />
              <div className="small" style={{ display: 'flex', justifyContent: 'space-between' }}><b>{i + 1}</b><span>{p.editedImage && '✎ '}{p.reading.status === 'read' ? '✔' : p.reading.status === 'failed' ? '✖' : ''}</span></div>
            </div>
          ))}
        </div>
        {removed.length > 0 && (
          <details style={{ marginTop: 8 }}><summary className="small">{removed.length} removed page(s)</summary>
            {removed.map((p) => <div key={p.id} className="row small" style={{ marginTop: 4 }}>Page {p.position} <button className="btn sm" onClick={async () => { if (await run(() => api.post(`/scan/pages/${p.id}/delete`, { deleted: false }))) reload(); }}>Restore</button></div>)}
          </details>
        )}
      </div>
      {cur && <PageViewer key={cur.id + cur.fileId} page={cur} index={pages.indexOf(cur)} count={pages.length} status={status} busy={busy} run={run} reload={reload} move={move} />}
    </div>
  );
}

function PageViewer({ page, index, count, status, busy, run, reload, move }: { page: any; index: number; count: number; status: any; busy: boolean; run: <T>(fn: () => Promise<T>, ok?: string) => Promise<T | undefined>; reload: () => void; move: (id: string, to: number) => void }) {
  const ref = useRef<HTMLImageElement>(null);
  const [crop, setCrop] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const url = img(page.fileId);
  const send = async (make: () => Promise<Blob>, ok: string) => {
    const blob = await make();
    const fd = new FormData();
    fd.append('file', blob, 'page.jpg');
    if (await run(() => api.put(`/scan/pages/${page.id}/image`, fd), ok)) reload();
  };
  const pos = (e: React.MouseEvent) => { const r = ref.current!.getBoundingClientRect(); return { x: Math.max(0, Math.min(r.width, e.clientX - r.left)), y: Math.max(0, Math.min(r.height, e.clientY - r.top)) }; };
  const applyCrop = () => {
    if (!drag || !ref.current) return;
    const el = ref.current;
    const k = el.naturalWidth / el.clientWidth;
    const x = Math.min(drag.x0, drag.x1) * k, y = Math.min(drag.y0, drag.y1) * k, w = Math.abs(drag.x1 - drag.x0) * k, h = Math.abs(drag.y1 - drag.y0) * k;
    if (w < 20 || h < 20) return;
    send(() => cropped(url, { x, y, w, h }), 'Page cropped').then(() => { setCrop(false); setDrag(null); });
  };
  const rescan = async () => {
    if (!confirm('Put this page back in the scanner (flatbed) and rescan it? The current image will be replaced.')) return;
    const devs = await api.get<{ devices: any[] }>('/scan/devices');
    if (await run(() => api.post(`/scan/pages/${page.id}/rescan`, { deviceId: devs.devices[0]?.id, mode: 'color', dpi: 200, source: 'flatbed', duplex: false }), 'Page rescanned')) reload();
  };
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <b>Page {index + 1} of {count}</b>
        <button className="btn sm" disabled={busy} onClick={() => send(() => rotated(url, -90), 'Rotated')}>⟲ Rotate left</button>
        <button className="btn sm" disabled={busy} onClick={() => send(() => rotated(url, 90), 'Rotated')}>⟳ Rotate right</button>
        <button className="btn sm" disabled={busy} onClick={() => send(() => rotated(url, 180), 'Rotated')}>Turn round</button>
        <button className={`btn sm ${crop ? 'primary' : ''}`} onClick={() => { setCrop(!crop); setDrag(null); }}>✂ Crop</button>
        {crop && <button className="btn sm ok" disabled={!drag || busy} onClick={applyCrop}>Apply crop</button>}
        <span className="spacer" />
        <button className="btn sm" disabled={index === 0} onClick={() => move(page.id, index - 1)}>◀ Earlier</button>
        <button className="btn sm" disabled={index === count - 1} onClick={() => move(page.id, index + 1)}>Later ▶</button>
        {status?.scanner?.available && <button className="btn sm" disabled={busy} onClick={rescan}>Rescan</button>}
        {page.editedImage && <button className="btn sm" onClick={async () => { if (await run(() => api.post(`/scan/pages/${page.id}/restore-original`, {}), 'Original restored')) reload(); }}>Restore original</button>}
        <button className="btn sm danger" onClick={async () => { if (await run(() => api.post(`/scan/pages/${page.id}/delete`, { deleted: true }), 'Page removed')) reload(); }}>Delete</button>
      </div>
      {crop && <div className="small muted" style={{ marginBottom: 4 }}>Drag on the page to choose the part to keep, then Apply crop.</div>}
      <div className="row small" style={{ marginBottom: 4 }}>Zoom <input type="range" min={0.5} max={2.5} step={0.1} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} /></div>
      <div style={{ overflow: 'auto', maxHeight: '64vh', border: '1px solid var(--line)', background: '#f3f4f6' }}>
        <div style={{ position: 'relative', width: `${zoom * 100}%`, cursor: crop ? 'crosshair' : 'default' }}
          onMouseDown={(e) => { if (crop) { const p = pos(e); setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }); } }}
          onMouseMove={(e) => { if (crop && drag && e.buttons === 1) { const p = pos(e); setDrag({ ...drag, x1: p.x, y1: p.y }); } }}>
          <img ref={ref} src={url} alt={`Page ${index + 1}`} draggable={false} style={{ width: '100%', display: 'block', userSelect: 'none' }} />
          {crop && drag && <div style={{ position: 'absolute', left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0), border: '2px dashed var(--brand)', background: 'rgba(30,90,200,.12)', pointerEvents: 'none' }} />}
        </div>
      </div>
    </div>
  );
}

// --- step 2: read and review ---------------------------------------------------------------------
function ReviewTab({ d, status, reload }: { d: any; status: any; reload: () => void }) {
  const fields: FieldDef[] = status?.fields ?? [];
  const pages: any[] = d.pages.filter((p: any) => !p.deleted);
  const contracts = useContracts();
  const toast = useToast();
  const [sel, setSel] = useState('');
  const cur = pages.find((p) => p.id === sel) ?? pages[0];
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const { run } = useAction();
  const todo = pages.filter((p) => p.reading.status !== 'read');
  const readAll = async (list: any[], force = false) => {
    setProgress({ done: 0, total: list.length });
    let next = 0, done = 0;
    const worker = async () => {
      while (next < list.length) {
        const p = list[next++];
        try { await api.post(`/scan/pages/${p.id}/read`, { force }); } catch (e) { toast(errorText(e), true); }
        setProgress({ done: ++done, total: list.length });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    setProgress(null);
    reload();
  };
  const saveCell = async (readingId: string, key: string, value: string) => { await run(() => api.put(`/scan/readings/${readingId}`, { edited: { [key]: value } })); reload(); };
  const importXlsx = async (file: File | undefined) => {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    const r = await run(() => api.post<any>(`/scan/batches/${d.batch.id}/import`, fd));
    if (r) { toast(`Excel applied: ${r.changedCells} cell(s) changed in ${r.changedRows} row(s)${r.unknownRows.length ? `; ${r.unknownRows.length} unknown row(s) ignored` : ''}`); reload(); }
  };
  if (!pages.length) return <div className="empty">No pages in this batch.</div>;
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn primary" disabled={!!progress || !todo.length || !status?.ai?.configured} onClick={() => readAll(todo)}>{progress ? `Reading ${progress.done} / ${progress.total}…` : todo.length ? `Read ${todo.length} page(s) with AI` : 'All pages read'}</button>
        <button className="btn" disabled={!!progress || !status?.ai?.configured} onClick={() => confirm('Read every page again? Values you typed are kept.') && readAll(pages, true)}>Read all again</button>
        <span className="spacer" />
        <a className="btn" href={`/api/scan/batches/${d.batch.id}/export.xlsx`}>Download Excel</a>
        <label className="btn">Upload edited Excel<input type="file" accept=".xlsx" style={{ display: 'none' }} onChange={(e) => { importXlsx(e.target.files?.[0]); e.target.value = ''; }} /></label>
      </div>
      <div className="small muted" style={{ marginBottom: 6 }}>Values are shown as the AI read them. <span style={{ background: '#fff3cd', padding: '0 4px' }}>Amber</span> = unsure, check against the slip. Type over any value; <span style={{ background: '#e6f4ea', padding: '0 4px' }}>green</span> = corrected by you. Nothing becomes a duty until you save it in step 3.</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.7fr) minmax(260px, 1fr)', gap: 12 }}>
        <div className="scroll" style={{ maxHeight: '68vh' }}>
          <table className="t" style={{ minWidth: 2400 }}>
            <thead><tr><th>Pg</th><th>Status</th><th>Contract</th>{fields.map((f) => <th key={f.key}>{f.label}</th>)}</tr></thead>
            <tbody>
              {pages.map((p, i) => {
                const r = p.reading;
                return (
                  <tr key={p.id} onClick={() => setSel(p.id)} style={{ background: cur?.id === p.id ? 'var(--brand-soft)' : undefined }}>
                    <td><b>{i + 1}</b></td>
                    <td>{r.status === 'read' ? (r.dutyId ? <span className="badge ok" title="Saved as a duty">saved</span> : <span className="badge">read</span>) : r.status === 'failed' ? <span className="badge err" title={r.error}>failed</span> : <span className="badge warn">{r.status}</span>}</td>
                    <td><select value={r.contractId ?? ''} onChange={(e) => saveContract(r.id, e.target.value, run, reload)} style={{ maxWidth: 150 }}><option value="">Match by department</option>{(contracts.data ?? []).filter((k) => k.status === 'active').map((k) => <option key={k.id} value={k.id}>{k.client_name} — {k.reference_no}</option>)}</select></td>
                    {fields.map((f) => <Cell key={f.key + (r.edited?.[f.key] ?? '') + (r.fields?.[f.key]?.value ?? '')} def={f} value={r.values?.[f.key] ?? ''} edited={r.edited?.[f.key] !== undefined} confidence={r.fields?.[f.key]?.confidence ?? 1} onSave={(v) => saveCell(r.id, f.key, v)} />)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ position: 'sticky', top: 0, alignSelf: 'start' }}>
          {cur && <>
            <div className="row" style={{ marginBottom: 4 }}><b>Page {pages.indexOf(cur) + 1}</b>{cur.reading.notes && <span className="small" style={{ color: 'var(--warn)' }}>{cur.reading.notes}</span>}</div>
            {cur.reading.status === 'failed' && <div className="alert err">{cur.reading.error}</div>}
            <div style={{ overflow: 'auto', maxHeight: '60vh', border: '1px solid var(--line)' }}><img src={img(cur.fileId)} alt="Selected slip" style={{ width: '100%', display: 'block' }} /></div>
          </>}
        </div>
      </div>
    </>
  );
}
const saveContract = async (id: string, contractId: string, run: any, reload: () => void) => { await run(() => api.put(`/scan/readings/${id}`, { contractId: contractId || null })); reload(); };

function Cell({ def, value, edited, confidence, onSave }: { def: FieldDef; value: string; edited: boolean; confidence: number; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  const low = !edited && !!value && confidence < LOW;
  const wide = def.kind === 'text' && !['slip_no', 'vehicle_no', 'driver_mobile', 'signature'].includes(def.key);
  return (
    <td style={{ background: edited ? '#e6f4ea' : low ? '#fff3cd' : undefined, padding: 2 }} title={low ? `Unsure (${Math.round(confidence * 100)}%) — check against the slip` : undefined}>
      <input value={v} onChange={(e) => setV(e.target.value)} onBlur={() => { if (v !== value) onSave(v); }} style={{ width: wide ? 150 : 90, border: '1px solid transparent', background: 'transparent', padding: '3px 4px' }}
        onFocus={(e) => (e.target.style.borderColor = 'var(--brand)')} onBlurCapture={(e) => (e.target.style.borderColor = 'transparent')} aria-label={def.label} />
    </td>
  );
}

// --- step 3: save as duties, then bill -----------------------------------------------------------
function SaveTab({ d, reload }: { d: any; reload: () => void }) {
  const { run, busy } = useAction();
  const nav = useNavigate();
  const [dutyType, setDutyType] = useState('LOCAL');
  const [res, setRes] = useState<any>(null);
  const pages: any[] = d.pages.filter((p: any) => !p.deleted);
  const readCount = pages.filter((p) => p.reading.status === 'read').length;
  const body = (dryRun: boolean) => ({ defaultDutyType: dutyType.trim() || null, dryRun });
  const check = async () => { const r = await run(() => api.post(`/scan/batches/${d.batch.id}/save`, body(true))); if (r) setRes(r); };
  const save = async () => { const r = await run(() => api.post(`/scan/batches/${d.batch.id}/save`, body(false)), 'Duties saved'); if (r) { setRes(r); reload(); } };
  const label = (id: string) => `Page ${(pages.findIndex((p) => p.reading.id === id) + 1) || '?'}`;
  // Saved duties → one bill per contract and month
  const groups = useMemo(() => {
    const m = new Map<string, { contractId: string; month: string }>();
    for (const p of pages) { const duty = p.reading.duty; if (duty) { const month = String(duty.duty_date).slice(0, 7); m.set(`${duty.contract_id}|${month}`, { contractId: duty.contract_id, month }); } }
    return [...m.values()];
  }, [pages]);
  const contracts = useContracts();
  const makeBill = async (g: { contractId: string; month: string }) => {
    const [y, mo] = g.month.split('-').map(Number);
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const bill = await run(() => api.post<any>('/bills', { contract_id: g.contractId, period_start: `${g.month}-01`, period_end: `${g.month}-${String(last).padStart(2, '0')}` }));
    if (!bill) return;
    await run(() => api.post(`/bills/${bill.id}/calculate`, {}), 'Bill prepared — review it in the Billing Workspace');
    nav(`/billing/${bill.id}`);
  };
  return (
    <>
      <div className="alert info">Slips become duties only when you save them here. A slip that is already saved is updated, not added again; duties already on an approved bill are left as they are. {readCount} of {pages.length} page(s) have been read.</div>
      <div className="row">
        <Field label="Duty type for these slips" hint="Used to pick the rate; usually LOCAL"><input value={dutyType} onChange={(e) => setDutyType(e.target.value)} style={{ width: 160 }} /></Field>
        <button className="btn" disabled={busy || !readCount} onClick={check}>Check (nothing saved)</button>
        <button className="btn primary" disabled={busy || !readCount} onClick={save}>Save as duties</button>
      </div>
      {res && (
        <div style={{ marginTop: 10 }}>
          <div className="row">
            <span className="badge ok">{res.summary.add} new</span><span className="badge brand">{res.summary.update} updated</span><span className="badge">{res.summary.unchanged} no change</span>
            {res.summary.locked > 0 && <span className="badge warn">{res.summary.locked} on an approved bill</span>}
            {res.summary.error > 0 && <span className="badge err">{res.summary.error} need fixing</span>}
            {res.dryRun && <span className="small muted">Checked only — nothing was saved.</span>}
          </div>
          <table className="t" style={{ marginTop: 6 }}>
            <thead><tr><th>Page</th><th>Result</th><th>Notes</th></tr></thead>
            <tbody>{res.results.map((r: any) => (
              <tr key={r.readingId}><td>{label(r.readingId)}</td>
                <td><span className={`badge ${r.action === 'add' ? 'ok' : r.action === 'update' ? 'brand' : r.action === 'error' ? 'err' : r.action === 'locked' ? 'warn' : ''}`}>{({ add: 'New duty', update: 'Updated', unchanged: 'No change', locked: 'Locked', error: 'Fix first' } as any)[r.action]}</span></td>
                <td className="small">{r.problems.map((p: any, i: number) => <div key={i} style={{ color: p.severity === 'error' ? 'var(--err)' : 'var(--warn)' }}>{p.message}</div>)}
                  {(r.changes ?? []).map((c: any) => <div key={c.field}><b>{c.field}</b>: {c.from ?? '—'} → {c.to ?? '—'}</div>)}
                  {r.issues.map((i: any, k: number) => <div key={k} style={{ color: i.severity === 'error' ? 'var(--err)' : 'var(--warn)' }}>{i.message}</div>)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {groups.length > 0 && (
        <div className="panel" style={{ marginTop: 12 }}>
          <h3 style={{ marginTop: 0 }}>Prepare the bill</h3>
          <p className="small muted">Creates the bill for the month and calculates it from the approved rates. You then review, approve and export it in the Billing Workspace as usual; nothing is approved automatically.</p>
          {groups.map((g) => {
            const k = contracts.data?.find((x) => x.id === g.contractId);
            return <div key={g.contractId + g.month} className="row" style={{ marginBottom: 6 }}><span>{k ? `${k.client_name} — ${k.reference_no}` : 'Contract'} · {g.month}</span><button className="btn primary sm" disabled={busy} onClick={() => makeBill(g)}>Create &amp; calculate bill</button></div>;
          })}
          <div className="small muted">If a bill for that period already exists, open it from <Link to="/billing">Billing Workspace</Link>; new duties are picked up when you recalculate it.</div>
        </div>
      )}
    </>
  );
}
