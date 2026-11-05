# LR Taxi Services — Billing, Invoicing & Duty-Slip Scanning Guide

## 1. One-time setup (before any billing)
1. **Companies** (Companies page): your billing company name, GSTIN, address, bank details — printed on every invoice.
2. **GST settings** (GST page): GST % with CGST/SGST (same state) or IGST (other state). One is marked Default.
3. **Departments**: client department name, aliases (other spellings seen on slips), invoice prefix, default rate package, default GST, client details.
4. **Institutions**: client institution code/name, GST mode:
   - `include` — GST added to bill total.
   - `show_separate` — GST shown on bill but NOT added to payable.
   - `rcm_note` — no GST charged; Reverse Charge note printed.
5. **Rate Packages / Rate Cards**: per vehicle type — base fare, included KM & hours, extra per-KM and per-hour rate, minimum KM per day, night charge & night window, driver allowance (DA) per day, fixed-price flag, tax mode.

## 2. Scanning a duty slip (Upload page)
1. Choose department (and institution/company), then select the slip photo or PDF.
2. The file is saved to storage (`duty-slips` bucket) and a `duty_slips` record is created (status `uploaded`) so the original can be opened later from the invoice.
3. The scan is read by **OCR.space** (server-side, key `OCR_SPACE_API_KEY`, never in the browser) — `src/lib/ocr.functions.ts` + `ocr-space-server.ts`.
4. `ocr-field-parsers.ts` pulls out: slip no, date(s), vehicle number, vehicle type, driver, guest/user, pickup/drop, opening & closing KM, start & end time, tolls, parking. Dates accept dd-mm-yy, mm-dd-yy, "8 Aug 2026"; multi-day trips keep each leg's exact date.
5. Computed fields: **Total KM = closing − opening**, **Total hours = end − start time**.
6. **You review every field on screen and correct anything wrong** — nothing is saved until you press Save.
7. On Save, a `trips` row is created with all fields, linked to the slip.

Bulk Upload does the same for many slips at once; each one is reviewed in a list before saving.

## 3. How a trip is calculated (`computeTrip` in `src/lib/billing.ts`)
- **Days** = from trip duration (multi-day trips count each day).
- **Effective KM** = max(actual KM, minimum KM × days).
- **Extra KM** = Effective KM − (included KM × days), if positive → × extra-KM rate.
- **Extra hours** = actual hours − (included hours × days), if positive → × extra-hour rate.
- **Base** = base fare × days (fixed-price packages: × 1).
- **Night charge** = saved night amount, or charged when trip time overlaps the package night window.
- **Driver allowance** = DA × days.
- **Taxable** = Base + Extra KM + Extra hours + Night + DA.
- **GST** = Taxable × GST % (split CGST/SGST or IGST), adjusted by the institution GST mode above.
- **Grand total** = Taxable + GST + Parking + Tolls (parking & tolls are not taxed).
- GST source: rate card's tax setting → department default GST → global default GST.
- All amounts rounded to 2 decimals.

## 4. Generating the invoice (`src/lib/invoice.ts`)
1. After calculation, the trip is updated with all amounts.
2. `createInvoiceFromTrips` creates an `invoices` row and links trips via `invoice_trips` (one or many trips per invoice — month-wise department bills group them).
3. **Invoice number** format: `LR-YYMM-####` (e.g. LR-2611-0007), next number per month.
4. Status flow (`invoice-status.ts`): Draft → Sent → Paid (or Cancelled).
5. Outputs:
   - **PDF** (`pdf.ts`, `generateInvoicePdfBytes`) — company header, client, trip table, GST block, totals in words, bank details.
   - **Excel** (`bill-xlsx.ts`) — uses live Excel formulas so totals recalculate if you edit.
   - **Merged Excel** of several invoices (`exportMergedInvoicesXlsx`).
   - `bill-template.ts` rebuilds rows from current rate card values (can differ from the stored totals if rates were changed after billing).
6. Deleted trips/invoices go to Recycle Bin and can be restored.

## 5. Day-to-day checklist
1. Upload/scan slips → check vehicle no, dates, KM, times → Save.
2. Trips page: check all trips of the month for the department.
3. Select trips → Create invoice → download PDF/Excel → send to client.
4. Mark invoice Sent, then Paid when money arrives.

## 6. Files in this zip
- `source/lib/` — billing math, invoice creation, PDF/Excel, OCR scanning & parsers, date reading.
- `source/routes/` — the screens: upload, upload-bulk, trips, invoices, packages, departments, institutions, companies, gst.

Database tables used: companies, gst_settings, departments, institutions, packages, department_rate_cards, duty_slips, trips, invoices, invoice_trips. No passwords, keys or customer records are included.
