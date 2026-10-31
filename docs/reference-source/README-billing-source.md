# LR Taxi Services — billing formatting, calculations and SQL paths

Source snapshot: 26 October 2026. Paths below are full paths relative to the software project root; the ZIP preserves that folder structure.

## Start here

| Purpose | Full source path |
|---|---|
| Trip fare calculation | `src/lib/billing.ts` |
| Build bill rows, resolve rate cards, client/vendor details and GST | `src/lib/bill-template.ts` |
| PDF and Word bill layouts, institution-specific layouts, Excel export entry points | `src/lib/bill-export.ts` |
| Editable Excel bill layout and live calculation formulas | `src/lib/bill-xlsx.ts` |
| Create invoice from saved trips, invoice totals, older Excel invoice layout | `src/lib/invoice.ts` |
| Basic invoice PDF layout, PDF merging and download | `src/lib/pdf.ts` |
| Invoice screen, preview and export actions | `src/routes/_app/invoices.tsx` |
| Trip entry, editing and calculations | `src/routes/_app/trips.tsx` |
| Rate packages | `src/routes/_app/packages.tsx` |
| Department rate cards | `src/routes/_app/departments.tsx` |
| Institution bill templates and rate cards | `src/routes/_app/institutions.tsx` |
| Single / bulk duty-slip entry | `src/routes/_app/upload.tsx`, `src/routes/_app/upload-bulk.tsx` |
| Merge parsing, save and rollback | `src/routes/api/public/merge.parse.ts`, `src/routes/api/public/merge.commit.ts`, `src/routes/api/public/merge.rollback.ts` |

## Calculation implemented in billing.ts

`computeTrip(input, gst)` calculates:

- Days: positive explicit days, otherwise the ceiling of the trip duration in days, minimum one.
- Multiplier: one for a fixed-price package; duty days otherwise.
- Effective KM: maximum of actual KM and minimum KM × multiplier.
- Extra KM: maximum of zero and effective KM − included KM × multiplier; disabled for fixed-price packages.
- Extra hours: maximum of zero and total hours − included hours × multiplier. Fixed-price packages disable these; outstation packages with zero included hours also disable them.
- Base amount: base fare × multiplier.
- Night charge: night rate × overlapping night windows (or the time-only fallback). Explicit night overrides are applied. Only non-fixed, non-outstation packages charge this.
- Driver allowance: daily allowance × multiplier, only for non-fixed, non-outstation packages.
- Taxable amount: base + extra KM charges + extra hour charges + night charges + driver allowance.
- GST: configured split CGST/SGST, IGST or simple GST on the taxable amount. RCM does not add GST.
- Grand total: taxable amount + GST + parking + tolls. Parking and tolls sit outside the GST base.
- Returned monetary figures are rounded to two decimal places.

`invoice.ts` sums the SAVED trip amounts; it does not rerun computeTrip when creating the invoice.

## Formatting is a separate calculation path

`bill-template.ts` rebuilds bill rows using package/rate-card values, exact units × rates, and sums the displayed rows. It can therefore differ from stored invoice totals when rates have changed. It handles fixed-price and outstation rows, saved night/driver totals, institution settings, per-user splitting and whole-rupee final rounding. Its extra-KM display uses actual KM, unlike computeTrip's minimum-KM floor.

Institution GST modes include `include`, `show_separate` (tax displayed but excluded from the payable total), and `rcm_note` (no GST added).

`bill-xlsx.ts` contains live Excel formulas: line amount = UNIT × RATE, taxable totals = SUM of line amounts, tax = ROUND(taxable × percentage / 100, 2), final total = ROUND(sum of applicable amounts, 0). Its Calculation Kit is a generic what-if sheet; it does not encode every fixed-price, outstation, minimum-KM, automatic-night or institution exception. The kit's TDS check is not the core trip billing formula. Review differences before using it as a replacement engine. No calculations have been changed in this export.

## SQL and query paths

- **`SQL-PATHS.txt`** lists every included historical billing-related SQL migration, with its original full path.
- **`BILLING-QUERY-PATHS.md`** lists application database query calls by exact file and line, with source excerpts. Most runtime queries are client query-builder calls, not `.sql` files.
- **`SOURCE-PATHS.txt`** lists the supplied source files.
- **`MANIFEST.json`** records the archive scope.

Main database tables: `companies`, `packages`, `gst_settings`, `duty_slips`, `trips`, `invoices`, `invoice_trips`, `departments`, `department_rate_cards`, `institutions`, `merge_batches`. Relevant functions include `seed_default_institutions`, `current_owner` and billing-related ownership/security helpers in the historical migrations.

The original core schema is in:
`supabase/migrations/20260511085058_c07a4f27-b435-4365-9776-29674eba69ea.sql`.

Core invoice creation currently generates `LR-YYMM-####` in `src/lib/invoice.ts`; a historical invoice sequence exists in SQL but this function does not use it.

## Important scope and safety notes

This is a billing SOURCE REFERENCE, not a runnable full application, current database backup, or ready-to-run consolidated schema. Imported dependencies such as the database client, auth, UI controls, OCR and Google Drive integration remain part of the original application and are not all bundled. Dependency names used by these files include `@tanstack/react-router`, `@tanstack/react-start`, `@tanstack/react-query`, `pdf-lib`, `docx`, `xlsx`, `exceljs`, `zod`, and `@lovable.dev/mcp-js`; use the matching original application's dependencies when integrating.

Historical migrations are copied unchanged. Some also create or alter unrelated/previously removed modules, policies, triggers or seed rows. Their presence here does not mean those modules remain active. Do NOT execute the entire migration folder against a live database or assume it is a billing-only clean installation script. These files were selected from repository SQL references; the current hosted database schema, SQL executed outside the repository, and stored row contents were not inspected or exported.

No `.env`, private credentials, customer database records, Git metadata, installed dependencies, build output or full app archive is included. No application or database changes were made.
