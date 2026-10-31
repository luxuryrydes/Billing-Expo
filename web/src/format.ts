/** Display helpers. Amounts arrive from the API as exact decimal strings and are only formatted here, never recalculated. */
export function inr(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v);
  if (!/^-?\d+(\.\d+)?$/.test(s)) return s;
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace('-', '').split('.');
  const last3 = i.slice(-3);
  const rest = i.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${rest ? rest + ',' : ''}${last3}.${(f + '00').slice(0, 2)}`;
}

export function d(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, dd] = iso.slice(0, 10).split('-');
  return `${dd}-${m}-${y}`;
}

export function dt(iso: string | null | undefined): string {
  if (!iso) return '';
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(iso) && !iso.endsWith('Z') && !/[+-]\d{2}:?\d{2}$/.test(iso)) return `${d(iso)} ${iso.slice(11, 16)}`;
  const x = new Date(iso);
  return isNaN(x.getTime()) ? iso : x.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

export function monthRange(ym: string): { from: string; to: string } {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}

export function today(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

export function thisMonth(offset = 0): string {
  const t = new Date();
  t.setDate(1);
  t.setMonth(t.getMonth() + offset);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`;
}

export const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  calculation_pending: 'Calculation pending',
  validation_required: 'Validation required',
  under_review: 'Under review',
  approved: 'Approved',
  generated: 'Generated',
  submitted: 'Submitted',
  superseded: 'Superseded',
  cancelled: 'Cancelled',
  pending_approval: 'Pending approval',
  rejected: 'Rejected',
  retired: 'Retired',
  entered: 'Entered',
  verified: 'Verified',
  billed: 'Billed',
  void: 'Void',
  active: 'Active',
  inactive: 'Inactive',
  expired: 'Expired',
  terminated: 'Terminated',
  pending: 'Pending',
  accepted: 'Accepted',
  edited: 'Edited',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  open: 'Open',
  waived: 'Waived',
  resolved: 'Resolved',
};

/** Short rupee amounts for charts and tiles: ₹950, ₹12.5K, ₹4.2 L, ₹1.3 Cr (lakh and crore, as Indian users read them). */
export function inrShort(v: string | number | null | undefined): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '';
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const f = (x: number) => String(Math.round(x * 100) / 100).replace(/(\.\d)0$/, '$1');
  if (a >= 1e7) return `${sign}₹${f(a / 1e7)} Cr`;
  if (a >= 1e5) return `${sign}₹${f(a / 1e5)} L`;
  if (a >= 1e3) return `${sign}₹${f(a / 1e3)}K`;
  return `${sign}₹${Math.round(a)}`;
}

/** "just now", "5 minutes ago", "3 hours ago", "yesterday", "12 Oct". */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} minute${Math.floor(s / 60) === 1 ? '' : 's'} ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hour${Math.floor(s / 3600) === 1 ? '' : 's'} ago`;
  if (s < 172800) return 'yesterday';
  return new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
