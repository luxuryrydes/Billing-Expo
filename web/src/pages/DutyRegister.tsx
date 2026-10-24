import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, downloadBlob, qs } from '../api';
import { useAuth } from '../auth';
import { Confirm, ErrorBox, Loading, Modal, PageHead, Status, useAction } from '../components/ui';
import { d, dt, inr, monthRange, thisMonth } from '../format';
import { useClients, useContracts } from '../lookups';

export function DutyRegisterPage() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const m = monthRange(thisMonth());
  const filters = {
    clientId: sp.get('clientId') ?? '', contractId: sp.get('contractId') ?? '', from: sp.get('from') ?? (sp.get('createdToday') || sp.get('status') || sp.get('issues') ? '' : m.from),
    to: sp.get('to') ?? (sp.get('createdToday') || sp.get('status') || sp.get('issues') ? '' : m.to), vehicle: sp.get('vehicle') ?? '', driver: sp.get('driver') ?? '',
    status: sp.get('status') ?? '', billing: sp.get('billing') ?? '', issues: sp.get('issues') ?? '', createdToday: sp.get('createdToday') ?? '', page: Number(sp.get('page') ?? 1),
  };
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); if (k !== 'page') n.delete('page'); if (!n.has('from') && k !== 'from') n.set('from', filters.from); if (!n.has('to') && k !== 'to') n.set('to', filters.to); setSp(n); };
  const clients = useClients();
  const contracts = useContracts(filters.clientId || undefined);
  const q = useQuery({ queryKey: ['duties', filters], queryFn: () => api.get(`/duties${qs({ ...filters, pageSize: 200 })}`) });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<string | null>(null);
  const { run, busy } = useAction();
  const rows: any[] = q.data?.rows ?? [];
  const pages = Math.ceil((q.data?.total ?? 0) / 200);
  const verify = async () => {
    const r = await run(() => api.post('/duties/verify', { ids: [...sel] }));
    if (r) { alert(`${r.verified} duty row(s) verified.${r.blockedByErrors ? ` ${r.blockedByErrors} could not be verified because they have errors.` : ''}`); setSel(new Set()); q.refetch(); }
  };
  const exportXlsx = async () => {
    if (!filters.from || !filters.to) { alert('Choose a date range to export'); return; }
    const b = await run(() => api.blob('GET', `/reports/duty-register.xlsx${qs({ from: filters.from, to: filters.to, clientId: filters.clientId, contractId: filters.contractId })}`));
    if (b) downloadBlob(b, `duty-register_${filters.from}_${filters.to}.xlsx`);
  };
  return (
    <>
      <PageHead title="Duty Register" sub={`${q.data?.total ?? 0} duties`}>
        {can('duty.verify') && <button className="btn" disabled={!sel.size || busy} onClick={verify}>Verify selected ({sel.size})</button>}
        {can('export') && <button className="btn" onClick={exportXlsx}>Export Excel</button>}
        <Link className="btn primary" to="/duties/entry">Enter duties</Link>
      </PageHead>
      <div className="panel row">
        <select value={filters.clientId} onChange={(e) => set('clientId', e.target.value)}><option value="">All departments</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <select value={filters.contractId} onChange={(e) => set('contractId', e.target.value)}><option value="">All contracts</option>{contracts.data?.map((k) => <option key={k.id} value={k.id}>{k.reference_no}</option>)}</select>
        <input type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} /> – <input type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} />
        <input placeholder="Vehicle no." value={filters.vehicle} onChange={(e) => set('vehicle', e.target.value)} style={{ width: 120 }} />
        <input placeholder="Driver" value={filters.driver} onChange={(e) => set('driver', e.target.value)} style={{ width: 120 }} />
        <select value={filters.status} onChange={(e) => set('status', e.target.value)}><option value="">Any status</option><option value="entered">Entered</option><option value="verified">Verified</option><option value="billed">Billed</option><option value="void">Void</option></select>
        <select value={filters.billing} onChange={(e) => set('billing', e.target.value)}><option value="">Billed or not</option><option value="billed">On a bill</option><option value="unbilled">Not on a bill</option></select>
        <select value={filters.issues} onChange={(e) => set('issues', e.target.value)}><option value="">Any validation</option><option value="errors">With errors</option><option value="warnings">With warnings</option><option value="clean">Clean</option></select>
        {filters.createdToday && <span className="badge brand">Entered today <button className="btn link" onClick={() => set('createdToday', '')}>✕</button></span>}
      </div>
      <ErrorBox error={q.error} />
      <div className="panel tight">
        {q.isLoading ? <Loading /> : (
          <div className="scroll">
            <table className="t">
              <thead><tr>
                <th><input type="checkbox" checked={rows.length > 0 && rows.every((r) => sel.has(r.id))} onChange={(e) => setSel(e.target.checked ? new Set(rows.filter((r) => r.status === 'entered').map((r) => r.id)) : new Set())} /></th>
                <th>Date</th><th>Department</th><th>Vehicle</th><th>Type</th><th>Driver</th><th>Officer</th><th className="num">Start km</th><th className="num">Close km</th><th className="num">Km</th><th>Start</th><th>Close</th><th className="num">Toll+Park</th><th>Status</th><th>Issues</th><th>Bill</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => {
                  const km = r.startKm != null && r.endKm != null ? (Math.round((Number(r.endKm) - Number(r.startKm)) * 10) / 10).toString() : '';
                  const exp = r.toll || r.parking ? inr(String((Math.round(Number(r.toll ?? 0) * 100) + Math.round(Number(r.parking ?? 0) * 100)) / 100)) : '';
                  return (
                    <tr key={r.id} className="clickable" onClick={() => setDetail(r.id)}>
                      <td onClick={(e) => e.stopPropagation()}><input type="checkbox" disabled={r.status !== 'entered'} checked={sel.has(r.id)} onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(r.id); else n.delete(r.id); setSel(n); }} /></td>
                      <td className="nowrap">{d(r.dutyDate)}</td><td>{r.clientName}<div className="small muted">{r.contractRef}</div></td><td className="mono">{r.vehicleRegNo}</td><td>{r.vehicleCategoryName}</td><td>{r.driverName}</td><td>{r.fieldOfficer}</td>
                      <td className="num">{r.startKm}</td><td className="num">{r.endKm}</td><td className="num">{km}</td><td className="nowrap small">{dt(r.startAt)}</td><td className="nowrap small">{dt(r.endAt)}</td><td className="num">{exp}</td>
                      <td><Status s={r.status} /></td>
                      <td>{r.errorCount > 0 && <span className="badge err" title={r.issues.map((x: any) => x.message).join('\n')}>{r.errorCount} error</span>} {r.warningCount > 0 && <span className="badge warn" title={r.issues.map((x: any) => x.message).join('\n')}>{r.warningCount} warn</span>}</td>
                      <td onClick={(e) => e.stopPropagation()}>{r.billId && <Link to={`/billing/${r.billId}`}>{r.billNo ?? 'draft'}</Link>}</td>
                    </tr>
                  );
                })}
                {rows.length === 0 && <tr><td colSpan={16} className="empty">No duties match these filters.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {pages > 1 && <div className="row">{Array.from({ length: pages }, (_, i) => <button key={i} className={`btn sm ${filters.page === i + 1 ? 'primary' : ''}`} onClick={() => set('page', String(i + 1))}>{i + 1}</button>)}</div>}
      {detail && <DutyDetail id={detail} onClose={() => { setDetail(null); q.refetch(); }} />}
    </>
  );
}

function DutyDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['duty', id], queryFn: () => api.get(`/duties/${id}`) });
  const [voiding, setVoiding] = useState(false);
  const { run } = useAction();
  return (
    <Modal title="Duty details" onClose={onClose} wide>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (() => {
        const r = q.data;
        return (
          <>
            <div className="grid g3">
              <div><b>{d(r.dutyDate)}</b> · {r.clientName}<div className="small muted">{r.contractRef} · {r.source}</div></div>
              <div><span className="mono">{r.vehicleRegNo}</span> ({r.vehicleCategoryName ?? 'no category'}) · {r.dutyTypeCode}<div className="small">{r.driverName} · {r.fieldOfficer}</div></div>
              <div><Status s={r.status} /> {r.billNo && <>on bill <Link to={`/billing/${r.billId}`}>{r.billNo}</Link></>}</div>
              <div>Km: {r.startKm} → {r.endKm}</div><div>Time: {dt(r.startAt)} → {dt(r.endAt)}</div><div>Toll {inr(r.toll)} · Parking {inr(r.parking)} · Other {inr(r.otherCharges)}</div>
              <div>Slip / doc: {r.supportingDocRef || '—'}</div><div>Remarks: {r.remarks || '—'}</div><div>{Object.entries(r.customFields ?? {}).map(([k, v]) => `${k}: ${v}`).join(' · ')}</div>
            </div>
            {r.issues.length > 0 && <div className="alert warn" style={{ marginTop: 10 }}>{r.issues.map((x: any) => `${x.severity === 'error' ? 'Error' : 'Warning'}: ${x.message}`).join('\n')}</div>}
            <h3 style={{ marginTop: 12 }}>History</h3>
            <table className="t"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Changes</th><th>Reason</th></tr></thead>
              <tbody>{r.history.map((h: any) => (
                <tr key={h.id}><td className="nowrap">{dt(h.at)}</td><td>{h.user_name}</td><td>{h.action}</td>
                  <td className="small mono">{h.after && h.before ? Object.keys(h.after).map((k) => `${k}: ${JSON.stringify(h.before[k])} → ${JSON.stringify(h.after[k])}`).join('\n') : ''}</td><td>{h.note}</td></tr>
              ))}</tbody></table>
            <div className="row end" style={{ marginTop: 12 }}>
              <Link className="btn" to={`/duties/entry`}>Edit in duty entry</Link>
              {can('duty.write') && r.status !== 'void' && !r.billId && <button className="btn danger" onClick={() => setVoiding(true)}>Void duty</button>}
            </div>
            {voiding && <Confirm text="Void this duty? It stays in the register for audit but is never billed." needReason="Reason" danger yesLabel="Void" onClose={() => setVoiding(false)}
              onYes={async (reason) => { if (await run(() => api.post(`/duties/${id}/void`, { reason }), 'Duty voided')) { setVoiding(false); onClose(); } }} />}
          </>
        );
      })()}
    </Modal>
  );
}
