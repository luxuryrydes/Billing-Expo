import { z } from 'zod';

const decStr = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^-?\d+(\.\d+)?$/.test(v), 'Must be a decimal number');

export const RoundingSchema = z.object({
  mode: z.enum(['exact', 'ceil', 'floor', 'nearest']).default('exact'),
  /** Unit in minutes for hours (e.g. 60, 30, 15) or kilometres for distance. */
  unit: decStr.default('1'),
});

export const NightRuleSchema = z.object({
  enabled: z.boolean().default(false),
  /** Local wall-clock HH:MM. A window where start > end crosses midnight. */
  start: z.string().regex(/^\d{2}:\d{2}$/).default('22:00'),
  end: z.string().regex(/^\d{2}:\d{2}$/).default('06:00'),
  /** Minimum minutes of overlap with the window for a night to count. */
  minOverlapMinutes: z.number().int().min(0).default(1),
  countMode: z.enum(['per_night', 'once_per_duty']).default('per_night'),
});

export const VariableDefSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'lowercase letters, digits and _ only'),
  expr: z.string().min(1),
  description: z.string().optional(),
});

export const ComponentSchema = z.object({
  code: z.string().min(1).max(40),
  label: z.string().min(1),
  /** duty = per duty slip; vehicle_period = once per vehicle per bill; bill = once per bill */
  scope: z.enum(['duty', 'vehicle_period', 'bill']).default('duty'),
  kind: z.enum(['charge', 'reimbursement', 'deduction']).default('charge'),
  quantityExpr: z.string().min(1),
  /** Unit rate. For reimbursements this is usually 1 with quantityExpr = the expense. */
  rate: decStr,
  unit: z.string().default(''),
  taxCategory: z.enum(['taxable', 'non_taxable']),
  /** Optional expression; the component applies only when it evaluates truthy. */
  condition: z.string().optional(),
  quantityDp: z.number().int().min(0).max(6).default(2),
  quantityRoundMode: z.enum(['half_up', 'up', 'down', 'ceil', 'floor']).default('half_up'),
  minAmount: decStr.optional(),
  maxAmount: decStr.optional(),
  clauseRef: z.string().optional(),
  showWhenZero: z.boolean().default(false),
});

export const RateConfigSchema = z.object({
  billingModel: z.enum(['daily_package', 'monthly_package', 'monthly_limit', 'hourly_km', 'fixed_trip', 'hybrid']),
  params: z.object({
    includedKm: decStr.default('0'),
    includedHours: decStr.default('0'),
    /** Extra minutes within grace are not charged. */
    graceMinutes: z.number().int().min(0).default(0),
    /** waive_within: if extra ≤ grace, extra = 0, else full extra charged. deduct: grace is subtracted from extra. */
    graceMode: z.enum(['waive_within', 'deduct']).default('waive_within'),
    hourRounding: RoundingSchema.default({ mode: 'exact', unit: '60' }),
    kmRounding: RoundingSchema.default({ mode: 'exact', unit: '1' }),
    /** Garage-to-garage or other contractual kilometre adjustment added to actual km. */
    kmAdjustment: decStr.default('0'),
    night: NightRuleSchema.default({ enabled: false, start: '22:00', end: '06:00', minOverlapMinutes: 1, countMode: 'per_night' }),
    monthlyIncludedKm: decStr.default('0'),
    monthlyIncludedHours: decStr.default('0'),
    variables: z.array(VariableDefSchema).default([]),
  }),
  components: z.array(ComponentSchema).min(1),
  amountDp: z.number().int().min(0).max(4).default(2),
  amountRoundMode: z.enum(['half_up', 'half_even', 'up', 'down']).default('half_up'),
});

export type RateConfig = z.infer<typeof RateConfigSchema>;
export type RateComponent = z.infer<typeof ComponentSchema>;

/** A rate-scheme version as the engine sees it (must already be approved for live bills). */
export interface SchemeVersion {
  id: string;
  schemeId: string;
  schemeName: string;
  versionNo: number;
  status: string;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null;
  vehicleCategoryIds: string[];
  dutyTypeCodes: string[];
  config: RateConfig;
}

export interface DutyInput {
  id: string;
  dutyDate: string; // YYYY-MM-DD
  vehicleRegNo: string;
  vehicleCategoryId: string | null;
  vehicleCategoryName?: string | null;
  dutyTypeCode: string | null;
  startKm: string | null;
  endKm: string | null;
  startAt: string | null; // 'YYYY-MM-DD HH:MM[:SS]' local time
  endAt: string | null;
  toll: string | null;
  parking: string | null;
  otherCharges: string | null;
  customFields?: Record<string, unknown>;
}

export interface TraceInfo {
  quantityExpr: string;
  condition?: string;
  inputs: Record<string, string>;
  formula: string;
  clauseRef?: string;
  schemeVersionId: string;
  schemeName: string;
  versionNo: number;
  capped?: string;
  /** daily_package, fixed_trip… — lets a layout print a fixed-price duty differently. */
  billingModel?: string;
}

export interface CalcLine {
  dutyId: string | null;
  vehicleRegNo: string | null;
  scope: 'duty' | 'vehicle_period' | 'bill';
  componentCode: string;
  label: string;
  kind: 'charge' | 'reimbursement' | 'deduction';
  quantity: string;
  unit: string;
  rate: string;
  amount: string; // signed; deductions negative
  taxCategory: 'taxable' | 'non_taxable';
  trace: TraceInfo;
}

export interface TaxRuleInput {
  id: string;
  name: string;
  taxType: string;
  rate: string; // percent
  effectiveFrom: string;
  effectiveTo: string | null;
  status: string;
  sourceRef?: string | null;
}

export interface BillSettings {
  taxMode: 'exclusive' | 'inclusive';
  taxLevel: 'document' | 'line';
  invoiceRounding: 'none' | 'nearest_rupee' | 'up_rupee' | 'down_rupee';
  /** standard (default): lines and taxes are rounded to paise. lr_exact: no intermediate rounding, total to the whole rupee. */
  arithmetic?: 'standard' | 'lr_exact';
  /** lr_exact only. add (default): tax is added to the total. show_separate: tax is printed but not added. rcm_note: reverse charge, no tax added. */
  gstPresentation?: 'add' | 'show_separate' | 'rcm_note';
}

export interface CalcException {
  dutyId: string | null;
  code: string;
  severity: 'error' | 'warning';
  message: string;
}
