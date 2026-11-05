/**
 * Rate card approval status, tax setting and the one-click catch-up for existing cards. Approval and fit are separate: a card can be
 * approved and still not fit a slip (the slip screens say exactly why), and a card is never compulsory for an invoice.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Confirm, Field, Modal, useAction } from './ui';

const today = () => new Date().toISOString().slice(0, 10);
export const taxLabel = (tax: any) => (!tax ? 'Tax not set' : tax.taxable ? (tax.rate ? `Taxable · GST ${tax.rate}% ${tax.mode === 'included' ? 'included' : 'extra'}` : 'Taxable · contract tax rules') : 'Non-taxable');
export const taxTone = (tax: any) => (!tax ? 'warn' : 'ok');

/** Approved / Pending / Inactive for a rate card (a scheme), from its versions. */
export function cardStatus(versions: any[]): 'Approved' | 'Pending' | 'Inactive' {
  const t = today();
  const live = (v: any) => !v.effective_to || v.effective_to >= t;
  if (versions.some((v) => v.status === 'approved' && live(v))) return 'Approved';
  if (versions.some((v) => ['pending_approval', 'draft'].includes(v.status) && live(v))) return 'Pending';
  return 'Inactive';
}

/** "Approve all existing rate cards": duplicates are retired, then every waiting (or draft) card still in force is approved by the person who presses it. */
export function ApproveExistingButton({ onDone }: { onDone: () => void }) {
  const { run, busy } = useAction();
  const [ask, setAsk] = useState(false);
  const [res, setRes] = useState<any>(null);
  const overlaps = (res?.skipped ?? []).filter((s: any) => /^Overlaps approved/.test(s.reason));
  return (
    <>
      <button className="btn ok" disabled={busy} title="Approves the existing active rate cards (waiting or still drafts). Rates, dates, vehicle categories and duty types are not changed." onClick={() => setAsk(true)}>Approve all existing rate cards</button>
      {ask && (
        <Confirm text="Approve every existing rate card that is waiting for approval or still a draft and not ended? Duplicate drafts are retired first. Nothing about the rates, dates, vehicle categories or duty types changes, and the approval is recorded as yours. Cards that cannot be approved (an overlap, a problem in the configuration, no duty type) are listed with the reason."
          yesLabel="Approve existing cards" onClose={() => setAsk(false)}
          onYes={async () => { setAsk(false); const r = await run(() => api.post<any>('/rate-versions/approve-existing', {})); if (r) { setRes(r); onDone(); } }} />
      )}
      {res && (
        <Modal title="Existing rate cards" onClose={() => setRes(null)} wide>
          <p><b>{res.approved}</b> approved{res.retiredDuplicates > 0 && <>, <b>{res.retiredDuplicates}</b> duplicate draft(s) retired</>}{res.skipped.length > 0 && <>, <b>{res.skipped.length}</b> left as they were</>}.</p>
          {overlaps.length > 0 && (
            <div className="row" style={{ margin: '8px 0' }}>
              <button className="btn danger" onClick={async () => {
                if (!confirm(`Reject all ${overlaps.length} versions that overlap an approved version? They stay in the history as Rejected.`)) return;
                if (await run(() => api.post('/rate-versions/reject-all', { ids: overlaps.map((s: any) => s.id), note: 'Overlaps an approved version of the same contract' }), 'Rejected')) { setRes(null); onDone(); }
              }}>Reject all {overlaps.length} that overlap</button>
              <span className="small muted">Check first that the approved card is the right one.</span>
            </div>
          )}
          {res.skipped.length > 0 && <ul className="small" style={{ maxHeight: 280, overflow: 'auto' }}>{res.skipped.slice(0, 80).map((s: any) => <li key={s.id}><Link to={`/rates/versions/${s.id}`}>{s.name}</Link> — {s.reason}</li>)}</ul>}
          <div className="row end"><button className="btn primary" onClick={() => setRes(null)}>Close</button></div>
        </Modal>
      )}
    </>
  );
}

type Kind = '' | 'taxable' | 'non';
interface Row { kind: Kind; rate: string; mode: 'extra' | 'included' }

/** Bulk tax setting: choose Taxable or Non-taxable for the cards that have none. Nothing is assumed: cards left unchanged keep their current behaviour. */
export function TaxConfigButton({ schemes, onDone }: { schemes: any[]; onDone: () => void }) {
  const { run, busy } = useAction();
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [bulk, setBulk] = useState<Row>({ kind: 'taxable', rate: '', mode: 'extra' });
  const t = today();
  const versions = useMemo(() => schemes.flatMap((s) => (s.versions ?? []).filter((v: any) => v.status !== 'retired' && v.status !== 'rejected' && (!v.effective_to || v.effective_to >= t)).map((v: any) => ({ ...v, scheme: s.name, client: s.client_name, contract: s.reference_no }))), [schemes, t]);
  const shown = versions.filter((v) => showAll || !v.tax);
  const get = (id: string): Row => rows[id] ?? { kind: '', rate: '', mode: 'extra' };
  const set = (id: string, p: Partial<Row>) => setRows((r) => ({ ...r, [id]: { ...get(id), ...p } }));
  const items = Object.entries(rows).filter(([, r]) => r.kind).map(([id, r]) => ({ id, taxable: r.kind === 'taxable', rate: r.kind === 'taxable' && r.rate ? r.rate : null, mode: r.mode }));
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)} title="Choose Taxable or Non-taxable for each rate card">Set tax for rate cards</button>
      {open && (
        <Modal title="Tax setting of rate cards" onClose={() => setOpen(false)} wide>
          <p className="small muted">Taxable (GST applicable) or Non-taxable (no GST). For a taxable card you can enter its GST % and say whether GST is included in the rate or added extra; with no GST % the contract's approved tax rules are used. Cards you leave unchanged keep behaving as they do now. Only the tax setting changes; rates, dates, vehicle categories and duty types never do.</p>
          <div className="row" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
            <b>Set all {shown.length} shown to</b>
            <select value={bulk.kind} onChange={(e) => setBulk({ ...bulk, kind: e.target.value as Kind })}><option value="taxable">Taxable (GST applicable)</option><option value="non">Non-taxable (GST not applicable)</option></select>
            {bulk.kind === 'taxable' && <><input placeholder="GST %" inputMode="decimal" value={bulk.rate} onChange={(e) => setBulk({ ...bulk, rate: e.target.value })} style={{ width: 80 }} /><select value={bulk.mode} onChange={(e) => setBulk({ ...bulk, mode: e.target.value as Row['mode'] })}><option value="extra">GST extra</option><option value="included">GST included</option></select></>}
            <button className="btn sm" onClick={() => setRows((r) => ({ ...r, ...Object.fromEntries(shown.map((v) => [v.id, bulk])) }))}>Apply to all shown</button>
            <span className="spacer" />
            <label className="check"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />Also show cards that already have a tax setting</label>
          </div>
          <div className="scroll" style={{ maxHeight: '50vh' }}>
            <table className="t">
              <thead><tr><th>Department / contract</th><th>Rate card</th><th>Status</th><th>Now</th><th>Set to</th></tr></thead>
              <tbody>
                {shown.map((v) => {
                  const r = get(v.id);
                  return (
                    <tr key={v.id}>
                      <td>{v.client}<div className="small muted">{v.contract}</div></td><td><Link to={`/rates/versions/${v.id}`}>{v.scheme}</Link> <span className="small muted">v{v.version_no}</span></td><td>{v.status === 'approved' ? 'Approved' : 'Pending'}</td>
                      <td><span className={`badge ${taxTone(v.tax)}`}>{taxLabel(v.tax)}</span></td>
                      <td className="nowrap">
                        <select value={r.kind} onChange={(e) => set(v.id, { kind: e.target.value as Kind })}><option value="">Leave as it is</option><option value="taxable">Taxable</option><option value="non">Non-taxable</option></select>
                        {r.kind === 'taxable' && <> <input placeholder="GST %" inputMode="decimal" value={r.rate} onChange={(e) => set(v.id, { rate: e.target.value })} style={{ width: 64 }} /> <select value={r.mode} onChange={(e) => set(v.id, { mode: e.target.value as Row['mode'] })}><option value="extra">extra</option><option value="included">included</option></select></>}
                      </td>
                    </tr>
                  );
                })}
                {shown.length === 0 && <tr><td colSpan={5} className="empty">Every rate card has a tax setting.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="row end" style={{ marginTop: 10 }}>
            <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn primary" disabled={busy || !items.length} onClick={async () => { if (await run(() => api.post('/rate-versions/tax-config', { items }), `Tax setting saved for ${items.length} rate card(s)`)) { setRows({}); setOpen(false); onDone(); } }}>Save tax setting ({items.length})</button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** The tax setting of one rate card, on its own page. A draft is saved with the rest of the card; an approved card saves just this setting. */
export function TaxPanel({ cfg, editable, status, canApprove, versionId, upd, reload }: { cfg: any; editable: boolean; status: string; canApprove: boolean; versionId: string; upd: (fn: (c: any) => void) => void; reload: () => void }) {
  const { run, busy } = useAction();
  const cur = cfg.tax;
  const [local, setLocal] = useState<Row>({ kind: cur ? (cur.taxable ? 'taxable' : 'non') : '', rate: cur?.rate ?? '', mode: cur?.mode ?? 'extra' });
  const asTax = (r: Row) => (r.kind === '' ? undefined : r.kind === 'non' ? { taxable: false, mode: 'extra' } : { taxable: true, ...(r.rate ? { rate: r.rate } : {}), mode: r.mode });
  const change = (p: Partial<Row>) => { const n = { ...local, ...p }; setLocal(n); if (editable) upd((c) => { const t = asTax(n); if (t) c.tax = t; else delete c.tax; }); };
  const canEditTax = editable || (status === 'approved' && canApprove);
  return (
    <div className="panel">
      <h2>Tax (GST)</h2>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <Field label="Tax setting of this rate card">
          <select value={local.kind} disabled={!canEditTax} onChange={(e) => change({ kind: e.target.value as Kind })}>
            <option value="">Not set (the contract's approved tax rules apply)</option><option value="taxable">Taxable (GST applicable)</option><option value="non">Non-taxable (GST not applicable)</option>
          </select>
        </Field>
        {local.kind === 'taxable' && <>
          <Field label="GST %" hint="Blank = the contract's approved tax rules"><input value={local.rate} disabled={!canEditTax} inputMode="decimal" onChange={(e) => change({ rate: e.target.value })} style={{ width: 90 }} /></Field>
          <Field label="GST is"><select value={local.mode} disabled={!canEditTax} onChange={(e) => change({ mode: e.target.value as Row['mode'] })}><option value="extra">Charged extra</option><option value="included">Included in the rate</option></select></Field>
        </>}
        {!editable && status === 'approved' && canApprove && <button className="btn primary" disabled={busy || !local.kind} onClick={async () => { if (await run(() => api.post('/rate-versions/tax-config', { items: [{ id: versionId, taxable: local.kind === 'taxable', rate: local.kind === 'taxable' && local.rate ? local.rate : null, mode: local.mode }] }), 'Tax setting saved')) reload(); }}>Save tax setting</button>}
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>Non-taxable: no GST is added and the invoice shows Non-Taxable. Taxable: GST is calculated on the taxable charges (not on toll, parking and other reimbursements) and carried onto every invoice that uses this card. The tax setting of an approved card can still be set; its rates and dates cannot.</p>
    </div>
  );
}
