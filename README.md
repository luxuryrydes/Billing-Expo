# LR Taxi Services — Billing & Duty Management

A configurable billing platform for LR Taxi Services Pvt. Ltd.: from contract documents and approved rate rules, through daily duty entry, to department-specific Excel/PDF bills with a full calculation trace and audit history.

**Core principle:** bill amounts come only from a deterministic, tested calculation engine applied to rules that a person has approved. Document extraction (rule-based, optionally AI) only proposes candidate terms with their source text; it never creates or approves billing rules.

---

## 1. Modules

| Module | What it does |
|---|---|
| Dashboard | Live counts from the database: departments, contracts, duties today, duties with errors / awaiting verification, bills preparing / awaiting approval / generated, open exceptions, contracts with no duty yesterday, department × month totals, recent bills and documents. |
| Set up from documents | Upload a department's contract, rate schedule and sample bill (separately or as one combined PDF), plus optionally its duty sheet. The department, contract, LR invoicing details, vehicle categories with model aliases, package rates, tax observed on the sample bill, bill-number series and bill format are read and shown with their source page for checking; on confirmation they are created, with rates, tax and format as drafts awaiting approval. |
| Departments & Institutions | One dashboard with Departments (keyed by name: aliases, invoice prefix, default package, GST text such as "Split 2.5+2.5%", company, address, GSTIN) and Institutions (keyed by code: header title/subtitle, invoice prefix, GST mode, CGST/SGST/IGST %, vendor SAC and GSTIN, custom duty fields, terms). Add/Edit by hand or Import Excel (.xlsx/.xls/.csv): preview with sheet choice, column mapping, extra columns kept as extra fields, rows to add/update/unchanged/invalid with field-level changes, error report, all-or-nothing commit (or import valid rows only). Re-importing updates matching records and adds new ones; nothing is deleted because it is missing; blank cells never clear values. Download template / current list. Each record has its contracts and documents. |
| Contracts | Multiple contracts per department: validity, PO/work order, billing frequency, tax mode (inclusive/exclusive), document- or line-level tax, invoice rounding, 1- or 2-level approval, bill-number format, contract-specific validation thresholds and extra duty fields. |
| Tax rules | Per contract, effective-dated CGST/SGST/IGST/UTGST/CESS/other. No rate is assumed; a rule needs a recorded source (clause/notification) and an approver before it applies. A 0% rule records a confirmed exemption. |
| Documents | Uploaded where they belong: on a department or contract's Documents tab (and in Set up from documents). Re-uploading a document of the same type for the same department/contract offers "Update existing document" (new version; older versions kept and restorable) or "Keep as a separate document"; identical files are flagged; documents of other departments/contracts are never offered. A Python worker reads PDF, Excel (.xlsx/.xls), Word, CSV (OCR when Tesseract is installed); candidate terms are reviewed with their source text. |
| Rate Schemes | Versioned, effective-dated rules per contract, vehicle category and duty type. Package parameters (included km/hours, grace rule, hour/km rounding, km adjustment, night window, monthly limits) plus ordered charge components whose quantity and condition are safe formulas (e.g. `extra_km`, `max(0, total_km - monthly_included_km)`, `duty_type == 'OUTSTATION'`). Components are per duty, per vehicle-period, or per bill; charge, reimbursement or deduction; taxable or non-taxable; with optional min/max and clause reference. Draft → submit → approve; approved versions are immutable (database trigger); a new version auto-closes the previous one; overlapping approved versions are refused. Built-in test calculator shows every step. |
| Billing Templates | Per department/contract layouts: duty rows, charge rows, or duty blocks (heading row per duty followed by package / running / extra km / extra hours / night / toll rows, as on the DRI bill); date and number styles; header fields; totals and tax-row wording; or the department's own .xlsx mapped cell-by-cell. "Import sample bill / invoice format" learns a draft from a PDF or Excel sample (a new format, or a new version of an existing one). Preview with sample data or a real bill; approval requires confirming the preview was reviewed. Versions lock on approval; bills keep the version they were approved with. |
| Billing Export / Invoices | Invoice list with PDF/Excel downloads, date-wise bill creation, import sample bill / invoice format, invoice formats by department, import billing data (duty sheets), export billing data (bills, taxes and lines to Excel; duty register). |
| Rate-card import | On a contract's Rate schemes tab or Rate Schemes page: Excel/CSV with any column layout (mapped by the user) or a PDF rate table. Each row is compared with the currently approved rate for the same vehicle category and package (current → incoming shown); changed or new rates become new draft versions from a chosen effective date; unchanged rows are left alone; a date that would rewrite already-approved rates is refused, so earlier duties and bills keep their rates. |
| Daily Duty Entry | Excel-like grid per contract and date: paste blocks from Excel, Enter to move down, Ctrl+D to copy the previous row, contract-specific fields. Import wizard for Excel, CSV and PDF duty sheets with automatic heading detection and column mapping; a shared sheet is split by its Department column into each department's contract; vehicle types are matched to categories by name or alias; "?"/"-" marks are treated as blank; dry-run check, leading-zero-safe vehicle numbers, explicit handling of closing times past midnight. |
| Duty Register | Filter by department, contract, dates, vehicle, driver, status, billing state, validation; verify in bulk; per-duty history with old → new values and correction reasons; void with reason; Excel export. |
| Validation | Missing mandatory fields, invalid numbers/times, negative or reversed odometer, zero/high km, zero/long duration, cross-midnight handled from full date-times, duplicates and overlaps for the same vehicle, outside contract dates, unknown vehicle, unknown duty type, missing expense evidence. Warnings vs. errors are configurable per contract. Readings are never silently repaired. |
| Billing Workspace | Step-by-step month-end: select contract and period → check eligible duties (already-billed, errors, unverified, vehicle coverage gaps) → calculate → resolve exceptions (errors must be fixed or the duty excluded with a reason; warnings need a recorded decision) → submit for review → (review) → approve (bill number assigned, everything frozen) → generate Excel + PDF + internal calculation register with automatic reconciliation → mark submitted. Statuses: Draft, Calculation pending, Validation required, Under review, Approved, Generated, Submitted (+ Superseded, Cancelled). |
| Revisions | An approved bill is never edited. "Revise" creates revision N+1 with the same bill number; duties on the original can be corrected (with reason) while the revision is open; approving the revision supersedes the original and moves the duty links. |
| Reports & Reconciliation | Department-wise billing summary, tax summary by bill and tax type, open-exception report, duty register export. Each bill has its calculation register and reconciliation result. |
| Users, Audit Logs, Settings | Roles: Administrator, Billing operator, Billing reviewer, Approver, Read-only. Optional maker-checker (preparer cannot approve). Full audit log. Supplier (LR) invoice profiles, vehicle categories, duty types, vehicles, drivers, default validation thresholds. |

## 2. Architecture

```
web/      React 19 + TypeScript + Vite + TanStack Query  (UI)
server/   Node.js + TypeScript + Fastify + Zod           (API, auth, workflow)
  src/engine/     calculation engine — the single source of billed amounts
                  decimal.js arithmetic, safe formula language, rate selection,
                  duty/period/bill components, taxes, invoice rounding, checks
  src/services/   duty validation & import, document extraction, render model,
                  Excel (ExcelJS) and PDF (pdfmake) writers, billing workflow
  migrations/     PostgreSQL schema (plain SQL)
worker/   Python document worker (PyMuPDF, pdfplumber, openpyxl, python-docx)
```

* **Database:** PostgreSQL / Supabase via `DATABASE_URL`, or embedded **PGlite** (the PostgreSQL engine compiled to WebAssembly) for local use and tests — same SQL and migrations.
* **One authoritative calculation:** only `server/src/engine` computes amounts. Python is used for reading documents only. Duty-level, vehicle-period and bill-level components, then taxes, then invoice rounding; every line stores its inputs, formula, rule version and clause.
* **Snapshots:** each calculation stores an immutable snapshot (inputs incl. rate versions, tax rules, client/supplier details and duties; outputs; SHA-256). Generated files are re-rendered from the snapshot, so a historical bill stays explainable after rates, templates or client details change.
* **Excel ↔ PDF agreement:** both are rendered from one render model; after generation the system reads the Excel back and extracts the PDF text, and checks grand total, bill number, every vehicle number and every summary line.
* **AI (optional):** if `ANTHROPIC_API_KEY` is set, Claude (`claude-opus-5-5`, structured output) proposes extra candidate terms. Each must quote the document; quotes that cannot be found in the page text are discarded. Document text is treated as data and the model is told to ignore instructions inside it.
* **Security:** scrypt password hashing, httpOnly SameSite session cookie, role permissions on every endpoint, login throttling, upload type/size/signature checks (no macro formats), files stored by hash outside the web root, no secrets in frontend code, database triggers that block edits to approved bills, bill lines and approved rate versions, RLS enabled on all tables so Supabase anon/authenticated keys cannot read them directly (the server connects as owner).

### Data model (main tables)
`app_users, sessions, app_settings, files, supplier_profiles, clients, contracts, vehicle_categories, duty_types, vehicles, drivers, documents, document_versions, extracted_items, rate_schemes, rate_scheme_versions, tax_rules, duty_import_batches, duties, billing_templates, billing_template_versions, bills, bill_duties (one active bill per duty — partial unique index), calculation_snapshots, bill_lines, bill_tax_lines, billing_exceptions, approvals, generated_files, audit_events`. See `server/migrations/001_init.sql`.

## 3. Setup

**Quick start:** install Node.js 20+ (and Python 3.10+ for reading PDF/Excel documents), then double-click `start-windows.bat` (on Linux/macOS run `sh start.sh`). The first run installs packages, builds the app and opens http://localhost:4000, where you create the administrator. Later runs start the app straight away. Your data is kept in the `data` folder.

Manual setup:

Requirements: Node.js 20+ (tested on 24), Python 3.10+ (tested on 3.14). Optional: Tesseract OCR for scanned documents; PostgreSQL 15+ or a Supabase project.

```bash
npm install
```

```bash
python -m venv worker/.venv
```

```bash
worker/.venv/Scripts/python -m pip install -r worker/requirements.txt
```
(On Linux/macOS use `worker/.venv/bin/python`.)

```bash
cp .env.example .env
```

Migrations run automatically when the server starts; to run them separately:

```bash
npm run migrate
```

## 4. Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `data/pglite` | `postgres://…` for PostgreSQL/Supabase (server-side connection string), or a folder for embedded PGlite |
| `DATABASE_SSL` | `false` | `true` for hosted Postgres that requires TLS |
| `STORAGE_DIR` | `data/files` | uploaded originals and generated bills |
| `MAX_UPLOAD_MB` | `25` | upload limit |
| `PORT`, `HOST` | `4000`, `127.0.0.1` | API / production server |
| `SESSION_HOURS` | `12` | session lifetime |
| `COOKIE_SECURE` | `false` | set `true` behind HTTPS |
| `PYTHON_BIN` | `worker/.venv/...` | Python for the document worker |
| `ANTHROPIC_API_KEY` | empty | optional AI extraction |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | model for AI extraction |

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
