/**
 * Create Invoice – Department Wise: pick a department, contract, rate card and month, review the saved duties and the summary,
 * and generate one invoice (a draft bill that goes through the normal review, approval and export). Departments and contracts
 * are never mixed, and a duty already on a bill cannot be selected.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { useClients, useContracts } from '../lookups';
import { ErrorBox, Field, Status, useAction, useToast } from './ui';
import { d as fmtDate, inr } from '../format';

const monthEnd = (m: string) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
const STATE: Record<string, { label: string; cls: string }> = { unbilled: { label: 'Unbilled', cls: 'ok' }, cancelled: { label: 'Unbilled (earlier bill cancelled)', cls: 'ok' }, draft: { label: 'On a draft bill', cls: 'warn' }, billed: { label: 'Billed', cls: '' } };

export function DeptInvoice({ batch }: { batch: any }) {
  const clients = useClients();
  const allContracts = useContracts();
  const toast = useToast();
  const { run, busy } = useAction();
  const [clientId, setClientId] = useState('');
  const [contractId, setContractId] = useState('');
  const [schemeId, setSchemeId] = useState('');
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [taxMode, setTaxMode] = useState<'contract' | 'non_taxable' | 'custom'>('contract');
  const [taxRate, setTaxRate] = useState('');
  const [taxIncl, setTaxIncl] = useState(false);
  const [editing, setEditing] = useState<Set<string>>(new Set());
  const [made, setMade] = useState<{ label: string; billId?: string; error?: string }[]>([]);
  const contracts = (allContracts.data ?? []).filter((k) => k.client_id === clientId && k.status !== 'terminated');

  // The departments, contracts and months of the duties saved from this batch, as shortcuts.
  const groups = useMemo(() => {
    const m = new Map<string, { contractId: string; clientId: string; month: string; n: number }>();
    for (const p of batch.pages.filter((x: any) => !x.deleted)) {
      const duty = p.reading.duty;
      if (!duty) continue;
      const k = allContracts.data?.find((c) => c.id === duty.contract_id);
      if (!k) continue;
      const mo = String(duty.duty_date).slice(0, 7);
      const key = `${k.id}|${mo}`;
      m.set(key, { contractId: k.id, clientId: k.client_id, month: mo, n: (m.get(key)?.n ?? 0) + 1 });
    }
    return [...m.values()];
  }, [batch.pages, allContracts.data]);

  /** Tax on amounts entered by hand (no rate card). Cards that carry their own tax setting use it. */
  const manualTax = useMemo(() => (taxMode === 'contract' ? null : taxMode === 'non_taxable' ? { mode: 'non_taxable' as const } : { mode: 'custom' as const, rate: taxRate, included: taxIncl }), [taxMode, taxRate, taxIncl]);
  const taxReady = taxMode !== 'custom' || /^\d+(\.\d+)?$/.test(taxRate);
  const params = contractId ? { contractId, periodStart: `${month}-01`, periodEnd: monthEnd(month), schemeId: schemeId || undefined, manualTax: manualTax && taxReady ? JSON.stringify(manualTax) : undefined } : null;
  const list = useQuery({ queryKey: ['inv-duties', params], enabled: !!params, queryFn: () => api.get<any>(`/invoice-builder/duties${qs(params!)}`) });
  const cards = useQuery({ queryKey: ['scan-rate-cards', contractId], enabled: !!contractId, queryFn: () => api.get<any[]>(`/scan/rate-cards?contractIds=${contractId}`) });
  const duties: any[] = list.data?.duties ?? [];
  const ids = [...sel].sort();
  const summary = useQuery({
    queryKey: ['inv-summary', contractId, month, ids, manualTax], enabled: !!contractId && ids.length > 0 && taxReady,
    queryFn: () => api.post<any>('/invoice-builder/summary', { contractId, periodStart: `${month}-01`, periodEnd: monthEnd(month), dutyIds: ids, manualTax: manualTax && taxReady ? manualTax : null }),
  });
  useEffect(() => { setSel(new Set()); }, [contractId, month, schemeId]);

  const pick = (g: { contractId: string; clientId: string; month: string }) => { setClientId(g.clientId); setContractId(g.contractId); setMonth(g.month); setSchemeId(''); };
  const eligible = duties.filter((x) => x.eligible);
  const generate = async () => {
    const r = await run(() => api.post<any>('/invoice-builder/generate', { contractId, periodStart: `${month}-01`, periodEnd: monthEnd(month), dutyIds: ids, manualTax: manualTax && taxReady ? manualTax : null }));
    if (!r) return;
    const k = allContracts.data?.find((c) => c.id === contractId);
    setMade((m) => [...m, { label: `${k?.client_name ?? 'Department'} — ${k?.reference_no ?? ''} · ${month} · ${r.duties} duties · ₹${inr(r.totals.grandTotal)}`, billId: r.billId }]);
    toast('Invoice created. Open it to review and approve.');
    setSel(new Set());
    void list.refetch();
  };
  /** One invoice per department, contract and month for everything this batch saved and is still unbilled. */
  const generateAll = async () => {
    for (const g of groups) {
      const k = allContracts.data?.find((c) => c.id === g.contractId);
      const label = `${k?.client_name ?? ''} — ${k?.reference_no ?? ''} · ${g.month}`;
      try {
        const l = await api.get<any>(`/invoice-builder/duties${qs({ contractId: g.contractId, periodStart: `${g.month}-01`, periodEnd: monthEnd(g.month) })}`);
        const okIds = l.duties.filter((x: any) => x.eligible).map((x: any) => x.id);
        if (!okIds.length) { setMade((m) => [...m, { label, error: 'Nothing eligible to bill (already billed or needs an approved rate).' }]); continue; }
        const r = await api.post<any>('/invoice-builder/generate', { contractId: g.contractId, periodStart: `${g.month}-01`, periodEnd: monthEnd(g.month), dutyIds: okIds, manualTax: manualTax && taxReady ? manualTax : null });
        setMade((m) => [...m, { label: `${label} · ${r.duties} duties · ₹${inr(r.totals.grandTotal)}`, billId: r.billId }]);
      } catch (e) { setMade((m) => [...m, { label, error: (e as Error).message }]); }
    }
    void list.refetch();
  };
  const setManual = async (id: string, v: string) => {
    const r = await run(() => api.put(`/invoice-builder/duties/${id}/manual-amount`, { amount: v === '' ? null : v.trim() }), v === '' ? 'Amount cleared' : 'Amount saved');
    if (r) { setEditing(new Set()); void list.refetch(); void summary.refetch(); }
  };
  const s = summary.data;

  return (
    <div>
      {groups.length > 0 && (
        <div className="panel" style={{ marginBottom: 8 }}>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <b>Saved from this batch</b>
            {groups.map((g) => { const k = allContracts.data?.find((c) => c.id === g.contractId); return <button key={g.contractId + g.month} className="btn sm" onClick={() => pick(g)}>{k?.client_name} — {k?.reference_no} · {g.month} ({g.n})</button>; })}
            <span className="spacer" />
            <button className="btn" disabled={busy} onClick={() => confirm(`Create one invoice for each of the ${groups.length} department/contract/month group(s) above, using all their eligible unbilled duties? Departments are never combined.`) && void generateAll()}>Generate invoices for all departments</button>
          </div>
        </div>
      )}
      {made.length > 0 && (
        <div className="alert info">
          <b>Invoices created</b> <span className="small muted">— open an invoice, send it for review and approve it, then use Generate there to get the Excel and PDF.</span>
          <ul style={{ margin: '4px 0 0 16px' }}>{made.map((m, i) => <li key={i}>{m.error ? <span style={{ color: 'var(--err)' }}>{m.label}: {m.error}</span> : <>{m.label} — <Link to={`/billing/${m.billId}`}>open invoice</Link></>}</li>)}</ul>
        </div>
      )}
      <div className="grid g4">
        <Field label="Department"><select value={clientId} onChange={(e) => { setClientId(e.target.value); setContractId(''); setSchemeId(''); }}><option value="">Select…</option>{(clients.data ?? []).filter((c) => c.status === 'active').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Contract"><select value={contractId} onChange={(e) => { setContractId(e.target.value); setSchemeId(''); }} disabled={!clientId}><option value="">Select…</option>{contracts.map((k) => <option key={k.id} value={k.id}>{k.reference_no} — {k.title}</option>)}</select></Field>
        <Field label="Rate card (optional)" hint="Not needed: duties can use their automatic rate or an amount you enter"><select value={schemeId} onChange={(e) => setSchemeId(e.target.value)} disabled={!contractId}><option value="">No rate card selected</option>{[...new Map((cards.data ?? []).map((c) => [c.scheme_id, c])).values()].map((c) => <option key={c.scheme_id} value={c.scheme_id}>{c.name}</option>)}</select></Field>
        <Field label="Billing month"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
      </div>
      <div className="panel" style={{ marginTop: 8 }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <b>Tax on amounts you enter by hand</b>
          <select value={taxMode} onChange={(e) => setTaxMode(e.target.value as typeof taxMode)} aria-label="Tax for amounts entered by hand">
            <option value="contract">Use the contract's approved tax rules</option><option value="non_taxable">Non-taxable (no GST)</option><option value="custom">Taxable at a GST % I enter</option>
          </select>
          {taxMode === 'custom' && <><input placeholder="GST %" inputMode="decimal" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} style={{ width: 80 }} /><select value={taxIncl ? 'in' : 'ex'} onChange={(e) => setTaxIncl(e.target.value === 'in')}><option value="ex">GST extra</option><option value="in">GST included</option></select></>}
          <span className="small muted">Duties that use a rate card follow that card's own Taxable / Non-taxable setting.</span>
        </div>
        {!taxReady && <div className="small" style={{ color: 'var(--warn)' }}>Enter the GST % to continue.</div>}
      </div>
      <ErrorBox error={list.error} />
      {!contractId ? <div className="empty">Choose a department and contract (or pick one from the buttons above) to see its saved duties.</div> : list.isLoading ? <div className="muted">Loading…</div> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.8fr) minmax(280px, 1fr)', gap: 12, marginTop: 8 }}>
          <div>
            <div className="row" style={{ marginBottom: 6 }}>
              <b>{duties.length} duties in {month}</b><span className="muted">{eligible.length} eligible</span><span className="spacer" />
              <button className="btn sm" onClick={() => setSel(new Set(eligible.map((x) => x.id)))}>Select all eligible unbilled duties</button>
              <button className="btn sm" onClick={() => setSel(new Set())}>Deselect all</button>
            </div>
            <div className="scroll" style={{ maxHeight: '55vh' }}>
              <table className="t">
                <thead><tr><th /><th>Date</th><th>Vehicle</th><th>Category</th><th>Officer</th><th className="num">KM</th><th>Rate card</th><th className="num">Amount (₹)</th><th>Tax</th><th>State</th></tr></thead>
                <tbody>
                  {duties.map((x) => (
                    <tr key={x.id} style={{ opacity: x.state === 'billed' ? 0.6 : 1 }}>
                      <td><input type="checkbox" disabled={!x.eligible} checked={sel.has(x.id)} onChange={(e) => setSel((p) => { const n = new Set(p); if (e.target.checked) n.add(x.id); else n.delete(x.id); return n; })} aria-label={`Select ${x.vehicleRegNo}`} /></td>
                      <td className="nowrap">{fmtDate(x.dutyDate)}</td><td className="nowrap">{x.vehicleRegNo}</td><td>{x.vehicleCategory ?? ''}</td><td>{x.fieldOfficer ?? ''}</td>
                      <td className="num">{x.startKm && x.endKm ? Number(x.endKm) - Number(x.startKm) : ''}</td>
                      <td>{x.chosenRateCard ? <b title="Chosen on the slip">{x.chosenRateCard}</b> : x.rateCard ?? <span className="muted">—</span>}</td>
                      <td className="num nowrap">
                        {(x.state === 'unbilled' || x.state === 'cancelled') && (!x.amount || x.manualAmount != null || editing.has(x.id))
                          ? <input defaultValue={x.manualAmount ?? ''} placeholder="enter ₹" inputMode="decimal" aria-label={`Amount for ${x.vehicleRegNo}`} style={{ width: 90, textAlign: 'right', background: x.amount ? undefined : '#fff3cd' }}
                              onBlur={(e) => { const v = e.target.value.trim(); if (v !== (x.manualAmount ?? '')) void setManual(x.id, v); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
                          : x.amount ? <>{inr(x.amount)} {(x.state === 'unbilled' || x.state === 'cancelled') && <button className="btn sm" title="Enter the amount yourself" onClick={() => setEditing((z) => new Set(z).add(x.id))}>✎</button>}</> : <span className="muted" title={x.message ?? ''}>—</span>}
                      </td>
                      <td className="small">{x.tax ?? ''}</td>
                      <td title={x.message ?? ''}><span className={`badge ${STATE[x.state]?.cls ?? ''}`}>{STATE[x.state]?.label ?? x.state}</span>{x.billNo && <div className="small muted">{x.billNo}</div>}{!x.eligible && x.message && <div className="small" style={{ color: 'var(--warn)' }}>{x.message} Enter the amount to bill it.</div>}{x.eligible === false && x.state === 'unbilled' && schemeId && !x.message && <div className="small muted">Other rate card</div>}</td>
                    </tr>
                  ))}
                  {duties.length === 0 && <tr><td colSpan={10} className="empty">No saved duties for this contract in {month}.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          <div className="panel" style={{ alignSelf: 'start', position: 'sticky', top: 0 }}>
            <h3 style={{ marginTop: 0 }}>Invoice summary</h3>
            {!ids.length ? <div className="muted">Select duties to see the summary.</div> : !s ? <div className="muted">Calculating…</div> : (
              <table className="t"><tbody>
                <tr><td>Duties</td><td className="num">{s.duties}</td></tr>
                <tr><td>Total km</td><td className="num">{s.totalKm}</td></tr>
                <tr><td>Extra km</td><td className="num">{s.extraKm} km · ₹{inr(s.extraKmAmount)}</td></tr>
                <tr><td>Extra hours</td><td className="num">{s.extraHours} hr · ₹{inr(s.extraHoursAmount)}</td></tr>
                <tr><td>Night charges</td><td className="num">₹{inr(s.nightAmount)}</td></tr>
                <tr><td>Parking</td><td className="num">₹{inr(s.parking)}</td></tr>
                <tr><td>Toll</td><td className="num">₹{inr(s.toll)}</td></tr>
                <tr><td>Other approved expenses</td><td className="num">₹{inr(s.other)}</td></tr>
                <tr><td>Basic amount</td><td className="num">₹{inr(s.basicAmount)}</td></tr>
                <tr><td>GST</td><td className="num">₹{inr(s.gst)}</td></tr>
                <tr><td><b>Final invoice amount</b></td><td className="num"><b>₹{inr(s.finalAmount)}</b></td></tr>
              </tbody></table>
            )}
            {s?.problems?.length > 0 && <div className="alert warn" style={{ marginTop: 6 }}>{s.problems.slice(0, 5).map((p: any, i: number) => <div key={i}>{p.message}</div>)}</div>}
            <button className="btn primary" style={{ marginTop: 10, width: '100%' }} disabled={busy || !ids.length || !!s?.problems?.length}
              onClick={() => confirm(`Create one invoice for ${ids.length} duty(ies)? They are reserved for it and cannot go on another invoice. You can still review and approve it in the Billing Workspace.`) && void generate()}>
              Generate Department Invoice
            </button>
            <p className="small muted" style={{ marginBottom: 0 }}>The invoice is created as a draft, with the usual numbering, template and tax rules, and goes through review and approval. <Status s="draft" /></p>
          </div>
        </div>
      )}
    </div>
  );
}
