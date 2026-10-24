import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, downloadBlob, qs } from '../api';
import { ErrorBox, Loading, PageHead, Status, Tabs, useAction } from '../components/ui';
import { d, inr, monthRange, thisMonth } from '../format';
import { useClients } from '../lookups';

type Tab = 'summary' | 'tax' | 'exceptions' | 'register';

/** Sums exact decimal strings for display by working in integer paise. */
function total(rows: any[], k: string): string {
  const p = rows.reduce((a, r) => a + BigInt(String(r[k] ?? '0').replace('.', '').padEnd(1, '0')), 0n);
  const s = p.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

export function ReportsPage() {
  const [sp] = useSearchParams();
  const [tab, setTab] = useState<Tab>((sp.get('tab') as Tab) ?? 'summary');
  const m = monthRange(thisMonth(-1));
  const [from, setFrom] = useState(m.from);
  const [to, setTo] = useState(m.to);
  const [clientId, setClientId] = useState('');
  const clients = useClients();
  const summary = useQuery({ queryKey: ['rep-sum', from, to, clientId], queryFn: () => api.get<any[]>(`/reports/billing-summary${qs({ from, to, clientId })}`), enabled: tab === 'summary' });
  const tax = useQuery({ queryKey: ['rep-tax', from, to], queryFn: () => api.get<any[]>(`/reports/tax-summary${qs({ from, to })}`), enabled: tab === 'tax' });
  const exc = useQuery({ queryKey: ['rep-exc'], queryFn: () => api.get<any[]>('/reports/exceptions?status=open'), enabled: tab === 'exceptions' });
  const { run } = useAction();
  const byDept = (rows: any[]) => {
    const g = new Map<string, any[]>();
    rows.forEach((r) => g.set(r.client_name, [...(g.get(r.client_name) ?? []), r]));
    return [...g];
  };
  return (
    <>
      <PageHead title="Reports & Reconciliation" sub="Approved, generated and submitted bills only (except the exception report).">
        <select value={clientId} onChange={(e) => setClientId(e.target.value)}><option value="">All departments</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /> – <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </PageHead>
      <Tabs<Tab> tabs={[['summary', 'Department-wise billing'], ['tax', 'Tax summary'], ['exceptions', 'Open exceptions'], ['register', 'Duty register export']]} value={tab} onChange={setTab} />
      {tab === 'summary' && (summary.isLoading ? <Loading /> : summary.error ? <ErrorBox error={summary.error} /> : (
        <div className="panel tight"><table className="t">
          <thead><tr><th>Department</th><th>Bill</th><th>Period</th><th className="num">Duties</th><th className="num">Taxable</th><th className="num">Non-taxable</th><th className="num">Tax</th><th className="num">Round off</th><th className="num">Total</th><th>Status</th></tr></thead>
          <tbody>{byDept(summary.data ?? []).map(([dept, rows]) => (
            <Fragment key={dept}>{rows.map((r: any) => <tr key={r.bill_no + r.revision_no}><td>{dept}</td><td>{r.bill_no}{r.revision_no > 0 && ` R${r.revision_no}`}</td><td>{d(r.period_start)} – {d(r.period_end)}</td><td className="num">{r.duties}</td><td className="num">{inr(r.taxable_value)}</td><td className="num">{inr(r.non_taxable_total)}</td><td className="num">{inr(r.tax_total)}</td><td className="num">{inr(r.round_off)}</td><td className="num">{inr(r.grand_total)}</td><td><Status s={r.status} /></td></tr>)}
              <tr key={dept + 'tot'}><td colSpan={4}><b>{dept} total</b></td><td className="num"><b>{inr(total(rows, 'taxable_value'))}</b></td><td className="num"><b>{inr(total(rows, 'non_taxable_total'))}</b></td><td className="num"><b>{inr(total(rows, 'tax_total'))}</b></td><td className="num"><b>{inr(total(rows, 'round_off'))}</b></td><td className="num"><b>{inr(total(rows, 'grand_total'))}</b></td><td /></tr></Fragment>
          ))}
            {summary.data?.length === 0 && <tr><td colSpan={10} className="empty">No approved bills in this period.</td></tr>}</tbody>
          {(summary.data?.length ?? 0) > 0 && <tfoot><tr><td colSpan={4}>All departments</td><td className="num">{inr(total(summary.data!, 'taxable_value'))}</td><td className="num">{inr(total(summary.data!, 'non_taxable_total'))}</td><td className="num">{inr(total(summary.data!, 'tax_total'))}</td><td className="num">{inr(total(summary.data!, 'round_off'))}</td><td className="num">{inr(total(summary.data!, 'grand_total'))}</td><td /></tr></tfoot>}
        </table></div>
      ))}
      {tab === 'tax' && (tax.isLoading ? <Loading /> : tax.error ? <ErrorBox error={tax.error} /> : (
        <div className="panel tight"><table className="t">
          <thead><tr><th>Bill date</th><th>Bill</th><th>Department</th><th>GSTIN</th><th>Tax</th><th className="num">Rate %</th><th className="num">Taxable base</th><th className="num">Tax amount</th></tr></thead>
          <tbody>{tax.data?.map((r, i) => <tr key={i}><td>{d(r.bill_date)}</td><td>{r.bill_no}</td><td>{r.client_name}</td><td className="mono">{r.gstin}</td><td>{r.tax_type}</td><td className="num">{Number(r.rate)}</td><td className="num">{inr(r.taxable_base)}</td><td className="num">{inr(r.amount)}</td></tr>)}
            {tax.data?.length === 0 && <tr><td colSpan={8} className="empty">No tax lines.</td></tr>}</tbody>
          {(tax.data?.length ?? 0) > 0 && <tfoot>{[...new Set(tax.data!.map((r) => r.tax_type))].map((t) => <tr key={t}><td colSpan={7}>Total {t}</td><td className="num">{inr(total(tax.data!.filter((r) => r.tax_type === t), 'amount'))}</td></tr>)}</tfoot>}
        </table></div>
      ))}
      {tab === 'exceptions' && (exc.isLoading ? <Loading /> : (
        <div className="panel tight"><table className="t">
          <thead><tr><th>Department</th><th>Bill</th><th>Severity</th><th>Code</th><th>Duty</th><th>Message</th></tr></thead>
          <tbody>{exc.data?.map((e) => <tr key={e.id}><td>{e.client_name}</td><td><Link to={`/billing/${e.bill_id}`}>{e.bill_no ?? 'Draft'} ({e.period_start?.slice(0, 7)})</Link></td><td><Status s={e.severity} /></td><td className="mono small">{e.code}</td><td>{e.duty_date && `${d(e.duty_date)} ${e.vehicle_reg_no}`}</td><td>{e.message}</td></tr>)}
            {exc.data?.length === 0 && <tr><td colSpan={6} className="empty">No open exceptions.</td></tr>}</tbody>
        </table></div>
      ))}
      {tab === 'register' && (
        <div className="panel">
          <p>Download the detailed duty register for the selected period and department (vehicle numbers exported as text).</p>
          <button className="btn primary" onClick={async () => { const b = await run(() => api.blob('GET', `/reports/duty-register.xlsx${qs({ from, to, clientId })}`)); if (b) downloadBlob(b, `duty-register_${from}_${to}.xlsx`); }}>Download Excel</button>
          <p className="small muted">Per-bill calculation registers and reconciliation results are on each bill's Files tab.</p>
        </div>
      )}
    </>
  );
}
