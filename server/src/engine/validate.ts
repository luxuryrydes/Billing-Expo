import { dec } from './decimal.js';
import { toMinutes } from './time.js';

export interface ValidationIssue {
  code: string;
  severity: 'error' | 'warning';
  field?: string;
  message: string;
}

export interface ValidationSettings {
  /** Fields that must be present. Keys use duty field names. */
  mandatoryFields: string[];
  maxKmPerDuty: number;
  maxHoursPerDuty: number;
  /** Require a supporting document reference when toll/parking is claimed. */
  requireExpenseEvidence: boolean;
  /** Issue codes promoted to hard errors by contract configuration. */
  hardErrorCodes: string[];
}

export const DEFAULT_VALIDATION: ValidationSettings = {
  mandatoryFields: ['dutyDate', 'vehicleRegNo', 'vehicleCategoryId', 'startKm', 'endKm', 'startAt', 'endAt'],
  maxKmPerDuty: 800,
  maxHoursPerDuty: 24,
  requireExpenseEvidence: false,
  hardErrorCodes: [],
};

export interface DutyForValidation {
  id?: string;
  dutyDate: string | null;
  vehicleRegNo: string | null;
  vehicleCategoryId: string | null;
  driverName?: string | null;
  fieldOfficer?: string | null;
  dutyTypeCode?: string | null;
  startKm: string | null;
  endKm: string | null;
  startAt: string | null;
  endAt: string | null;
  toll?: string | null;
  parking?: string | null;
  supportingDocRef?: string | null;
}

export interface ValidationContext {
  contractStart?: string | null;
  contractEnd?: string | null;
  /** Other duties of the same vehicle (any source) to detect duplicates/overlaps. */
  sameVehicleDuties?: { id: string; startAt: string | null; endAt: string | null; dutyDate: string; startKm: string | null; endKm: string | null }[];
  /** Known vehicle registration numbers for the client; empty means "not checked". */
  knownVehicles?: Set<string>;
  knownDrivers?: Set<string>;
}

const LABELS: Record<string, string> = {
  dutyDate: 'Duty date',
  vehicleRegNo: 'Vehicle number',
  vehicleCategoryId: 'Vehicle category',
  driverName: 'Driver',
  fieldOfficer: 'User / field officer',
  dutyTypeCode: 'Duty type',
  startKm: 'Starting km',
  endKm: 'Closing km',
  startAt: 'Starting time',
  endAt: 'Closing time',
};

const isNum = (v: string | null | undefined) => v != null && /^-?\d+(\.\d+)?$/.test(String(v).trim());

/** Normalises a registration number for matching only. The stored value is never altered. */
export function regKey(reg: string): string {
  return reg.toUpperCase().replace(/[\s-]/g, '');
}

export function validateDuty(d: DutyForValidation, s: ValidationSettings, ctx: ValidationContext = {}): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const push = (code: string, severity: 'error' | 'warning', message: string, field?: string) =>
    out.push({ code, severity: s.hardErrorCodes.includes(code) ? 'error' : severity, message, field });

  for (const f of s.mandatoryFields) {
    const v = (d as unknown as Record<string, unknown>)[f];
    if (v === null || v === undefined || String(v).trim() === '') push('MISSING_FIELD', 'error', `${LABELS[f] ?? f} is required`, f);
  }

  if (d.vehicleRegNo && !/\d/.test(d.vehicleRegNo)) push('INVALID_VEHICLE_NO', 'error', `"${d.vehicleRegNo}" is not a vehicle number`, 'vehicleRegNo');

  if (d.startKm && !isNum(d.startKm)) push('INVALID_NUMBER', 'error', 'Starting km is not a number', 'startKm');
  if (d.endKm && !isNum(d.endKm)) push('INVALID_NUMBER', 'error', 'Closing km is not a number', 'endKm');
  if (isNum(d.startKm) && isNum(d.endKm)) {
    const km = dec(d.endKm).sub(dec(d.startKm));
    if (dec(d.startKm).isNeg() || dec(d.endKm).isNeg()) push('NEGATIVE_KM', 'error', 'Odometer readings cannot be negative', 'startKm');
    if (km.isNeg()) push('ODOMETER_REVERSED', 'error', `Closing km (${d.endKm}) is lower than starting km (${d.startKm})`, 'endKm');
    else if (km.isZero()) push('ZERO_KM', 'warning', 'Distance is zero', 'endKm');
    // Far beyond any plausible day (usually a mistyped odometer): an error, so it cannot be waived into a bill.
    else if (km.gt(s.maxKmPerDuty * 5)) push('IMPLAUSIBLE_KM', 'error', `Distance ${km.toString()} km is not plausible for one duty — check the odometer readings (${d.startKm} → ${d.endKm})`, 'endKm');
    else if (km.gt(s.maxKmPerDuty)) push('HIGH_KM', 'warning', `Distance ${km.toString()} km exceeds the review threshold of ${s.maxKmPerDuty} km`, 'endKm');
  }

  const sm = toMinutes(d.startAt);
  const em = toMinutes(d.endAt);
  if (d.startAt && sm == null) push('INVALID_TIME', 'error', 'Starting date-time is invalid', 'startAt');
  if (d.endAt && em == null) push('INVALID_TIME', 'error', 'Closing date-time is invalid', 'endAt');
  if (sm != null && em != null) {
    if (em < sm) push('TIME_REVERSED', 'error', 'Closing date-time is before starting date-time. For an overnight duty set the closing date to the next day.', 'endAt');
    else if (em === sm) push('ZERO_DURATION', 'warning', 'Duty duration is zero', 'endAt');
    else if ((em - sm) / 60 > s.maxHoursPerDuty) push('LONG_DURATION', 'warning', `Duration ${((em - sm) / 60).toFixed(1)} h exceeds the review threshold of ${s.maxHoursPerDuty} h`, 'endAt');
    if (d.dutyDate && d.startAt && d.startAt.slice(0, 10) !== d.dutyDate) push('DATE_MISMATCH', 'warning', 'Starting date differs from the duty date', 'startAt');
  }

  if (d.dutyDate && ctx.contractStart && d.dutyDate < ctx.contractStart) push('OUTSIDE_CONTRACT', 'error', `Duty date is before the contract start (${ctx.contractStart})`, 'dutyDate');
  if (d.dutyDate && ctx.contractEnd && d.dutyDate > ctx.contractEnd) push('OUTSIDE_CONTRACT', 'error', `Duty date is after the contract end (${ctx.contractEnd})`, 'dutyDate');

  if (d.vehicleRegNo && ctx.knownVehicles && ctx.knownVehicles.size > 0 && !ctx.knownVehicles.has(regKey(d.vehicleRegNo)))
    push('UNKNOWN_VEHICLE', 'warning', `Vehicle ${d.vehicleRegNo} is not in the vehicle register`, 'vehicleRegNo');
  if (d.driverName && ctx.knownDrivers && ctx.knownDrivers.size > 0 && !ctx.knownDrivers.has(d.driverName.trim().toUpperCase()))
    push('UNKNOWN_DRIVER', 'warning', `Driver ${d.driverName} is not in the driver register`, 'driverName');

  const claimed = dec(isNum(d.toll) ? d.toll : '0').add(dec(isNum(d.parking) ? d.parking : '0'));
  if (s.requireExpenseEvidence && claimed.gt(0) && !(d.supportingDocRef && d.supportingDocRef.trim()))
    push('MISSING_EVIDENCE', 'warning', 'Toll/parking claimed without a supporting document reference', 'supportingDocRef');
  if ((isNum(d.toll) && dec(d.toll).isNeg()) || (isNum(d.parking) && dec(d.parking).isNeg())) push('NEGATIVE_EXPENSE', 'error', 'Toll/parking cannot be negative', 'toll');

  for (const o of ctx.sameVehicleDuties ?? []) {
    if (o.id === d.id) continue;
    const os = toMinutes(o.startAt);
    const oe = toMinutes(o.endAt);
    if (sm != null && os != null && sm === os) {
      push('DUPLICATE_DUTY', 'error', `Duplicate of another duty for the same vehicle starting ${o.startAt}`);
    } else if (sm != null && em != null && os != null && oe != null && sm < oe && os < em) {
      push('OVERLAPPING_DUTY', 'warning', `Overlaps another duty of the same vehicle (${o.startAt} – ${o.endAt})`);
    } else if (sm == null && o.dutyDate === d.dutyDate && o.startKm === d.startKm && o.endKm === d.endKm) {
      push('DUPLICATE_DUTY', 'error', 'Same vehicle, date and odometer readings as another duty');
    }
  }
  return out;
}
