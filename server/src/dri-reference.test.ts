/**
 * DRI September reference comparison.
 *
 * Fill server/fixtures/dri-sep.json (see dri-sep.example.json) with
 *   - the rate configuration CONFIRMED against the approved DRI contract, and
 *   - the duty rows and per-component amounts as printed on "DRI Sep.pdf".
 * The test recalculates each duty with the engine and writes a discrepancy
 * report to fixtures/dri-sep.report.json. Differences are recorded, never
 * "fixed" by changing the formula. Set DRI_STRICT=1 to fail on any difference.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { calculateDuty } from './engine/duty.js';
import { dec } from './engine/decimal.js';
import { RateConfigSchema, type SchemeVersion } from './engine/types.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const file = path.join(dir, 'dri-sep.json');
const present = fs.existsSync(file);

describe('DRI September reference bill', () => {
  it.skipIf(!present)('recalculates every reference duty and reports discrepancies', () => {
    const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(fx.confirmedBy, 'Record who confirmed the rates against the approved contract').toBeTruthy();
    const versions: Record<string, SchemeVersion> = {};
    for (const [cat, cfg] of Object.entries(fx.rates)) {
      versions[cat] = { id: cat, schemeId: cat, schemeName: `DRI ${cat}`, versionNo: 1, status: 'approved', effectiveFrom: '2000-01-01', effectiveTo: null, vehicleCategoryIds: [], dutyTypeCodes: [], config: RateConfigSchema.parse(cfg) };
    }
    const report: unknown[] = [];
    for (const [i, d] of (fx.duties as any[]).entries()) {
      const v = versions[d.category];
      if (!v) { report.push({ ref: d.ref, problem: `No confirmed rates for category ${d.category}` }); continue; }
      let lines: Record<string, string> = {};
      try {
        lines = Object.fromEntries(calculateDuty({ id: `dri-${i}`, vehicleRegNo: d.vehicleRegNo ?? '', vehicleCategoryId: null, vehicleCategoryName: d.category, dutyTypeCode: d.dutyType ?? null, otherCharges: null, toll: d.toll ?? null, parking: d.parking ?? null, ...d }, v).lines.map((l) => [l.componentCode, l.amount]));
      } catch (e) {
        report.push({ ref: d.ref, problem: (e as Error).message });
        continue;
      }
      const codes = new Set([...Object.keys(lines), ...Object.keys(d.billed ?? {})]);
      for (const c of codes) {
        const calc = dec(lines[c] ?? '0');
        const billed = dec(d.billed?.[c] ?? '0');
        if (!calc.eq(billed)) report.push({ ref: d.ref, date: d.dutyDate, component: c, referenceBill: billed.toFixed(2), engine: calc.toFixed(2), difference: calc.sub(billed).toFixed(2) });
      }
    }
    fs.writeFileSync(path.join(dir, 'dri-sep.report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), discrepancies: report }, null, 2));
    if (report.length) console.warn(`DRI reference: ${report.length} discrepancy item(s) — see fixtures/dri-sep.report.json`);
    if (process.env.DRI_STRICT === '1') expect(report).toEqual([]);
  });
});
