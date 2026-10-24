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
