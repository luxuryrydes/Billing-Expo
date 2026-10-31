import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { BillPipeline, DepartmentBars, MonthlyColumns, monthLong } from '../components/charts';
import { ErrorBox, Loading, Status } from '../components/ui';
import { d, inr, inrShort, timeAgo } from '../format';

// --- small icons (always paired with a label, so colour never carries the meaning alone) -------------------
const Icon = ({ children }: { children: ReactNode }) => <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
const I = {
  alert: <Icon><path d="M12 3 2.5 20h19L12 3Z" /><path d="M12 10v4" /><path d="M12 17.5v.01" /></Icon>,
  clock: <Icon><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>,
  scan: <Icon><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /><path d="M4 12h16" /></Icon>,
  check: <Icon><circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.8 2.8L16 9.5" /></Icon>,
  doc: <Icon><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v4h4M10 12h5M10 16h5" /></Icon>,
};

type Sev = 'critical' | 'warning' | 'info';
const SEV_LABEL: Record<Sev, string> = { critical: 'Needs fixing', warning: 'Waiting for you', info: 'To do' };

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/** What the audit log says, in plain words. */
const ACTION_TEXT: Record<string, string> = {
  create: 'added', update: 'updated', approve: 'approved', reject: 'rejected', calculate: 'calculated', generate: 'made the files for', submit: 'marked as sent', cancel: 'cancelled', revise: 'started a revision of',
  void: 'voided', verify: 'verified', import: 'imported', retire: 'retired', delete: 'removed', upload: 'uploaded', correct: 'corrected', waive: 'waived',
  import_rate_register: 'imported the rate register for', scan_import: 'saved a scanned slip as', scan_update: 'updated from a scanned slip:', start_scan: 'started', delete_page: 'removed', edit_image: 'edited', rescan: 'rescanned', excel_edit: 'corrected in Excel:',
  setup_admin: 'created the first administrator account', create_user: 'added', change_password: 'changed a password for',
  set_arithmetic: 'changed the printed arithmetic of', tax_from_rate_card: 'set the tax of', retire_duplicates: 'cleaned up duplicates in', retire_superseded: 'replaced old versions of', set_rate_card_contract: 'chose the rate card contract of',
};
const ENTITY_TEXT: Record<string, string> = {
  bill: 'a bill', duty: 'a duty', contract: 'a contract', client: 'a department', rate_version: 'a rate', rate_scheme: 'a rate', tax_rule: 'a tax rule', template: 'a bill format', template_version: 'a bill format',
  document: 'a document', document_version: 'a document', import: 'the rate register', scan_batch: 'a scan', scan_page: 'a scanned page', slip_reading: 'a scanned slip', user: 'a user', supplier: 'company details', vehicle: 'a vehicle',
};
function activityText(a: { action: string; entity_type: string; user_name: string | null }): string {
  const who = a.user_name ?? 'Someone';
  const act = ACTION_TEXT[a.action] ?? a.action.replace(/_/g, ' ');
  const what = a.action === 'setup_admin' ? '' : a.action === 'import_rate_register' ? 'departments and rates' : (ENTITY_TEXT[a.entity_type] ?? a.entity_type.replace(/_/g, ' '));
  return `${who} ${act} ${what}`.replace(/\s+/g, ' ').trim();
}

function Delta({ pct, vs, goodWhenUp = true }: { pct: number | null; vs: string; goodWhenUp?: boolean }) {
  if (pct === null) return <span className="dash-delta flat">Nothing to compare with {vs} yet</span>;
  if (pct === 0) return <span className="dash-delta flat">▬ Same as {vs}</span>;
  const up = pct > 0;
  const good = up === goodWhenUp;
  return <span className={`dash-delta ${good ? 'good' : 'bad'}`}>{up ? '▲' : '▼'} {Math.abs(pct)}% {up ? 'more' : 'less'} than {vs}</span>;
}

export function DashboardPage() {
  const { user, can } = useAuth();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<any>('/dashboard'), refetchInterval: 60_000 });
  const [hideSetup, setHideSetup] = useState(() => { try { return localStorage.getItem('dash-hide-setup') === '1'; } catch { return false; } });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const x = q.data;
  const a = x.attention;
  const mo = x.month;
  const monthName = monthLong(mo.key);
  const first = (user?.name ?? '').split(' ')[0];

  type Item = { n: number; sev: Sev; icon: ReactNode; title: string; help: string; to: string; go: string; perm?: string };
  const items = ([
    { n: a.dutiesWithErrors, sev: 'critical', icon: I.alert, title: 'Duties with mistakes', help: 'Something is wrong, for example a missing kilometre reading. They cannot be billed until fixed.', to: '/duties?issues=errors', go: 'Fix them' },
    { n: a.openExceptions, sev: 'critical', icon: I.alert, title: 'Billing problems to look at', help: 'The bill calculation found something that needs a decision.', to: '/reports?tab=exceptions', go: 'Review' },
    { n: a.slipsToSave, sev: 'warning', icon: I.scan, title: 'Scanned slips not saved yet', help: 'Read from paper duty slips; save them as duties to bill them.', to: '/scan', go: 'Open scanning' },
    { n: a.dutiesToVerify, sev: 'warning', icon: I.clock, title: 'Duties waiting to be checked', help: 'Check them against the duty slips before billing.', to: '/duties?status=entered', go: 'Check duties' },
    { n: a.billsToApprove, sev: 'warning', icon: I.clock, title: 'Bills waiting for approval', help: 'Prepared and sent for review.', to: '/bills?status=under_review', go: 'Review bills', perm: 'bill.approve' },
    { n: a.ratesToApprove, sev: 'warning', icon: I.doc, title: 'Rates waiting for approval', help: 'New or changed rates are not used on bills until approved.', to: '/rates', go: 'Approve rates', perm: 'rate.approve' },
    { n: a.taxToApprove, sev: 'warning', icon: I.doc, title: 'Tax rules waiting for approval', help: 'Bills cannot be calculated until the tax rules are approved.', to: '/contracts', go: 'Open contracts', perm: 'tax.approve' },
  ] as Item[]).filter((i) => i.n > 0);
  const total = items.reduce((s, i) => s + i.n, 0);

  const steps = [
    { done: x.setup.supplier > 0, title: 'Add your company details', help: 'Name, address and GSTIN that print on bills.', to: '/settings', go: 'Open settings' },
    { done: x.setup.clients > 0, title: 'Add your departments', help: 'The departments and institutions you bill.', to: '/clients', go: 'Add departments' },
    { done: x.setup.approved_rates > 0, title: 'Set up rates and approve them', help: 'What each vehicle and package costs.', to: '/rates', go: 'Open rates' },
    { done: x.setup.duties > 0, title: 'Record duties', help: 'Type them in, import a sheet, or scan the duty slips.', to: '/scan', go: 'Add duties' },
    { done: x.setup.bills > 0, title: 'Prepare your first bill', help: 'Pick a department and month, then review and approve.', to: '/billing', go: 'Prepare a bill' },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <div className="dash">
      <div className="dash-hero">
        <div>
          <h1>{greeting()}{first ? `, ${first}` : ''}</h1>
          <p className="dash-sub">{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · {total ? `${items.length} thing${items.length === 1 ? '' : 's'} need${items.length === 1 ? 's' : ''} your attention` : 'everything is up to date'}</p>
        </div>
        <div className="dash-quick">
          {can('duty.write') && <Link className="btn primary" to="/scan">Scan duty slips</Link>}
          {can('duty.write') && <Link className="btn" to="/duties/entry">Enter duties</Link>}
          <Link className="btn" to="/billing">Prepare a bill</Link>
        </div>
      </div>

      {doneCount < steps.length && !hideSetup && (
        <section className="dash-card dash-setup">
          <div className="dash-card-head">
            <div><h2>Getting started</h2><p className="dash-help">{doneCount} of {steps.length} steps done. Follow them in order and your first bill is ready.</p></div>
            <button className="btn sm" onClick={() => { setHideSetup(true); try { localStorage.setItem('dash-hide-setup', '1'); } catch { /* not saved */ } }}>Hide</button>
          </div>
          <div className="dash-progress" role="progressbar" aria-valuenow={doneCount} aria-valuemin={0} aria-valuemax={steps.length} aria-label="Set-up progress"><div style={{ width: `${(doneCount / steps.length) * 100}%` }} /></div>
          <ol className="dash-steps">
            {steps.map((s, i) => (
              <li key={s.title} className={s.done ? 'done' : ''}>
                <span className="dash-step-n">{s.done ? '✓' : i + 1}</span>
                <div><b>{s.title}</b><div className="dash-help">{s.help}</div></div>
                {s.done ? <span className="dash-done">Done</span> : <Link className="btn sm" to={s.to}>{s.go}</Link>}
              </li>
            ))}
          </ol>
        </section>
      )}

      <section>
        <h2 className="dash-h2">Needs your attention</h2>
        {items.length === 0 ? (
          <div className="dash-card dash-clear">{I.check}<div><b>You are all caught up</b><div className="dash-help">No mistakes to fix and nothing is waiting for approval.</div></div></div>
        ) : (
          <div className="dash-attn-grid">
            {items.map((i) => (
              <Link key={i.title} to={i.to} className={`dash-attn ${i.sev}`}>
                <span className="dash-attn-icon">{i.icon}</span>
                <div className="dash-attn-body">
                  <div className="dash-attn-top"><span className="dash-attn-n">{i.n}</span><span className="dash-attn-tag">{SEV_LABEL[i.sev]}</span></div>
                  <div className="dash-attn-title">{i.title}</div>
                  <div className="dash-help">{i.help}</div>
                </div>
                <span className="dash-attn-go">{i.go} →</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="dash-h2">This month <span className="dash-h2-sub">{monthName}</span></h2>
        <div className="dash-kpis">
          <div className="dash-card dash-hero-kpi">
            <div className="dash-kpi-label">Billed this month</div>
            <div className="dash-hero-value">{mo.billed === '0' || mo.billed === '0.00' ? '₹0' : `₹${inr(mo.billed).replace(/\.00$/, '')}`}</div>
            <Delta pct={mo.billedChangePct} vs="last month" />
            <div className="dash-help">Total of approved bills for {monthName}.</div>
          </div>
          <Link to="/bills" className="dash-card dash-kpi">
            <div className="dash-kpi-label">Bills approved</div>
            <div className="dash-kpi-value">{mo.bills}</div>
            <span className="dash-help">{mo.billsPrev} last month</span>
          </Link>
          <Link to="/duties" className="dash-card dash-kpi">
            <div className="dash-kpi-label">Duties recorded</div>
            <div className="dash-kpi-value">{mo.duties}</div>
            <Delta pct={mo.dutiesChangePct} vs="last month" />
          </Link>
          <Link to="/billing" className="dash-card dash-kpi">
            <div className="dash-kpi-label">Duties not billed yet</div>
            <div className="dash-kpi-value">{mo.notBilled}</div>
            <span className="dash-help">{mo.notBilled > 0 ? 'Waiting to be put on a bill' : 'Everything recorded is on a bill'}</span>
          </Link>
        </div>
      </section>

      <div className="dash-two">
        <section className="dash-card">
          <div className="dash-card-head"><div><h2>Billing by month</h2><p className="dash-help">Approved bills over the last 12 months. Hover a column for details.</p></div></div>
          <MonthlyColumns data={x.byMonth} />
        </section>
        <section className="dash-card">
          <div className="dash-card-head"><div><h2>Top departments</h2><p className="dash-help">Amount billed in the last 12 months.</p></div></div>
          <DepartmentBars rows={x.topDepartments} other={x.otherDepartments} />
        </section>
      </div>

      <section className="dash-card">
        <div className="dash-card-head"><div><h2>Bills in progress</h2><p className="dash-help">Where bills from the last 90 days are in the process. Select a stage to see those bills.</p></div><Link className="btn sm" to="/billing">Billing workspace</Link></div>
        <BillPipeline counts={x.pipeline} />
      </section>

      <div className="dash-two even">
        <section className="dash-card">
          <div className="dash-card-head"><div><h2>Recent bills</h2></div><Link className="btn sm" to="/bills">View all</Link></div>
          {x.recentBills.length === 0 ? <div className="dash-empty">No bills yet.</div> : (
            <table className="t"><thead><tr><th>Bill</th><th>Department</th><th>Month</th><th>Status</th><th className="num">Amount</th></tr></thead><tbody>
              {x.recentBills.slice(0, 6).map((b: any) => (
                <tr key={b.id}><td><Link to={`/billing/${b.id}`}>{b.bill_no ?? 'Draft'}</Link></td><td className="dash-cut" title={b.client_name}>{b.client_name}</td><td>{d(b.period_start).slice(3)}</td><td><Status s={b.status} /></td><td className="num">{b.grand_total ? `₹${inrShort(b.grand_total)}` : '—'}</td></tr>
              ))}
            </tbody></table>
          )}
        </section>
        <section className="dash-card">
          <div className="dash-card-head"><div><h2>Recent activity</h2></div>{can('audit.view') && <Link className="btn sm" to="/audit">Full log</Link>}</div>
          {x.activity.length === 0 ? <div className="dash-empty">Nothing yet.</div> : (
            <ul className="dash-activity">
              {x.activity.slice(0, 8).map((e: any) => <li key={e.id}><span className="dash-dot" /><span>{activityText(e)}</span><span className="dash-when">{timeAgo(e.at)}</span></li>)}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
