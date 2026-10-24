import { Decimal as DecimalBase } from 'decimal.js';

/**
 * Isolated Decimal constructor for all money / quantity arithmetic.
 * Never use JS floating point for billed amounts.
 */
export const D = DecimalBase.clone({ precision: 40, rounding: DecimalBase.ROUND_HALF_UP });
export type Dec = InstanceType<typeof D>;

export type RoundMode = 'half_up' | 'half_even' | 'up' | 'down' | 'ceil' | 'floor';

const MODE_MAP: Record<RoundMode, DecimalBase.Rounding> = {
  half_up: DecimalBase.ROUND_HALF_UP,
  half_even: DecimalBase.ROUND_HALF_EVEN,
  up: DecimalBase.ROUND_UP,
  down: DecimalBase.ROUND_DOWN,
  ceil: DecimalBase.ROUND_CEIL,
  floor: DecimalBase.ROUND_FLOOR,
};

export function dec(v: DecimalBase.Value | null | undefined): Dec {
  if (v === null || v === undefined || v === '') return new D(0);
  if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`Invalid numeric value: ${v}`);
  return new D(v);
}

export function roundDp(v: Dec, dp: number, mode: RoundMode = 'half_up'): Dec {
  return v.toDecimalPlaces(dp, MODE_MAP[mode]);
}

/** Round to a multiple of `unit` (e.g. 0.5 hour, 1 km). */
export function roundToUnit(v: Dec, unit: Dec, mode: 'exact' | 'ceil' | 'floor' | 'nearest'): Dec {
  if (mode === 'exact' || unit.isZero()) return v;
  const q = v.div(unit);
  const r = mode === 'ceil' ? q.ceil() : mode === 'floor' ? q.floor() : q.toDecimalPlaces(0, DecimalBase.ROUND_HALF_UP);
  return r.mul(unit);
}

/** Money is always stored with 2 decimals as a string. */
export function money(v: Dec): string {
  return v.toFixed(2);
}

export function sum(values: Dec[]): Dec {
  return values.reduce((a, b) => a.add(b), new D(0));
}
