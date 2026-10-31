import type { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { perm } from '../lib/auth.js';
import { isoDate, parse, uuid } from '../lib/http.js';
import { INR_FMT } from '../services/excel.js';
import { DUTY_SELECT, dutyRowToApi } from '../services/duties.js';

export async function reportRoutes(app: FastifyInstance) {
  const db = app.db;

  /** Every number here comes from the database. */
  app.get('/dashboard', { preHandler: perm('view') }, async () => {
    const one = async (sql: string, p: unknown[] = []) => Number((await db.one<{ n: number }>(sql, p))?.n ?? 0);
    const [clients, activeContracts, dutiesToday, dutiesEnteredToday, withErrors, awaitingVerification, billsPreparing, billsAwaitingApproval, billsGeneratedThisMonth, openExceptions] = await Promise.all([
      one(`SELECT count(*)::int AS n FROM clients WHERE status = 'active'`),
      one(`SELECT count(*)::int AS n FROM contracts WHERE status = 'active'`),
      one(`SELECT count(*)::int AS n FROM duties WHERE duty_date = current_date AND status <> 'void'`),
      one(`SELECT count(*)::int AS n FROM duties WHERE created_at::date = current_date`),
      one(`SELECT count(*)::int AS n FROM duties WHERE error_count > 0 AND status <> 'void'`),
      one(`SELECT count(*)::int AS n FROM duties WHERE status = 'entered'`),
      one(`SELECT count(*)::int AS n FROM bills WHERE status IN ('draft','calculation_pending','validation_required')`),
      one(`SELECT count(*)::int AS n FROM bills WHERE status = 'under_review'`),
      one(`SELECT count(DISTINCT b.id)::int AS n FROM bills b JOIN generated_files g ON g.bill_id = b.id WHERE date_trunc('month', g.created_at) = date_trunc('month', now())`),
      one(`SELECT count(*)::int AS n FROM billing_exceptions e JOIN bills b ON b.id = e.bill_id WHERE e.status = 'open' AND b.status NOT IN ('cancelled','superseded')`),
    ]);
    // Contracts with no duty entries for yesterday (a pending-entry indicator for daily-duty contracts)
    const pendingEntry = await db.query(
      `SELECT k.id, k.reference_no, c.name AS client_name FROM contracts k JOIN clients c ON c.id = k.client_id
       WHERE k.status = 'active' AND NOT EXISTS (SELECT 1 FROM duties d WHERE d.contract_id = k.id AND d.duty_date = current_date - 1 AND d.status <> 'void') ORDER BY c.name`);
    const monthly = await db.query(
      `SELECT to_char(b.period_start, 'YYYY-MM') AS month, c.name AS client_name, c.id AS client_id, sum(b.grand_total)::text AS total, count(*)::int AS bills
       FROM bills b JOIN clients c ON c.id = b.client_id WHERE b.status IN ('approved','generated','submitted') AND b.period_start >= (date_trunc('month', now()) - interval '11 months')
       GROUP BY 1,2,3 ORDER BY 1 DESC, 2`);
    const recentDocs = await db.query(
      `SELECT d.id, d.title, d.doc_type, c.name AS client_name, v.uploaded_at, v.extraction_status FROM documents d JOIN document_versions v ON v.document_id = d.id
       LEFT JOIN clients c ON c.id = d.client_id ORDER BY v.uploaded_at DESC LIMIT 8`);
    const recentBills = await db.query(
      `SELECT b.id, b.bill_no, b.status, b.grand_total, b.period_start, c.name AS client_name FROM bills b JOIN clients c ON c.id = b.client_id ORDER BY b.updated_at DESC LIMIT 8`);
    // --- the home screen: what needs attention, how this month is going, and how billing is trending ---------------
    const BILLED = `('approved','generated','submitted')`;
    const [slipsToSave, ratesToApprove, taxToApprove, notBilled] = await Promise.all([
      one(`SELECT count(*)::int AS n FROM slip_readings r JOIN scan_pages p ON p.id = r.page_id WHERE r.status = 'read' AND r.duty_id IS NULL AND NOT p.deleted`),
      one(`SELECT count(*)::int AS n FROM rate_scheme_versions WHERE status = 'pending_approval'`),
      one(`SELECT count(*)::int AS n FROM tax_rules WHERE status = 'draft'`),
      one(`SELECT count(*)::int AS n FROM duties d WHERE d.status <> 'void' AND NOT EXISTS (
             SELECT 1 FROM bill_duties bd JOIN bills b ON b.id = bd.bill_id WHERE bd.duty_id = d.id AND bd.active AND b.status NOT IN ('cancelled','superseded'))`),
    ]);
    const byMonth = await db.query<{ month: string; total: string; bills: number }>(
      `SELECT to_char(m, 'YYYY-MM') AS month, coalesce(sum(b.grand_total), 0)::text AS total, count(b.id)::int AS bills
       FROM generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') AS m
       LEFT JOIN bills b ON date_trunc('month', b.period_start)::date = m::date AND b.status IN ${BILLED}
       GROUP BY m ORDER BY m`);
    const cur = byMonth[byMonth.length - 1];
    const prev = byMonth[byMonth.length - 2];
    const pct = (a: string, b: string) => (Number(b) > 0 ? Math.round(((Number(a) - Number(b)) / Number(b)) * 1000) / 10 : null);
    const duties = await db.one<{ cur: number; prev: number }>(
      `SELECT (SELECT count(*) FROM duties WHERE duty_date >= date_trunc('month', current_date) AND status <> 'void')::int AS cur,
              (SELECT count(*) FROM duties WHERE duty_date >= date_trunc('month', current_date) - interval '1 month' AND duty_date < date_trunc('month', current_date) AND status <> 'void')::int AS prev`);
    const deptRows = await db.query<{ id: string; name: string; total: string; bills: number }>(
      `SELECT c.id, c.name, sum(b.grand_total)::text AS total, count(*)::int AS bills FROM bills b JOIN clients c ON c.id = b.client_id
       WHERE b.status IN ${BILLED} AND b.period_start >= date_trunc('month', now()) - interval '11 months' GROUP BY c.id, c.name ORDER BY sum(b.grand_total) DESC, c.name`);
    const pipelineRows = await db.query<{ stage: string; n: number }>(
      `SELECT CASE WHEN status IN ('draft','calculation_pending','validation_required') THEN 'preparing' WHEN status = 'under_review' THEN 'review' ELSE status END AS stage, count(*)::int AS n
       FROM bills WHERE status NOT IN ('cancelled','superseded') AND updated_at >= now() - interval '90 days' GROUP BY 1`);
    const activity = await db.query(
      `SELECT a.id, a.at, a.action, a.entity_type, u.name AS user_name FROM audit_events a LEFT JOIN app_users u ON u.id = a.user_id
       WHERE a.action NOT IN ('login', 'logout') ORDER BY a.at DESC LIMIT 10`);
    const setup = await db.one<Record<string, number>>(
      `SELECT (SELECT count(*)::int FROM supplier_profiles) AS supplier, (SELECT count(*)::int FROM clients) AS clients,
              (SELECT count(*)::int FROM rate_scheme_versions WHERE status IN ('approved','pending_approval')) AS rates,
              (SELECT count(*)::int FROM rate_scheme_versions WHERE status = 'approved') AS approved_rates,
              (SELECT count(*)::int FROM duties WHERE status <> 'void') AS duties, (SELECT count(*)::int FROM bills) AS bills`);
    const top = deptRows.slice(0, 6);
    const rest = deptRows.slice(6);
    return {
      counts: { clients, activeContracts, dutiesToday, dutiesEnteredToday, withErrors, awaitingVerification, billsPreparing, billsAwaitingApproval, billsGeneratedThisMonth, openExceptions, pendingEntry: pendingEntry.length },
      pendingEntry, monthly, recentDocs, recentBills,
      attention: { dutiesWithErrors: withErrors, slipsToSave, dutiesToVerify: awaitingVerification, billsToApprove: billsAwaitingApproval, ratesToApprove, taxToApprove, openExceptions },
      month: {
        key: cur.month, billed: cur.total, billedPrev: prev?.total ?? '0', billedChangePct: prev ? pct(cur.total, prev.total) : null,
        bills: cur.bills, billsPrev: prev?.bills ?? 0, duties: duties?.cur ?? 0, dutiesPrev: duties?.prev ?? 0, dutiesChangePct: duties && duties.prev > 0 ? Math.round(((duties.cur - duties.prev) / duties.prev) * 1000) / 10 : null,
        notBilled,
      },
      byMonth,
      topDepartments: top.map((r) => ({ id: r.id, name: r.name, total: r.total, bills: r.bills })),
      otherDepartments: rest.length ? { count: rest.length, total: rest.reduce((a, r) => a + Number(r.total), 0).toFixed(2) } : null,
      pipeline: Object.fromEntries(['preparing', 'review', 'approved', 'generated', 'submitted'].map((k) => [k, pipelineRows.find((r) => r.stage === k)?.n ?? 0])),
      activity,
      setup,
    };
  });

  app.get('/reports/billing-summary', { preHandler: perm('view') }, async (req) => {
    const q = parse(z.object({ from: isoDate, to: isoDate, clientId: uuid.optional() }), req.query);
    return db.query(
      `SELECT c.name AS client_name, k.reference_no, b.bill_no, b.revision_no, b.period_start, b.period_end, b.status,
              b.taxable_value, b.non_taxable_total, b.tax_total, b.round_off, b.grand_total,
              (SELECT count(*)::int FROM bill_duties bd WHERE bd.bill_id = b.id) AS duties
       FROM bills b JOIN clients c ON c.id = b.client_id JOIN contracts k ON k.id = b.contract_id
       WHERE b.period_start >= $1 AND b.period_start <= $2 AND b.status IN ('approved','generated','submitted') AND ($3::uuid IS NULL OR b.client_id = $3)
       ORDER BY c.name, b.period_start`, [q.from, q.to, q.clientId ?? null]);
  });

  /** Billing data export: every bill in the period with its totals and tax lines (one sheet), plus line detail (second sheet). */
  app.get('/reports/billing-summary.xlsx', { preHandler: perm('export') }, async (req, reply) => {
    const q = parse(z.object({ from: isoDate, to: isoDate, clientId: uuid.optional(), includeDrafts: z.coerce.boolean().optional() }), req.query);
    const bills = await db.query<Record<string, string | number | null>>(
      `SELECT b.id, c.name AS client_name, c.gstin, k.reference_no, b.bill_no, b.revision_no, b.bill_date, b.period_start, b.period_end, b.period_type, b.status,
              b.taxable_value, b.non_taxable_total, b.tax_total, b.round_off, b.grand_total,
              (SELECT string_agg(t.tax_type || ' ' || trim(to_char(t.rate, 'FM990.99')) || '%: ' || t.amount, '; ') FROM bill_tax_lines t WHERE t.bill_id = b.id AND t.snapshot_id = b.current_snapshot_id) AS taxes,
              (SELECT count(*)::int FROM bill_duties bd WHERE bd.bill_id = b.id) AS duties
       FROM bills b JOIN clients c ON c.id = b.client_id JOIN contracts k ON k.id = b.contract_id
       WHERE b.period_start >= $1 AND b.period_start <= $2 AND ($3::uuid IS NULL OR b.client_id = $3)
         AND (b.status IN ('approved','generated','submitted') OR ($4::boolean AND b.status NOT IN ('cancelled','superseded')))
       ORDER BY c.name, b.period_start, b.bill_no`, [q.from, q.to, q.clientId ?? null, q.includeDrafts ?? false]);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Bills');
    ws.addRow(['Department', 'Client GSTIN', 'Contract', 'Bill no.', 'Rev.', 'Bill date', 'Period from', 'Period to', 'Bill type', 'Status', 'Duties', 'Taxable', 'Non-taxable', 'Tax', 'Taxes', 'Round off', 'Total']).font = { bold: true };
    for (const b of bills) {
      const r = ws.addRow([b.client_name, b.gstin, b.reference_no, b.bill_no ?? 'DRAFT', b.revision_no, b.bill_date, b.period_start, b.period_end, b.period_type === 'date' ? 'Date-wise' : b.period_type === 'month' ? 'Month-wise' : 'Period', b.status, b.duties,
        Number(b.taxable_value ?? 0), Number(b.non_taxable_total ?? 0), Number(b.tax_total ?? 0), b.taxes, Number(b.round_off ?? 0), Number(b.grand_total ?? 0)]);
      [12, 13, 14, 16, 17].forEach((i) => (r.getCell(i).numFmt = INR_FMT));
    }
    ws.columns.forEach((c, i) => (c.width = [26, 18, 20, 20, 5, 11, 11, 11, 11, 11, 7, 13, 13, 12, 30, 9, 14][i]));
    const lines = wb.addWorksheet('Lines');
    lines.addRow(['Bill no.', 'Duty date', 'Vehicle', 'Component', 'Quantity', 'Unit', 'Rate', 'Amount', 'Tax category']).font = { bold: true };
    for (const b of bills) {
      const ls = await db.query<Record<string, string>>(`SELECT l.*, d.duty_date FROM bill_lines l JOIN bills b ON b.id = l.bill_id AND l.snapshot_id = b.current_snapshot_id LEFT JOIN duties d ON d.id = l.duty_id WHERE l.bill_id = $1 ORDER BY l.sort_order`, [b.id as string]);
      for (const l of ls) {
        const r = lines.addRow([b.bill_no ?? 'DRAFT', l.duty_date, l.vehicle_reg_no, l.label, Number(l.quantity), l.unit, Number(l.rate), Number(l.amount), l.tax_category]);
        r.getCell(3).numFmt = '@';
        r.getCell(8).numFmt = INR_FMT;
      }
    }
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', `attachment; filename="billing-data_${q.from}_${q.to}.xlsx"`);
    return reply.send(Buffer.from(await wb.xlsx.writeBuffer()));
  });

  app.get('/reports/tax-summary', { preHandler: perm('view') }, async (req) => {
    const q = parse(z.object({ from: isoDate, to: isoDate }), req.query);
    return db.query(
      `SELECT c.name AS client_name, c.gstin, b.bill_no, b.bill_date, t.tax_type, t.rate, t.taxable_base, t.amount
       FROM bill_tax_lines t JOIN bills b ON b.id = t.bill_id AND t.snapshot_id = b.current_snapshot_id JOIN clients c ON c.id = b.client_id
       WHERE b.period_start BETWEEN $1 AND $2 AND b.status IN ('approved','generated','submitted') ORDER BY b.bill_date, c.name, t.tax_type`, [q.from, q.to]);
  });

  app.get('/reports/exceptions', { preHandler: perm('view') }, async (req) => {
    const q = parse(z.object({ status: z.enum(['open', 'waived', 'resolved']).optional() }), req.query);
    return db.query(
      `SELECT e.*, b.bill_no, b.period_start, b.status AS bill_status, c.name AS client_name, d.vehicle_reg_no, d.duty_date, u.name AS resolved_by_name
       FROM billing_exceptions e JOIN bills b ON b.id = e.bill_id JOIN clients c ON c.id = b.client_id LEFT JOIN duties d ON d.id = e.duty_id LEFT JOIN app_users u ON u.id = e.resolved_by
       WHERE b.status NOT IN ('cancelled','superseded') AND ($1::text IS NULL OR e.status = $1) ORDER BY e.created_at DESC LIMIT 1000`, [q.status ?? null]);
  });

  /** Duty register export with leading-zero-safe vehicle numbers. */
  app.get('/reports/duty-register.xlsx', { preHandler: perm('export') }, async (req, reply) => {
    const q = parse(z.object({ from: isoDate, to: isoDate, clientId: uuid.optional(), contractId: uuid.optional() }), req.query);
    const rows = (await db.query(
      `${DUTY_SELECT} WHERE d.duty_date BETWEEN $1 AND $2 AND d.status <> 'void' AND ($3::uuid IS NULL OR d.client_id = $3) AND ($4::uuid IS NULL OR d.contract_id = $4) ORDER BY d.duty_date, d.start_at, d.vehicle_reg_no`,
      [q.from, q.to, q.clientId ?? null, q.contractId ?? null])).map(dutyRowToApi);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Duty register');
    ws.addRow(['Date', 'Department', 'Contract', 'Vendor', 'Vehicle type', 'Vehicle no.', 'Driver', 'User / officer', 'Duty type', 'Start km', 'Closing km', 'Km', 'Start time', 'Closing time', 'Toll', 'Parking', 'Status', 'Bill no.', 'Issues', 'Remarks']).font = { bold: true };
    for (const r of rows) {
      const km = r.startKm != null && r.endKm != null ? Number(r.endKm) - Number(r.startKm) : null;
      const row = ws.addRow([r.dutyDate, r.clientName, r.contractRef, r.vendorName, r.vehicleCategoryName, r.vehicleRegNo, r.driverName, r.fieldOfficer, r.dutyTypeCode,
        r.startKm != null ? Number(r.startKm) : null, r.endKm != null ? Number(r.endKm) : null, km, r.startAt, r.endAt,
        r.toll != null ? Number(r.toll) : null, r.parking != null ? Number(r.parking) : null, r.status, r.billNo,
        ((r.issues as { message: string }[]) ?? []).map((i) => i.message).join('; '), r.remarks]);
      row.getCell(6).numFmt = '@';
      row.getCell(15).numFmt = INR_FMT;
      row.getCell(16).numFmt = INR_FMT;
    }
    ws.columns.forEach((c, i) => (c.width = [11, 24, 16, 14, 12, 14, 18, 18, 9, 9, 9, 7, 17, 17, 9, 9, 9, 18, 40, 20][i]));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', `attachment; filename="duty-register_${q.from}_${q.to}.xlsx"`);
    return reply.send(Buffer.from(await wb.xlsx.writeBuffer()));
  });
}
