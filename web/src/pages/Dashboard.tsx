import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ErrorBox, Loading, PageHead, Status } from '../components/ui';
import { d, dt, inr, today } from '../format';

export function DashboardPage() {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get('/dashboard'), refetchInterval: 60_000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const { counts: c, monthly, recentDocs, recentBills, pendingEntry } = q.data;
  const kpi = (v: number, l: string, to: string, alert = false) => (
    <Link className={`kpi ${alert && v > 0 ? 'alert-kpi' : ''}`} to={to}><div className="v">{v}</div><div className="l">{l}</div></Link>
  );
  const months: string[] = [...new Set<string>(monthly.map((m: any) => m.month))];
  const clients: string[] = [...new Set<string>(monthly.map((m: any) => m.client_name))];
  return (
    <>
      <PageHead title="Dashboard" sub={`Today ${d(today())}`}>
        <Link className="btn primary" to="/duties/entry">Enter duties</Link>
        <Link className="btn" to="/billing">Prepare a bill</Link>
      </PageHead>
      <div className="kpis">
        {kpi(c.clients, 'Active departments', '/clients')}
        {kpi(c.activeContracts, 'Active contracts', '/contracts')}
        {kpi(c.dutiesToday, 'Duties dated today', `/duties?from=${today()}&to=${today()}`)}
        {kpi(c.dutiesEnteredToday, 'Duties entered today', '/duties?createdToday=true')}
        {kpi(c.pendingEntry, 'Contracts with no duty yesterday', '/duties/entry', true)}
        {kpi(c.withErrors, 'Duties with errors', '/duties?issues=errors', true)}
        {kpi(c.awaitingVerification, 'Duties awaiting verification', '/duties?status=entered')}
        {kpi(c.billsPreparing, 'Bills under preparation', '/bills?status=draft')}
        {kpi(c.billsAwaitingApproval, 'Bills awaiting approval', '/bills?status=under_review')}
        {kpi(c.billsGeneratedThisMonth, 'Bills generated this month', '/bills?status=generated')}
        {kpi(c.openExceptions, 'Open billing exceptions', '/reports?tab=exceptions', true)}
      </div>
      <div className="grid g2">
        <div className="panel">
          <h2>Approved billing by department (last 12 months)</h2>
          {months.length === 0 ? <p className="muted">No approved bills yet.</p> : (
            <div className="scroll"><table className="t">
              <thead><tr><th>Department</th>{months.map((m) => <th key={m} className="num">{m}</th>)}</tr></thead>
              <tbody>{clients.map((cl) => (
                <tr key={cl}><td>{cl}</td>{months.map((m) => <td key={m} className="num">{inr(monthly.find((x: any) => x.month === m && x.client_name === cl)?.total)}</td>)}</tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
        <div className="panel">
          <h2>Recent bills</h2>
          {recentBills.length === 0 ? <p className="muted">No bills yet.</p> : (
            <table className="t"><tbody>{recentBills.map((b: any) => (
              <tr key={b.id}><td><Link to={`/billing/${b.id}`}>{b.bill_no ?? 'Draft'}</Link></td><td>{b.client_name}</td><td>{d(b.period_start).slice(3)}</td><td><Status s={b.status} /></td><td className="num">{inr(b.grand_total)}</td></tr>
            ))}</tbody></table>
          )}
        </div>
        <div className="panel">
          <h2>Contracts with no duty entered for yesterday</h2>
          {pendingEntry.length === 0 ? <p className="muted">None.</p> : <ul>{pendingEntry.map((p: any) => <li key={p.id}>{p.client_name} — <Link to={`/contracts/${p.id}`}>{p.reference_no}</Link></li>)}</ul>}
          <p className="small muted">Only meaningful for contracts with daily duties.</p>
        </div>
        <div className="panel">
          <h2>Recently uploaded documents</h2>
          {recentDocs.length === 0 ? <p className="muted">No documents yet.</p> : (
            <table className="t"><tbody>{recentDocs.map((x: any) => (
              <tr key={x.id + x.uploaded_at}><td><Link to={`/documents/${x.id}`}>{x.title}</Link></td><td>{x.client_name}</td><td>{dt(x.uploaded_at)}</td><td><Status s={x.extraction_status} /></td></tr>
            ))}</tbody></table>
          )}
        </div>
      </div>
    </>
  );
}
