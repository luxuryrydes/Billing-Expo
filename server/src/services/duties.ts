import { z } from 'zod';
import type { Db } from '../db/index.js';
import { DEFAULT_VALIDATION, regKey, validateDuty, type ValidationIssue, type ValidationSettings } from '../engine/validate.js';
import { badRequest, isoDate, notFound, optDecimal, optText, uuid } from '../lib/http.js';
import { getSetting } from '../routes/master.js';

const dateTime = z
  .string()
  .trim()
  .transform((s) => s.replace('T', ' ').slice(0, 16))
  .refine((s) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s), 'Use YYYY-MM-DD HH:MM');
const optDateTime = z.union([dateTime, z.literal(''), z.null()]).optional().transform((v) => (v ? v : null));

export const DutyInputSchema = z.object({
  id: uuid.optional(),
  contractId: uuid,
  dutyDate: isoDate,
  vendorName: optText,
  vehicleCategoryId: uuid.nullable().optional(),
  vehicleRegNo: z.string().trim().min(1, 'Vehicle number is required').max(20),
  driverName: optText,
  fieldOfficer: optText,
  dutyTypeCode: optText,
  startKm: optDecimal,
  endKm: optDecimal,
  startAt: optDateTime,
  endAt: optDateTime,
  toll: optDecimal,
  parking: optDecimal,
  otherCharges: optDecimal,
  customFields: z.record(z.string(), z.unknown()).default({}),
  remarks: optText,
  supportingDocRef: optText,
  correctionReason: optText,
});
export type DutyInputT = z.infer<typeof DutyInputSchema>;

export interface ContractCtx {
  id: string;
  client_id: string;
  start_date: string;
  end_date: string | null;
  validation: Partial<ValidationSettings>;
  custom_fields: { key: string; label: string; type: 'number' | 'text'; required: boolean }[];
}

export async function contractCtx(db: Db, contractId: string): Promise<ContractCtx> {
  const k = await db.one<ContractCtx>('SELECT id, client_id, start_date, end_date, validation, custom_fields FROM contracts WHERE id = $1', [contractId]);
  if (!k) throw notFound('Contract');
  return k;
}

export async function validationSettings(db: Db, k: ContractCtx): Promise<ValidationSettings> {
  const global = await getSetting<ValidationSettings>(db, 'validation');
  return { ...DEFAULT_VALIDATION, ...global, ...Object.fromEntries(Object.entries(k.validation ?? {}).filter(([, v]) => v !== undefined)) };
}

/** Validates a duty against contract rules and other duties of the same vehicle. */
export async function computeIssues(db: Db, d: DutyInputT, k: ContractCtx, s: ValidationSettings): Promise<ValidationIssue[]> {
  const key = regKey(d.vehicleRegNo);
  const others = await db.query<{ id: string; start_at: string | null; end_at: string | null; duty_date: string; start_km: string | null; end_km: string | null }>(
    `SELECT id, start_at, end_at, duty_date, start_km, end_km FROM duties
     WHERE vehicle_reg_key = $1 AND status <> 'void' AND duty_date BETWEEN ($2::date - 2) AND ($2::date + 2) AND ($3::uuid IS NULL OR id <> $3)`,
    [key, d.dutyDate, d.id ?? null],
  );
  const vehicles = await db.query<{ reg_key: string }>('SELECT reg_key FROM vehicles WHERE active');
  const issues = validateDuty(
    { ...d, id: d.id, vehicleCategoryId: d.vehicleCategoryId ?? null },
    s,
    {
      contractStart: k.start_date,
      contractEnd: k.end_date,
      sameVehicleDuties: others.map((o) => ({ id: o.id, startAt: o.start_at, endAt: o.end_at, dutyDate: o.duty_date, startKm: o.start_km, endKm: o.end_km })),
      knownVehicles: new Set(vehicles.map((v) => v.reg_key)),
    },
  );
  for (const f of k.custom_fields ?? []) {
    const v = d.customFields?.[f.key];
    if (f.required && (v === undefined || v === null || String(v).trim() === '')) issues.push({ code: 'MISSING_FIELD', severity: 'error', field: `custom.${f.key}`, message: `${f.label} is required` });
    if (f.type === 'number' && v !== undefined && v !== null && String(v).trim() !== '' && !/^-?\d+(\.\d+)?$/.test(String(v).trim()))
      issues.push({ code: 'INVALID_NUMBER', severity: 'error', field: `custom.${f.key}`, message: `${f.label} must be a number` });
  }
  if (d.dutyTypeCode) {
    const t = await db.one('SELECT code FROM duty_types WHERE code = $1', [d.dutyTypeCode]);
    if (!t) issues.push({ code: 'UNKNOWN_DUTY_TYPE', severity: 'error', field: 'dutyTypeCode', message: `Duty type ${d.dutyTypeCode} is not defined` });
  }
  return issues;
}

export const DUTY_SELECT = `
  SELECT d.*, c.name AS client_name, k.reference_no AS contract_ref, k.title AS contract_title, vc.name AS vehicle_category_name,
         (SELECT b.id FROM bill_duties bd JOIN bills b ON b.id = bd.bill_id WHERE bd.duty_id = d.id AND bd.active LIMIT 1) AS bill_id,
         (SELECT b.bill_no FROM bill_duties bd JOIN bills b ON b.id = bd.bill_id WHERE bd.duty_id = d.id AND bd.active LIMIT 1) AS bill_no
  FROM duties d JOIN clients c ON c.id = d.client_id JOIN contracts k ON k.id = d.contract_id
  LEFT JOIN vehicle_categories vc ON vc.id = d.vehicle_category_id`;

export function dutyRowToApi(r: Record<string, unknown>) {
  return {
    id: r.id, clientId: r.client_id, clientName: r.client_name, contractId: r.contract_id, contractRef: r.contract_ref, contractTitle: r.contract_title,
    dutyDate: r.duty_date, vendorName: r.vendor_name, vehicleCategoryId: r.vehicle_category_id, vehicleCategoryName: r.vehicle_category_name,
    vehicleRegNo: r.vehicle_reg_no, driverName: r.driver_name, fieldOfficer: r.field_officer, dutyTypeCode: r.duty_type_code,
    startKm: r.start_km, endKm: r.end_km, startAt: typeof r.start_at === 'string' ? r.start_at.slice(0, 16) : null, endAt: typeof r.end_at === 'string' ? r.end_at.slice(0, 16) : null,
    toll: r.toll_amount, parking: r.parking_amount, otherCharges: r.other_charges, customFields: r.custom_fields, remarks: r.remarks,
    supportingDocRef: r.supporting_doc_ref, source: r.source, status: r.status, issues: r.issues, errorCount: r.error_count, warningCount: r.warning_count,
    billId: r.bill_id ?? null, billNo: r.bill_no ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const COLS = (d: DutyInputT) => [
  d.dutyDate, d.vendorName, d.vehicleCategoryId ?? null, d.vehicleRegNo, regKey(d.vehicleRegNo), d.driverName, d.fieldOfficer, d.dutyTypeCode,
  d.startKm, d.endKm, d.startAt, d.endAt, d.toll, d.parking, d.otherCharges, JSON.stringify(d.customFields ?? {}), d.remarks, d.supportingDocRef,
];

export async function insertDuty(db: Db, d: DutyInputT, k: ContractCtx, issues: ValidationIssue[], userId: string, source: 'manual' | 'import' = 'manual', batchId: string | null = null) {
  const errs = issues.filter((i) => i.severity === 'error').length;
  return db.one<Record<string, unknown>>(
    `INSERT INTO duties(duty_date, vendor_name, vehicle_category_id, vehicle_reg_no, vehicle_reg_key, driver_name, field_officer, duty_type_code,
       start_km, end_km, start_at, end_at, toll_amount, parking_amount, other_charges, custom_fields, remarks, supporting_doc_ref,
       client_id, contract_id, issues, error_count, warning_count, source, import_batch_id, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21::jsonb,$22,$23,$24,$25,$26,$26) RETURNING *`,
    [...COLS(d), k.client_id, k.id, JSON.stringify(issues), errs, issues.length - errs, source, batchId, userId],
  );
}

export async function updateDuty(db: Db, d: DutyInputT, k: ContractCtx, issues: ValidationIssue[], userId: string) {
  const errs = issues.filter((i) => i.severity === 'error').length;
  return db.one<Record<string, unknown>>(
    `UPDATE duties SET duty_date=$1, vendor_name=$2, vehicle_category_id=$3, vehicle_reg_no=$4, vehicle_reg_key=$5, driver_name=$6, field_officer=$7, duty_type_code=$8,
       start_km=$9, end_km=$10, start_at=$11, end_at=$12, toll_amount=$13, parking_amount=$14, other_charges=$15, custom_fields=$16::jsonb, remarks=$17, supporting_doc_ref=$18,
       client_id=$19, contract_id=$20, issues=$21::jsonb, error_count=$22, warning_count=$23, updated_by=$24, updated_at=now(),
       status = CASE WHEN status = 'verified' THEN 'entered' ELSE status END, verified_by = NULL
     WHERE id=$25 RETURNING *`,
    [...COLS(d), k.client_id, k.id, JSON.stringify(issues), errs, issues.length - errs, userId, d.id],
  );
}

/** A duty on a live (non-cancelled) bill that has been approved or beyond may not be edited. */
export async function assertDutyEditable(db: Db, dutyId: string): Promise<Record<string, unknown>> {
  const row = await db.one<Record<string, unknown>>(
    `SELECT d.*, (SELECT b.status FROM bill_duties bd JOIN bills b ON b.id = bd.bill_id WHERE bd.duty_id = d.id AND bd.active LIMIT 1) AS bill_status,
            EXISTS (SELECT 1 FROM bill_duties bd JOIN bills r ON r.revision_of = bd.bill_id
                    WHERE bd.duty_id = d.id AND bd.active AND r.status IN ('draft','calculation_pending','validation_required','under_review')) AS revision_open
     FROM duties d WHERE d.id = $1`,
    [dutyId],
  );
  if (!row) throw notFound('Duty');
  if (row.status === 'void') throw badRequest('This duty has been voided');
  if (['approved', 'generated', 'submitted'].includes(String(row.bill_status)) && !row.revision_open) {
    throw badRequest('This duty is on an approved bill. Raise a bill revision to correct it.');
  }
  return row;
}
