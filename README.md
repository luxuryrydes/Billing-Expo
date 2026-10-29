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

## 5. Running

Development (API on :4000, UI on http://localhost:5173 with API proxy):

```bash
npm run dev
```

Production (the API also serves the built UI):

```bash
npm run build
```

```bash
npm start
```

The document worker is not a separate service: the API starts it per document (`python -I worker/extract.py <file>`). On first open with an empty database the UI asks you to create the administrator.

Optional demo dataset (a DEMO department, DEMO rates/taxes, 78 September duties, a draft bill). Use a separate database folder; generated demo logins are written to `.env.local`:

```bash
DATABASE_URL=data/demo-db STORAGE_DIR=data/demo-files npm run seed:demo
```

### LR Standard invoice (merged-invoice format)

The format of the other LR Taxi Services billing app, available per department:
- **Billing Templates → New template → Format: LR Standard (merged invoice)** creates a template with a bordered letterhead (client, address, custom fields on the left; SAC / PAN / GSTIN / bill no / date on the right), a block per duty (`Duty for ( vehicle )`, `Upto : 80 kms/8 hrs duty`, `Total running : (km kms/h hrs)`, `Extra Hrs:`, `Extra Kms:`, night, driver allowance, `Toll Tax & Parking` under Non Taxable) and the totals as rows of the table ending in the red **L.R TAXI SERVICES** total. It goes through the normal preview-and-approve step, and every column, label and total can still be edited.
- The PDF is A4 landscape. The Excel is A4 portrait with live formulas (`UNIT × RATE`, `SUM`, `ROUND(tax,2)`, `ROUND(total,0)`) and a **Calculation Kit** sheet; the formulas carry the calculated values, so the file reconciles before Excel recalculates. Word export and the institution-specific layouts (MHRD, CBI, RBI, CRRI, per-user and per-trip bills) are not included.
- **Printed arithmetic** (Contract → Tax & invoice settings): *LR exact* keeps each line as unit × rate to four decimals, charges tax on the unrounded taxable sum, shows two decimals and rounds the bill total to the whole rupee, as the other app prints it; it also honours the department's GST mode (`show_separate` prints the tax without adding it, `rcm` prints `GST Under RCM(Invoice)`). The New template dialog can switch the chosen contract for you. *Standard* (the default, unchanged) rounds every line and tax to paise. Hour and km rounding and grace still come from the rate scheme; choose *exact* there to match the other app minute for minute. LR exact applies to bills calculated after the switch.
- Fill in the supplier profile (PAN, GSTIN) and the contract's SAC code, or the right-hand header lines print empty.

### Deploying on Vercel

`vercel.json` deploys the repository as one Vercel project with three services:

| Service | Folder | Public path | Role |
|---|---|---|---|
| `web` | `web/` | `/` (everything else) | the React app (static; unknown paths fall back to `index.html`) |
| `server` | `server/` | `/api/*` | the Fastify API |
| `worker` | `worker/` | internal only | reads PDF / Excel / Word files; the server reaches it through `WORKER_URL` (service binding) |

Before the first deploy, in the Vercel project settings → Environment Variables:
- `DATABASE_URL` — a PostgreSQL connection string (e.g. Neon or Supabase). Required: the embedded database needs a disk, which Vercel Functions do not have. Set `DATABASE_SSL=true` if the provider requires TLS.
- `ANTHROPIC_API_KEY` — optional, for AI reading of documents.

Differences from running locally: uploaded files are stored in the database; uploads are limited to 4 MB per file (Vercel's request limit); scanned images cannot be OCR-read (no Tesseract); the first administrator is created on the first visit, as locally.

## 6. Operating guide

1. **System Settings → Supplier profiles:** enter LR Taxi Services' legal name, address, GSTIN, PAN, bank details. Add vehicle categories (e.g. Innova, Dzire) and duty types.
2. **Departments / Clients → Add department**, then **Add contract** (validity, tax mode, rounding, approval levels, bill-number format).
3. Upload the contract documents on the contract's **Documents** tab (or use **Set up from documents** to create everything from them). Open each document, click a candidate to see its source text, and accept / correct / reject it. Resolve flagged conflicts. Departments and institutions can also be imported from Excel on **Departments & Institutions**, and rate cards on the contract's **Rate schemes** tab.
4. **Contract → Tax rules:** add each applicable tax with its source; an approver approves it.
5. **Rate Schemes → New scheme:** set applicability (dates, categories, duty types) and parameters, add components from the presets and enter the approved rates, check examples in the **test calculator**, **Submit for approval**; an approver approves.
6. **Billing Templates → New template:** design the layout (or upload the department's .xlsx and map cells), preview with sample data and with a real bill, then approve after reviewing the preview.
7. **Daily Duty Entry:** choose contract and date, type or paste rows, Save. Or **Import Excel / CSV**. Fix errors shown in red; a reviewer verifies duties in the **Duty Register**.
8. **Billing Workspace → New bill:** pick contract and month, **Calculate**, review the Duties / Calculation / Exceptions tabs (click any line for its full trace), exclude or fix problem duties, accept warnings with a reason, **Submit for review**, **Approve**, **Generate Excel & PDF**, check the reconciliation, download, **Mark submitted** with the diary reference.
9. Corrections after approval: **Revise** on the bill.

**Department & Rate Register (all departments and their rate cards in one workbook).** On **Departments & Institutions**, **Import rate register** reads the register (`Department Master` + `Department Rate Register` sheets) and shows what will change before anything is saved. **Export rate register** downloads the current data in the same layout. You can edit that file and import it back. Every upload screen (register, departments, institutions, rate cards, duty sheets) follows the same rule:
- rows that match what is saved are left alone;
- only changed departments, rates or duties are updated, and new ones are added;
- nothing is removed because it is missing from the sheet, and blank cells never clear a saved value;
- a changed rate becomes a new version from the chosen date, so earlier duties and bills keep their rate. A duty already on an approved bill is not changed (it is reported as locked).

**Rate card per department:** the **Rate card** button on each department lists vehicle, package, type (per km/hr or fixed), base fare, included km/hrs, extra km/hr, night charge and slot, driver allowance and tax. **Add rate** and **✎** create a new version from a date; **🗑** stops a rate after a last day and keeps its history. A plain "GST 18%" becomes IGST or CGST+SGST from the billing registration (DELHI/HR/UP GST) and the department's GSTIN state.

## 7. Verification performed

* `npm test` — **41 passed, 1 skipped** (the DRI comparison, which needs the fixture below):
  * engine (30): base-only, km excess, hour excess (exact and rounded), both, grace rules, overnight/cross-midnight, night windows, toll/parking non-taxable, half-up decimal rounding (93.345 → 93.35), missing/reversed odometer errors, rate version by effective date, vehicle-category rates, ambiguous/unapproved schemes, mixed taxable/non-taxable with rupee rounding, line-level and inclusive tax, missing tax rule, monthly hire + monthly km limit + minimum guarantee, 3,000-duty month; validation of duplicates, overlaps, contract dates, configurable hard errors; formula language safety.
  * end-to-end API on a real PostgreSQL engine (PGlite): setup and roles, tax-rule source requirement, rate submit/approve/immutability/auto-close, template preview + approval, duty entry with leading-zero vehicle numbers and overnight duty, Excel import (header detection, `0099` kept as text, next-day closing flagged), full month-end bill (expected ₹21,316.00 hand-calculated and matched), approval, Excel/PDF generation with all reconciliation checks passing, double-billing refused, revision flow superseding the original, database trigger blocking edits to a superseded bill, document upload → extraction of base rate / package km & hours / extra-km rate / tax rates as *pending* candidates, role checks on review.
* `npm run build` — server (tsc) and web (tsc + Vite) build cleanly. Compiled server checked: serves UI and API, unauthenticated API calls return 401.
* A generated bill PDF was rasterised and inspected (grouped headers, totals, summary, amount in words, leading-zero vehicle numbers); the TOTAL label was then widened across empty cells in both PDF and Excel.
* The UI was exercised in a browser against the demo data: sign-in, dashboard figures, contracts, rate schemes, duty register, and calculating a 78-duty bill from the Billing Workspace (₹3,35,963.00; all engine checks passing).

### DRI September reference comparison
The two reference PDFs (`Day to Day Duty September.pdf`, `DRI Sep.pdf`) were **not available** in this workspace, so the DRI comparison has **not been run** and no DRI rates were entered anywhere. To run it: copy `server/fixtures/dri-sep.example.json` to `dri-sep.json`, enter the rates **confirmed against the approved DRI contract** and the duty rows / amounts from the reference bill, and run `npm test`. The report `server/fixtures/dri-sep.report.json` lists every per-duty, per-component difference; `DRI_STRICT=1` makes differences fail the test. Differences should be investigated, not "fixed" by changing formulas.

### Real-document checks (fixtures kept out of git)
* `departments-2026-10-24.xlsx` (19 rows) and `institutions-2026-10-24.xlsx` (6 rows) import through the upload workflow; re-importing changes nothing; an edited copy updates 2, adds 1 and keeps a row that was removed from the file; invalid GSTINs block the commit unless "valid rows only" is chosen, with a downloadable report. "18% GST" (DRI, YEIDA) is flagged as ambiguous rather than guessed; "GST Under RCM(Invoice)" is flagged as reverse charge.
* The DRI contract, rate schedule and sample bill (separately or as `DRI Sep_merged.pdf`) produce the proposal: department GSTIN 07DELD08333D1DX, contract GEMC-511687707217712 (06-11-2025 to 05-11-2026, monthly), LR GSTIN 06AAGFL5356A1ZM used on the bill, three categories with 4 h/40 km and 8 h/80 km packages, IGST 18% (checked against the sample bill arithmetic), bill series LRTH/{FYS}/{SEQ:4} continuing at 0768, and the duty-block format.
* Recalculating each of the 111 duties on DRI Sep from the bill's own "Total running" figures reproduces base, extra-km and extra-hour amounts exactly for 102; the 9 differences are inconsistencies inside the reference bill (e.g. Innova duties at Premium Sedan rates). Billing September from the duty sheet gives different totals because the sheet has 86 DRI rows (the bill has 111), its km/time readings differ from the bill's, and it has no toll column; one mistyped odometer (2,28,127 km) is now a hard error.

## 8. Known limitations / still to do

* **Reference documents:** DRI and day-to-day duty PDFs not yet processed (see above). The default bill layout is a generic duty-bill layout, not yet matched to the DRI format — build and approve the DRI template after comparing the preview with `DRI Sep.pdf`.
* **OCR:** scanned pages need Tesseract installed on the server; without it the page is flagged "no text layer" and values must be entered manually.
* **AI extraction** is implemented and type-checked but was not run against the live API (no key configured here); rule-based extraction is tested.
* **Department .xlsx templates:** cell mapping is edited as JSON (with a workbook cell viewer); there is no click-to-map designer yet. Inserted rows copy the template row's style; merged cells or formulas below the table that reference the table range are not re-pointed automatically (use `{START}`/`{END}` tokens in mapped formulas). Not yet tried on a real department workbook.
* **PDF templates** are reproduced with the designer; an uploaded PDF is a visual reference, not filled in place.
* **PostgreSQL/Supabase:** schema and code are standard PostgreSQL but were tested on PGlite (embedded PostgreSQL), not on a hosted server.
* Extraction runs in-process in the background (no separate job queue); fine for a single server.
* Night-charge window and extra-hour rounding are not stated in the DRI contract; the wizard proposes 22:00–06:00 and half-hour rounding up and asks for confirmation. The DRI bill does not charge nights consistently with any single window.
* Sample-bill import copies structure and wording, not fonts, borders or exact spacing; Excel samples get their table and labelled header cells mapped automatically, totals cells must be mapped by hand.
* Per-duty attachment upload is not in the UI yet (use the supporting-document reference field; duty sheets can be uploaded as documents). Public-holiday calendars are not modelled (conditions can use `weekday` / `is_sunday`).
* No automated browser tests; UI flows were checked manually.
