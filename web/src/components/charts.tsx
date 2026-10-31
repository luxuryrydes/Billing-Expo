/**
 * Small dependency-free charts for the home dashboard. One colour family (blue) with the current period
 * emphasised, thin marks anchored to a baseline, hairline gridlines, hover / keyboard details, and a table
 * view of the same numbers so nothing depends on colour or on seeing the chart.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { inr, inrShort } from '../format';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const parseMonth = (ym: string) => { const [y, m] = ym.split('-').map(Number); return { y, m: m - 1 }; };
export const monthShort = (ym: string) => MONTHS[parseMonth(ym).m];
export const monthLong = (ym: string) => `${MONTHS_LONG[parseMonth(ym).m]} ${parseMonth(ym).y}`;

/** 0, 25%, 50%, 75%, 100% of a round top value. */
function niceMax(max: number): number {
  if (max <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * exp >= max) return m * exp;
  return 10 * exp;
}

export interface MonthPoint { month: string; total: string; bills: number }

/** Monthly billing: columns for the last twelve months, the current month in the accent colour. */
export function MonthlyColumns({ data }: { data: MonthPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const W = 720, H = 250, L = 52, R = 12, T = 22, B = 30;
  const values = data.map((d) => Number(d.total));
  const top = niceMax(Math.max(...values, 0)) <= 1 && values.every((v) => v === 0) ? 100000 : niceMax(Math.max(...values, 0));
  const band = (W - L - R) / Math.max(1, data.length);
  const barW = Math.min(24, band * 0.55);
  const y = (v: number) => T + (H - T - B) * (1 - v / top);
  const empty = values.every((v) => v === 0);
  const last = data.length - 1;
  const bar = (i: number) => { const x = L + band * i + (band - barW) / 2; const yy = y(values[i]); const h = H - B - yy; const r = Math.min(4, h, barW / 2); return { x, yy, h, r }; };
  const total = values.reduce((a, b) => a + b, 0);
  if (table) {
    return (
      <div>
        <div className="dash-table-toggle"><button className="btn sm" onClick={() => setTable(false)}>Show chart</button></div>
        <table className="t"><thead><tr><th>Month</th><th className="num">Bills</th><th className="num">Billed</th></tr></thead>
          <tbody>{[...data].reverse().map((d) => <tr key={d.month}><td>{monthLong(d.month)}</td><td className="num">{d.bills}</td><td className="num">₹{inr(d.total)}</td></tr>)}</tbody></table>
      </div>
    );
  }
  return (
    <div className="dash-chart">
      <div className="dash-table-toggle"><button className="btn sm" onClick={() => setTable(true)}>View as table</button></div>
      <div style={{ position: 'relative' }}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Billing by month for the last 12 months. Total ${inrShort(total)}.`} style={{ width: '100%', height: 'auto', display: 'block' }} onMouseLeave={() => setHover(null)}>
          {[0, 1, 2, 3, 4].map((k) => {
            const v = (top / 4) * k;
            return <g key={k}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke={k === 0 ? 'var(--d-base)' : 'var(--d-grid)'} strokeWidth={1} /><text x={L - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill="var(--d-muted)">{k === 0 ? '0' : inrShort(v)}</text></g>;
          })}
          {data.map((d, i) => {
            const b = bar(i);
            const isNow = i === last;
            const fill = isNow ? 'var(--d-accent)' : 'var(--d-bar)';
            return (
              <g key={d.month} tabIndex={0} role="img" aria-label={`${monthLong(d.month)}: ${inrShort(values[i])} from ${d.bills} bill${d.bills === 1 ? '' : 's'}`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} style={{ outline: 'none' }}>
                <rect x={L + band * i} y={T} width={band} height={H - T - B} fill={hover === i ? 'rgba(42,120,214,.07)' : 'transparent'} />
                {values[i] > 0 && <path d={`M${b.x},${H - B} V${b.yy + b.r} Q${b.x},${b.yy} ${b.x + b.r},${b.yy} H${b.x + barW - b.r} Q${b.x + barW},${b.yy} ${b.x + barW},${b.yy + b.r} V${H - B} Z`} fill={fill} />}
                {isNow && values[i] > 0 && <text x={b.x + barW / 2} y={b.yy - 6} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--d-ink)">{inrShort(values[i])}</text>}
                <text x={L + band * i + band / 2} y={H - 10} textAnchor="middle" fontSize={11.5} fill={isNow ? 'var(--d-ink)' : 'var(--d-muted)'} fontWeight={isNow ? 600 : 400}>{monthShort(d.month)}</text>
              </g>
            );
          })}
        </svg>
        {hover !== null && (
          <div className="dash-tip" style={{ left: `${((L + band * hover + band / 2) / W) * 100}%`, top: `${(Math.min(y(values[hover]), H - B - 8) / H) * 100}%` }}>
            <b>{monthLong(data[hover].month)}</b>
            <div>{values[hover] > 0 ? `₹${inr(data[hover].total)}` : 'No approved bills'}</div>
            {data[hover].bills > 0 && <div className="muted">{data[hover].bills} bill{data[hover].bills === 1 ? '' : 's'}</div>}
          </div>
        )}
        {empty && <div className="dash-chart-empty">Your approved bills will appear here, month by month.</div>}
      </div>
    </div>
  );
}

export interface DeptPoint { id: string; name: string; total: string; bills: number }

/** Departments ranked by what was billed: one bar each, value at the tip. */
export function DepartmentBars({ rows, other }: { rows: DeptPoint[]; other: { count: number; total: string } | null }) {
  const max = Math.max(...rows.map((r) => Number(r.total)), Number(other?.total ?? 0), 1);
  const sum = rows.reduce((a, r) => a + Number(r.total), 0) + Number(other?.total ?? 0);
  if (!rows.length) return <div className="dash-empty">No approved bills in the last 12 months yet.</div>;
  const row = (key: string, label: React.ReactNode, value: string, muted = false) => {
    const pct = (Number(value) / max) * 100;
    return (
      <div className="dash-bar-row" key={key}>
        <div className="dash-bar-name">{label}</div>
        <div className="dash-bar-area">
          <div className="dash-bar-fill" style={{ width: `${Math.max(1.5, pct * 0.68)}%`, background: muted ? 'var(--d-bar)' : 'var(--d-accent)' }} />
          <span className="dash-bar-value">{inrShort(value)} <span className="muted">· {sum > 0 ? Math.round((Number(value) / sum) * 100) : 0}%</span></span>
        </div>
      </div>
    );
  };
  return (
    <div role="list" aria-label="Departments by amount billed in the last 12 months">
      {rows.map((r) => row(r.id, <Link to={`/clients/${r.id}`} title={`${r.name} — ₹${inr(r.total)} from ${r.bills} bill${r.bills === 1 ? '' : 's'}`}>{r.name}</Link>, r.total))}
      {other && row('other', <span className="muted">Other ({other.count} departments)</span>, other.total, true)}
    </div>
  );
}

export const STAGES: { key: string; label: string; status: string; help: string; color: string }[] = [
  { key: 'preparing', label: 'Being prepared', status: 'draft', help: 'Draft bills not yet sent for review', color: '#86b6ef' },
  { key: 'review', label: 'Waiting for approval', status: 'under_review', help: 'Sent for review', color: '#5598e7' },
  { key: 'approved', label: 'Approved', status: 'approved', help: 'Approved, files not yet made', color: '#2a78d6' },
  { key: 'generated', label: 'Ready to send', status: 'generated', help: 'Excel and PDF made', color: '#1c5cab' },
  { key: 'submitted', label: 'Sent to department', status: 'submitted', help: 'Marked as submitted', color: '#104281' },
];

/** Where the recent bills are in the process: one bar split into stages, with the numbers listed under it. */
export function BillPipeline({ counts }: { counts: Record<string, number> }) {
  const total = STAGES.reduce((a, s) => a + (counts[s.key] ?? 0), 0);
  if (!total) return <div className="dash-empty">No bills in the last 90 days. Prepare one from the Billing Workspace.</div>;
  return (
    <div>
      <div className="dash-stagebar" role="img" aria-label={`${total} bills: ${STAGES.map((s) => `${counts[s.key] ?? 0} ${s.label.toLowerCase()}`).join(', ')}`}>
        {STAGES.filter((s) => (counts[s.key] ?? 0) > 0).map((s) => <div key={s.key} title={`${s.label}: ${counts[s.key]}`} style={{ flex: counts[s.key], background: s.color }} />)}
      </div>
      <div className="dash-stages">
        {STAGES.map((s) => (
          <Link key={s.key} to={`/bills?status=${s.status}`} className="dash-stage" title={s.help}>
            <span className="dash-swatch" style={{ background: s.color }} />
            <span className="dash-stage-n">{counts[s.key] ?? 0}</span>
            <span className="dash-stage-l">{s.label}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
