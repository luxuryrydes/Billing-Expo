/**
 * Scanned slips by department: who each slip belongs to (the department record it matches, not the AI's spelling), its contract,
 * rate card, calculated amount and status; grouping and filtering; and one approved rate card applied to every selected slip it fits.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useClients } from '../lookups';
import { useAction, useToast } from './ui';
import { d as fmtDate, inr } from '../format';

type GroupBy = 'department' | 'contract' | 'rate' | 'none';
const NONE = 'Not identified';

export interface OverviewProps {
  d: any;
  calc: Record<string, any> | undefined;
  dutyType: string;
  saveCell: (readingId: string, key: string, value: string) => Promise<void>;
  reload: () => void;
  curId: string | undefined;
  onPick: (pageId: string) => void;
  /** Go on to the invoice step; a rate card is never required for it. */
  onContinue: () => void;
}

export function SlipOverview({ d, calc, dutyType, saveCell, reload, curId, onPick, onContinue }: OverviewProps) {
  const clients = useClients();
  const toast = useToast();
  const { run, busy } = useAction();
  const pages: any[] = d.pages.filter((p: any) => !p.deleted && p.reading.status === 'read');
  const [groupBy, setGroupBy] = useState<GroupBy>('department');
  const [filter, setFilter] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [cardId, setCardId] = useState('');
  const [result, setResult] = useState<any>(null);
  const [manualAll, setManualAll] = useState('');
  const [editing, setEditing] = useState<Set<string>>(new Set());

  const rows = useMemo(() => pages.map((p, i) => {
    const r = p.reading;
    const c = calc?.[r.id];
    const v = r.values ?? {};
    const dept = c?.match?.clientName ?? null;
    const km = v.total_km || (v.opening_km && v.closing_km && !Number.isNaN(Number(v.closing_km) - Number(v.opening_km)) ? String(Number(v.closing_km) - Number(v.opening_km)) : '');
    const state = r.dutyId ? 'saved' : !c ? 'wait' : !c.match?.matched ? 'dept' : c.status === 'ok' ? 'ready' : 'review';
    return { p, r, c, v, page: i + 1, dept: dept ?? NONE, contract: c?.match?.contractRef ?? NONE, card: c?.rateCardName ?? 'Automatic', km, state, amount: c?.status === 'ok' ? c.totals.subtotal : null };
  }), [pages, calc]);

  const shown = rows.filter((x) => !filter || x.dept === filter);
  const keyOf = (x: (typeof rows)[number]) => (groupBy === 'department' ? x.dept : groupBy === 'contract' ? `${x.dept} — ${x.contract}` : groupBy === 'rate' ? `${x.dept} — ${x.card}` : 'All slips');
  const groups = useMemo(() => {
    const m = new Map<string, typeof rows>();
    for (const x of shown) { const k = keyOf(x); m.set(k, [...(m.get(k) ?? []), x]); }
    return [...m.entries()].sort(([a], [b]) => (a.startsWith(NONE) ? 1 : b.startsWith(NONE) ? -1 : a.localeCompare(b)));
  }, [shown, groupBy]);   // eslint-disable-line react-hooks/exhaustive-deps

  const depts = useMemo(() => {
    const m = new Map<string, { n: number; sel: number; ready: number; amount: number }>();
    for (const x of rows) {
      const e = m.get(x.dept) ?? { n: 0, sel: 0, ready: 0, amount: 0 };
      e.n++; if (sel.has(x.r.id)) e.sel++; if (x.state === 'ready' || x.state === 'saved') e.ready++; if (x.amount) e.amount += Math.round(Number(x.amount) * 100);
      m.set(x.dept, e);
    }
    return [...m.entries()].sort(([a], [b]) => (a === NONE ? 1 : b === NONE ? -1 : a.localeCompare(b)));
  }, [rows, sel]);

  const selectedRows = rows.filter((x) => sel.has(x.r.id));
  const selectedTotal = selectedRows.reduce((a, x) => a + (x.amount ? Math.round(Number(x.amount) * 100) : 0), 0) / 100;
  const contractIds = [...new Set(selectedRows.map((x) => x.c?.match?.contractId).filter(Boolean))] as string[];
  const allContractIds = [...new Set(rows.map((x) => x.c?.match?.contractId).filter(Boolean))] as string[];
  const cards = useQuery({ queryKey: ['scan-rate-cards', allContractIds.join(',')], enabled: allContractIds.length > 0, queryFn: () => api.get<any[]>(`/scan/rate-cards?contractIds=${allContractIds.join(',')}`) });
  const cardsFor = (cid: string | null | undefined) => (cards.data ?? []).filter((c) => c.contract_id === cid);
  const selectableCards = (cards.data ?? []).filter((c) => contractIds.includes(c.contract_id));

  const toggle = (id: string, on: boolean) => setSel((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const setMany = (list: typeof rows, on: boolean) => setSel((s) => { const n = new Set(s); for (const x of list) { if (on) n.add(x.r.id); else n.delete(x.r.id); } return n; });
  const apply = async (ids: string[], schemeId: string | null, quiet = false) => {
    const r = await run(() => api.post<any>(`/scan/batches/${d.batch.id}/apply-rate-card`, { readingIds: ids, schemeId, dutyType }));
    if (!r) return;
    if (!quiet) setResult(r);
    toast(schemeId ? `Rate card applied to ${r.applied} slip(s)${r.skipped.length ? `; ${r.skipped.length} not applicable` : ''}` : 'Rate card cleared (automatic)');
    reload();
  };
  /** Enter (or clear) the amount by hand for slips: no rate card is needed. */
  const setManual = async (ids: string[], amount: string | null) => {
    if (amount !== null && !/^\d+(\.\d{1,2})?$/.test(amount.trim())) { toast('Enter the amount as a number, for example 1800 or 1800.50', true); return; }
    const r = await run(() => api.post<any>(`/scan/batches/${d.batch.id}/apply-manual`, { readingIds: ids, amount: amount === null ? null : amount.trim() }));
    if (!r) return;
    toast(amount === null ? 'Amounts cleared' : `Amount ₹${amount} set for ${r.updated} slip(s)`);
    setEditing(new Set());
    reload();
  };
  const eligible = shown.filter((x) => x.state === 'ready');

  return (
    <div>
      <div className="panel" style={{ marginBottom: 8 }}>
        <div className="small muted" style={{ marginBottom: 4 }}>Departments in this batch</div>
        <table className="t">
          <thead><tr><th>Department</th><th className="num">Total slips</th><th className="num">Selected</th><th className="num">Calculated (₹, before tax)</th><th>Status</th><th /></tr></thead>
          <tbody>
            {depts.map(([name, e]) => (
              <tr key={name}>
                <td>{name === NONE ? <span className="badge warn">Not identified</span> : name}</td><td className="num">{e.n}</td><td className="num">{e.sel}</td><td className="num">{inr(e.amount / 100)}</td>
                <td>{name === NONE ? <span className="badge warn">Choose the department</span> : e.ready === e.n ? <span className="badge ok">Ready</span> : <span className="badge warn">{e.n - e.ready} to check</span>}</td>
                <td className="nowrap"><button className="btn sm" onClick={() => setMany(rows.filter((x) => x.dept === name), true)}>Select all</button> <button className="btn sm" onClick={() => setMany(rows.filter((x) => x.dept === name), false)}>Deselect</button> <button className="btn sm" onClick={() => setFilter(filter === name ? '' : name)}>{filter === name ? 'Show all' : 'Show only'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="row" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
        <label className="small">Department <select value={filter} onChange={(e) => setFilter(e.target.value)}><option value="">All departments</option>{depts.map(([n]) => <option key={n} value={n}>{n}</option>)}</select></label>
        <label className="small">Group by <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}><option value="department">Department</option><option value="contract">Contract</option><option value="rate">Rate card</option><option value="none">No grouping</option></select></label>
        <button className="btn sm" onClick={() => setMany(eligible, true)}>Select all eligible ({eligible.length})</button>
        <button className="btn sm" onClick={() => setSel(new Set())} disabled={!sel.size}>Deselect all</button>
        <span className="spacer" />
        <button className="btn sm" onClick={() => setClosed(closed.size ? new Set() : new Set(groups.map(([k]) => k)))}>{closed.size ? 'Expand all' : 'Collapse all'}</button>
      </div>

      <div className="panel" style={{ marginBottom: 8, background: sel.size ? '#f2f7fd' : undefined }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <b>{sel.size} slip(s) selected</b>
          <span className="muted">Calculated total for the selected: <b>₹{inr(selectedTotal)}</b> before tax</span>
          <span className="spacer" />
          <select value={cardId} onChange={(e) => setCardId(e.target.value)} disabled={!sel.size || !selectableCards.length} aria-label="Select approved rate card">
            <option value="">{!sel.size ? 'Select slips first' : contractIds.length ? 'Select approved rate card…' : 'The selected slips have no contract yet'}</option>
            {[...new Map(selectableCards.map((c) => [c.scheme_id, c])).values()].map((c) => <option key={c.scheme_id} value={c.scheme_id}>{contractIds.length > 1 ? `${c.contract_ref} — ` : ''}{c.name}{c.categories?.length ? ` (${c.categories.join(', ')})` : ''}</option>)}
          </select>
          <button className="btn primary" disabled={busy || !sel.size || !cardId} onClick={() => apply([...sel], cardId)}>Apply Rate Card to All Selected Slips</button>
          <button className="btn" disabled={busy || !sel.size} title="Go back to the software choosing the rate by vehicle type, duty type and date" onClick={() => apply([...sel], null)}>Use automatic rate</button>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', marginTop: 6 }}>
          <span className="small muted">No rate card? Enter the amount yourself:</span>
          <input placeholder="₹ amount per slip" inputMode="decimal" value={manualAll} onChange={(e) => setManualAll(e.target.value)} style={{ width: 130 }} aria-label="Amount for all selected slips" />
          <button className="btn" disabled={busy || !sel.size || !manualAll} onClick={() => void setManual([...sel], manualAll)}>Set amount for selected slips</button>
          <button className="btn sm" disabled={busy || !sel.size} onClick={() => void setManual([...sel], null)}>Clear entered amounts</button>
          <span className="spacer" />
          <button className="btn primary" onClick={onContinue} title="A rate card is optional: slips with an amount, or an automatic rate, can be billed">Continue to Invoice →</button>
        </div>
        {contractIds.length > 1 && <div className="small muted" style={{ marginTop: 4 }}>The selection covers {contractIds.length} contracts. A card is applied only to slips on its own contract; the others are reported.</div>}
        {result && (
          <div style={{ marginTop: 8 }}>
            <div className={result.skipped.length ? 'alert warn' : 'alert info'}>
              <button className="btn sm" style={{ float: 'right' }} onClick={() => setResult(null)}>Dismiss</button>
              {result.rateCard ? `${result.applied} slip(s) now use "${result.rateCard}", totalling ₹${inr(result.total)} before tax.` : `${result.applied} slip(s) back to the automatic rate.`}
              {result.skipped.length > 0 && <> <b>For information:</b> {result.skipped.length} slip(s) were left as they were because the card does not fit them. This does not stop you: pick another card, enter the amount by hand, or continue to the invoice.</>}
              {result.skipped.length > 0 && <ul className="small" style={{ margin: '4px 0 0 16px' }}>{result.skipped.slice(0, 30).map((x: any) => <li key={x.readingId}>Page {x.page}: {x.reason}</li>)}</ul>}
              {result.skipped.length > 0 && (
                <div className="row" style={{ marginTop: 6 }}>
                  <button className="btn sm" onClick={() => setSel(new Set(result.skipped.map((x: any) => x.readingId)))}>Select these slips</button>
                  <button className="btn sm primary" onClick={onContinue}>Continue to Invoice →</button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="scroll" style={{ maxHeight: '62vh' }}>
        <table className="t" style={{ minWidth: 1500 }}>
          <thead><tr><th /><th>Pg</th><th>Department</th><th>Contract</th><th>Vehicle category</th><th>Vehicle model</th><th>Officer / employee</th><th>Vehicle no.</th><th>Date</th><th>Duty type</th><th>Reporting</th><th>Release</th><th className="num">Total km</th><th>Rate card</th><th className="num">Amount (₹)</th><th>Status</th></tr></thead>
          <tbody>
            {groups.map(([name, list]) => {
              const gSel = list.filter((x) => sel.has(x.r.id)).length;
              const gAmt = list.reduce((a, x) => a + (x.amount ? Math.round(Number(x.amount) * 100) : 0), 0) / 100;
              const open = !closed.has(name);
              return [
                groupBy !== 'none' && (
                  <tr key={'g' + name} style={{ background: '#eef2f7' }}>
                    <td colSpan={16}>
                      <div className="row">
                        <button className="btn sm" onClick={() => setClosed((s) => { const n = new Set(s); if (n.has(name)) n.delete(name); else n.add(name); return n; })} aria-label={open ? 'Collapse' : 'Expand'}>{open ? '▾' : '▸'}</button>
                        <b>{name}</b><span className="muted">{list.length} slip(s) · {gSel} selected · ₹{inr(gAmt)} before tax</span>
                        <span className="spacer" />
                        <button className="btn sm" onClick={() => setMany(list, true)}>Select all slips of this group</button>
                        <button className="btn sm" onClick={() => setMany(list, false)}>Deselect</button>
                      </div>
                    </td>
                  </tr>
                ),
                ...(open || groupBy === 'none' ? list.map((x) => {
                  const cs = cardsFor(x.c?.match?.contractId);
                  const uniqueCards = [...new Map(cs.map((c) => [c.scheme_id, c])).values()];
                  return (
                    <tr key={x.p.id} onClick={() => onPick(x.p.id)} style={{ background: curId === x.p.id ? 'var(--brand-soft)' : undefined }}>
                      <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(x.r.id)} onChange={(e) => toggle(x.r.id, e.target.checked)} aria-label={`Select page ${x.page}`} /></td>
                      <td><b>{x.page}</b></td>
                      <td style={{ background: x.state === 'dept' ? '#fff3cd' : undefined }} onClick={(e) => e.stopPropagation()}>
                        {x.c?.match?.matched ? x.dept : (
                          <select value="" onChange={(e) => { const c = clients.data?.find((z) => z.id === e.target.value); if (c) void saveCell(x.r.id, 'department', c.name); }} title={`The slip says "${x.v.department ?? ''}". Choose the department record.`} style={{ maxWidth: 180 }}>
                            <option value="">{x.v.department ? `"${x.v.department}" — choose…` : 'Choose department…'}</option>
                            {(clients.data ?? []).filter((c) => c.status === 'active').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                          </select>
                        )}
                      </td>
                      <td>{x.contract === NONE ? <span className="muted">—</span> : x.contract}</td>
                      <td>{x.v.vehicle_category ?? ''}</td><td>{x.v.vehicle_model ?? ''}</td><td>{x.v.officer ?? ''}</td><td className="nowrap">{x.v.vehicle_no ?? ''}</td>
                      <td className="nowrap">{x.c?.dutyDate ? fmtDate(x.c.dutyDate) : x.v.duty_date ?? ''}</td><td>{dutyType || 'LOCAL'}</td><td>{x.v.reporting_time ?? ''}</td><td>{x.v.release_time ?? ''}</td><td className="num">{x.km}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <select value={x.c?.rateSchemeId ?? ''} disabled={busy || !uniqueCards.length} onChange={(e) => void apply([x.r.id], e.target.value || null, true)} style={{ maxWidth: 190 }} title="Choose a rate card for this slip only">
                          <option value="">Automatic{x.c?.status === 'ok' && !x.c.rateCardChosen ? ` — ${x.c.rateCardName}` : ''}</option>
                          {uniqueCards.map((c) => <option key={c.scheme_id} value={c.scheme_id}>{c.name}</option>)}
                        </select>
                      </td>
                      <td className="num nowrap" onClick={(e) => e.stopPropagation()}>
                        {x.amount && !editing.has(x.r.id) ? (
                          <><b>{inr(x.amount)}</b>{x.c?.manual && <span className="small muted" title="Entered by hand"> ✎</span>} <button className="btn sm" title="Enter the amount yourself" onClick={() => setEditing((z) => new Set(z).add(x.r.id))}>✎</button></>
                        ) : (
                          <input defaultValue={x.c?.manualAmount ?? ''} placeholder="enter ₹" inputMode="decimal" aria-label={`Amount for page ${x.page}`} style={{ width: 84, textAlign: 'right', background: x.state === 'review' ? '#fff3cd' : undefined }}
                            onBlur={(e) => { const v = e.target.value.trim(); if (v !== (x.c?.manualAmount ?? '')) void setManual([x.r.id], v === '' ? null : v); else setEditing((z) => { const n = new Set(z); n.delete(x.r.id); return n; }); }}
                            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
                        )}
                      </td>
                      <td title={x.c?.message ?? ''}>{x.state === 'saved' ? <span className="badge ok">Saved</span> : x.state === 'ready' ? <span className="badge ok">Ready</span> : x.state === 'dept' ? <span className="badge warn">Check department</span> : x.state === 'review' ? <span className="badge warn">Needs review</span> : <span className="muted">…</span>}</td>
                    </tr>
                  );
                }) : []),
              ];
            })}
            {groups.length === 0 && <tr><td colSpan={16} className="empty">No slips to show. Read the pages first.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ marginTop: 6 }}>Hover a status to see why a slip needs review. Click a row to see its page. Department names are matched to your Departments &amp; Institutions records; correct one from its drop-down before saving.</p>
    </div>
  );
}
