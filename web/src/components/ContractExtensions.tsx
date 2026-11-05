/**
 * Contract extensions: upload the extension letter, check the dates the software read from it, correct them, and apply.
 * The contract changes only when a person presses "Approve & Apply Contract Extension".
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { Confirm, ErrorBox, Field, Loading, Status, useAction } from './ui';
import { d } from '../format';

const LOW = 0.6;
const FIELDS: { key: string; label: string; src: string; kind: 'text' | 'date' | 'area' }[] = [
  { key: 'letter_no', label: 'Extension letter number', src: 'letter_no', kind: 'text' },
  { key: 'letter_date', label: 'Letter issue date', src: 'letter_date', kind: 'date' },
  { key: 'department_name', label: 'Department (as in the letter)', src: 'department_name', kind: 'text' },
  { key: 'contract_reference', label: 'Contract / GeM bid / work order no.', src: 'contract_reference', kind: 'text' },
  { key: 'previous_end_date', label: 'Contract end date stated in the letter', src: 'existing_end_date', kind: 'date' },
  { key: 'extension_start', label: 'Extension start date', src: 'extension_start', kind: 'date' },
  { key: 'new_end_date', label: 'New extended end date', src: 'new_end_date', kind: 'date' },
  { key: 'remarks', label: 'Special conditions / remarks', src: 'remarks', kind: 'area' },
];

export function ContractExtensions({ contractId, onChanged }: { contractId: string; onChanged: () => void }) {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['contract-extensions', contractId], queryFn: () => api.get<any>(`/contracts/${contractId}/extensions`) });
  const { run, busy } = useAction();
  const reload = () => { q.refetch(); onChanged(); };
  const upload = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f);
    if (await run(() => api.post(`/contracts/${contractId}/extensions`, fd), 'Letter uploaded. Check the dates below.')) reload();
  };
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const s = q.data;
  const k = s.contract;
  return (
    <>
      <div className="grid g4" style={{ marginBottom: 12 }}>
        <div className="panel"><div className="small muted">Original contract period</div><b>{d(k.startDate)} – {k.originalEndDate ? d(k.originalEndDate) : 'open'}</b></div>
        <div className="panel"><div className="small muted">Current end date</div><b style={{ fontSize: 18 }}>{k.currentEndDate ? d(k.currentEndDate) : 'open'}</b> <Status s={k.status} /></div>
        <div className="panel"><div className="small muted">Total extension added</div><b>{s.totalAdded ? s.totalAdded.text : 'None yet'}</b></div>
        <div className="panel"><div className="small muted">Total contract validity</div><b>{s.totalValidity ? s.totalValidity.text : '—'}</b></div>
      </div>
      {can('client.write') && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Upload an extension letter</h3>
          <p className="small muted">Upload the department's extension letter (PDF, JPG or PNG). The software reads the dates and shows them for you to check; the contract does not change until you approve.
            {!s.reader.available && <b style={{ color: 'var(--warn)' }}> AI reading is off here, so type the dates in by hand after uploading.</b>}</p>
          <label className="btn primary">Choose extension letter<input type="file" accept=".pdf,.jpg,.jpeg,.png" style={{ display: 'none' }} disabled={busy} onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} /></label>
        </div>
      )}
      {s.extensions.length === 0 && <div className="panel empty">No extension letters yet.</div>}
      {[...s.extensions].reverse().map((e: any) => <ExtensionCard key={e.id} e={e} summary={s} canWrite={can('client.write')} reload={reload} />)}
    </>
  );
}

function ExtensionCard({ e, summary, canWrite, reload }: { e: any; summary: any; canWrite: boolean; reload: () => void }) {
  const pending = e.status === 'pending';
  const [f, setF] = useState<Record<string, string>>({});
  const [ack, setAck] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [live, setLive] = useState<any>(e);
  const { run, busy } = useAction();
  useEffect(() => { setF(Object.fromEntries(FIELDS.map((x) => [x.key, e[x.key] ?? '']))); setLive(e); setAck(false); }, [e]);
  const conf = (src: string) => (e.extracted?.[src]?.value ? e.extracted[src].confidence : null);
  const corrected = (x: (typeof FIELDS)[number]) => (e[x.key] ?? '') !== (e.extracted?.[x.src]?.value ?? '');
  const save = async () => {
    const r = await run(() => api.put(`/contract-extensions/${e.id}`, Object.fromEntries(FIELDS.map((x) => [x.key, f[x.key] || null]))), 'Saved');
    if (r) setLive(r);
    return r;
  };
  const apply = async () => {
    const saved = await save();
    if (!saved) return;
    if (await run(() => api.post(`/contract-extensions/${e.id}/apply`, { acknowledge: ack }), 'Extension applied. The contract now runs to the new end date.')) reload();
  };
  const conflicts: { severity: string; message: string }[] = live.conflicts ?? [];
  const blocked = conflicts.some((c) => c.severity === 'error');
  const warned = conflicts.some((c) => c.severity === 'warning');
  const dur = live.duration;
  return (
    <div className="panel" style={{ borderLeft: `4px solid ${pending ? '#fab219' : e.status === 'applied' ? '#0ca30c' : '#c3c2b7'}` }}>
      <div className="row">
        <b>{e.letter_no ? `Letter ${e.letter_no}` : e.file_name}</b>
        <Status s={pending ? 'pending_approval' : e.status} />
        <span className="small muted">uploaded {d(String(e.uploaded_at).slice(0, 10))}{e.uploaded_by_name ? ` by ${e.uploaded_by_name}` : ''}</span>
        <span className="spacer" />
        <a className="btn sm" href={`/api/contract-extensions/${e.id}/file`}>Download letter</a>
      </div>
      {pending && e.read_error && <div className="alert warn" style={{ marginTop: 8 }}>{e.read_error}</div>}
      {pending ? (
        <>
          <p className="small muted" style={{ margin: '8px 0' }}><span style={{ background: '#fff3cd', padding: '0 4px' }}>Amber</span> = the software is unsure, check against the letter. <span style={{ background: '#e6f4ea', padding: '0 4px' }}>Green</span> = corrected by you.</p>
          <div className="grid g4">
            {FIELDS.map((x) => {
              const c = conf(x.src);
              const bg = corrected(x) && (f[x.key] ?? '') !== (e[x.key] ?? '') ? '#e6f4ea' : corrected(x) ? '#e6f4ea' : c !== null && c < LOW ? '#fff3cd' : undefined;
              return (
                <Field key={x.key} label={x.label}>
                  {x.kind === 'area'
                    ? <textarea rows={2} value={f[x.key] ?? ''} onChange={(ev) => setF({ ...f, [x.key]: ev.target.value })} style={{ background: bg }} />
                    : <input type={x.kind === 'date' ? 'date' : 'text'} value={f[x.key] ?? ''} onChange={(ev) => setF({ ...f, [x.key]: ev.target.value })} style={{ background: bg }} />}
                </Field>
              );
            })}
          </div>
          <div className="panel" style={{ background: '#f7f9fc', marginTop: 8 }}>
            <b>Extension summary</b>
            <div className="grid g4" style={{ marginTop: 6 }}>
              <div><div className="small muted">Original contract start</div>{d(summary.contract.startDate)}</div>
              <div><div className="small muted">Contract end date now</div>{summary.contract.currentEndDate ? d(summary.contract.currentEndDate) : '—'}</div>
              <div><div className="small muted">Extension starts</div>{f.extension_start ? d(f.extension_start) : summary.contract.currentEndDate ? `${d(new Date(Date.parse(summary.contract.currentEndDate) + 86_400_000).toISOString().slice(0, 10))} (day after)` : '—'}</div>
              <div><div className="small muted">New end date</div><b>{f.new_end_date ? d(f.new_end_date) : '—'}</b></div>
              <div><div className="small muted">Additional period</div><b>{dur ? dur.text : '—'}</b></div>
              <div><div className="small muted">Uploaded letter</div>{e.file_name}</div>
            </div>
          </div>
          {conflicts.map((c, i) => <div key={i} className={`alert ${c.severity === 'error' ? 'err' : 'warn'}`} style={{ marginTop: 6 }}>{c.severity === 'error' ? 'Cannot apply: ' : 'Please check: '}{c.message}</div>)}
          {canWrite && (
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn" disabled={busy} onClick={() => void save()}>Save corrections</button>
              {warned && !blocked && <label className="check"><input type="checkbox" checked={ack} onChange={(ev) => setAck(ev.target.checked)} />I have checked these points against the letter</label>}
              <button className="btn ok" disabled={busy || blocked || (warned && !ack)} onClick={apply}>Approve &amp; Apply Contract Extension</button>
              <button className="btn danger" disabled={busy} onClick={() => setRejecting(true)}>Reject</button>
            </div>
          )}
        </>
      ) : (
        <div className="grid g4" style={{ marginTop: 8 }}>
          <div><div className="small muted">Letter date</div>{e.letter_date ? d(e.letter_date) : '—'}</div>
          <div><div className="small muted">Extended from → to</div>{e.status === 'applied' ? `${d(e.applied_prev_end)} → ` : ''}<b>{e.new_end_date ? d(e.new_end_date) : '—'}</b></div>
          <div><div className="small muted">Additional period</div>{e.duration ? e.duration.text : '—'}</div>
          <div><div className="small muted">{e.status === 'applied' ? 'Applied by' : 'Rejected'}</div>{e.status === 'applied' ? `${e.applied_by_name ?? ''} · ${d(String(e.applied_at).slice(0, 10))}` : e.rejected_reason}</div>
          {e.remarks && <div style={{ gridColumn: '1 / -1' }}><div className="small muted">Remarks</div>{e.remarks}</div>}
        </div>
      )}
      {rejecting && <Confirm text="Reject this extension letter? The contract stays as it is." needReason="Reason" yesLabel="Reject" danger onClose={() => setRejecting(false)} onYes={async (reason) => { setRejecting(false); if (await run(() => api.post(`/contract-extensions/${e.id}/reject`, { reason }), 'Rejected')) reload(); }} />}
    </div>
  );
}
