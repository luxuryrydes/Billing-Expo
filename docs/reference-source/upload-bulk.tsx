import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { extractDutySlip } from "@/lib/ocr.functions";
import { uploadToDrive } from "@/lib/google-drive.functions";
import { driveFolder, resolveInstitutionName } from "@/lib/drive-mirror";
import { supabase } from "@/integrations/supabase/db";
import { computeTrip, gstFromRateCard, isWithinNightWindow, type Pkg, type GstSetting } from "@/lib/billing";
import { createInvoiceFromTrips } from "@/lib/invoice";
import { PageHeader } from "@/components/app/PageHeader";
import { DataCard } from "@/components/app/DataCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Files, Sparkles, Trash2, CheckCircle2, AlertTriangle, Image as ImageIcon } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Search, ClipboardPaste, ClipboardCopy, Download, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { CalendarIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/upload-bulk")({ component: BulkUploadPage });

const MAX_PAGES = 200;
const VEHICLE_TYPES = ["Innova", "Dzire", "Ciaz"];

const PASTE_COLUMNS: { key: string; label: string }[] = [
  { key: "duty_date", label: "Date" },
  { key: "car_number", label: "Car number" },
  { key: "vehicle_type", label: "Vehicle type" },
  { key: "driver_name", label: "Driver" },
  { key: "guest_name", label: "Guest" },
  { key: "opening_km", label: "Opening KM" },
  { key: "closing_km", label: "Closing KM" },
  { key: "total_km", label: "Total KM" },
  { key: "opening_time", label: "Opening time" },
  { key: "closing_time", label: "Closing time" },
  { key: "total_hours", label: "Total hours" },
  { key: "parking", label: "Parking" },
  { key: "tolls", label: "Tolls" },
  { key: "days", label: "Days (outstation)" },
  { key: "__package__", label: "Package (by name)" },
];

type Row = {
  page: number;
  status: "pending" | "ocr" | "ready" | "saving" | "saved" | "error";
  error?: string;
  thumb?: string;
  storage_path?: string;
  duty_slip_id?: string;
  trip_id?: string;
  invoice_no?: string;
  custom_fields?: Record<string, string>;
  package_id?: string | null;
  data: Record<string, any>;
};

function BulkUploadPage() {
  const ocr = useServerFn(extractDutySlip);
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [institutionId, setInstitutionId] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [autoInvoice, setAutoInvoice] = useState(true);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);

  // Filters
  const [search, setSearch] = useState("");
  const [filterVehicle, setFilterVehicle] = useState<string>("");
  const [filterPackage, setFilterPackage] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<string>("");

  // Paste dialog
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteCol, setPasteCol] = useState<string>("duty_date");
  const [pasteText, setPasteText] = useState("");
  const [pasteScope, setPasteScope] = useState<"filtered" | "all">("filtered");
  const [pasteMode, setPasteMode] = useState<"text" | "fill" | "from_col">("text");
  const [pasteSourceCol, setPasteSourceCol] = useState<string>("car_number");
  const [pasteFillValue, setPasteFillValue] = useState<string>("");

  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: async () => (await supabase.from("departments").select("*").order("name")).data ?? [],
  });
  const institutions = useQuery({
    queryKey: ["institutions"],
    queryFn: async () => (await supabase.from("institutions" as any).select("*").order("name")).data ?? [],
  });
  const companies = useQuery({
    queryKey: ["companies"],
    queryFn: async () => (await supabase.from("companies").select("id, name").order("name")).data ?? [],
  });
  const rateCards = useQuery({
    queryKey: ["rate-cards", departmentId, institutionId],
    enabled: !!departmentId || !!institutionId,
    queryFn: async () => {
      let q = supabase.from("department_rate_cards").select("*").order("vehicle_name");
      if (institutionId) q = q.eq("institution_id", institutionId);
      else if (departmentId) q = q.eq("department_id", departmentId);
      return (await q).data ?? [];
    },
  });

  const selectedInstitution = (institutions.data ?? []).find((i: any) => i.id === institutionId);
  const instCustomFields: { key: string; label: string; source: string }[] =
    (selectedInstitution as any)?.custom_fields ?? [];

  const pkgById = useMemo(() => {
    const m = new Map<string, any>();
    for (const rc of rateCards.data ?? []) m.set(rc.id, rc);
    return m;
  }, [rateCards.data]);

  function matchRateCardByVehicle(vehicleLike: any) {
    const vehicle = String(vehicleLike || "").toLowerCase();
    return (rateCards.data ?? []).find((rc: any) =>
      vehicle && String(rc.vehicle_name || "").toLowerCase().includes(vehicle)
    ) ?? null;
  }

  function findRateCardForRow(row: Row) {
    if (row.package_id) return pkgById.get(row.package_id) ?? null;
    return matchRateCardByVehicle(row.data.vehicle_type || row.data.car_number)
      ?? ((rateCards.data ?? []).length === 1 ? (rateCards.data ?? [])[0] : null);
  }

  useEffect(() => {
    if (!(rateCards.data ?? []).length) return;
    setRows((s) => s.map((r) => {
      if (r.package_id) return r;
      const match = findRateCardForRow(r);
      return match ? { ...r, package_id: match.id } : r;
    }));
  }, [rateCards.data]);

  function pkgToPricing(rc: any): Pkg | null {
    if (!rc) return null;
    return {
      package_type: rc.package_type ?? null,
      vehicle_name: rc.vehicle_name ?? null,
      base_fare: Number(rc.base_fare || 0),
      included_km: Number(rc.included_km || 0),
      included_hours: Number(rc.included_hours || 0),
      extra_km_rate: Number(rc.extra_km_rate || 0),
      extra_hour_rate: Number(rc.extra_hour_rate || 0),
      night_charges: Number(rc.night_charge || 0),
      driver_allowance: Number(rc.driver_allowance || 0),
      minimum_km: 0,
      is_fixed_price: !!rc.is_fixed_price,
      tax_mode: rc.tax_mode ?? null,
      gst_pct: Number(rc.gst_pct || 0),
      cgst_pct: Number(rc.cgst_pct || 0),
      sgst_pct: Number(rc.sgst_pct || 0),
      igst_pct: Number(rc.igst_pct || 0),
      night_start_time: rc.night_start_time ?? null,
      night_end_time: rc.night_end_time ?? null,
    };
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.type !== "application/pdf") {
      toast.error("Please upload a PDF file");
      return;
    }
    setBusy(true);
    setRows([]);
    try {
      // Lazy-load pdfjs in browser only
      const pdfjs: any = await import(/* @vite-ignore */ "pdfjs-dist/build/pdf.mjs" as any);
      const workerMod: any = await import(/* @vite-ignore */ "pdfjs-dist/build/pdf.worker.mjs?url" as any);
      const workerUrl = workerMod.default;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

      const buf = await f.arrayBuffer();
      const pdf = await pdfjs.getDocument({ data: buf }).promise;
      const total = Math.min(pdf.numPages, MAX_PAGES);
      if (pdf.numPages > MAX_PAGES) {
        toast.warning(`PDF has ${pdf.numPages} pages — only first ${MAX_PAGES} will be processed.`);
      }
      setProgress({ done: 0, total });

      // Render all pages to JPEG blobs first
      const pageImages: { page: number; blob: Blob; dataUrl: string }[] = [];
      for (let p = 1; p <= total; p++) {
        const page = await pdf.getPage(p);
        const viewport = page.getViewport({ scale: 2.0 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d")!;
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        const blob: Blob = await new Promise((res) =>
          canvas.toBlob((b) => res(b!), "image/jpeg", 0.85),
        );
        const dataUrl = canvas.toDataURL("image/jpeg", 0.5);
        pageImages.push({ page: p, blob, dataUrl });
      }

      // Init rows
      const initial: Row[] = pageImages.map((p) => ({
        page: p.page,
        status: "ocr",
        thumb: p.dataUrl,
        package_id: null,
        data: {},
      }));
      setRows(initial);

      // Process pages with concurrency
      const concurrency = 3;
      let cursor = 0;
      let done = 0;
      const { data: { user } } = await supabase.auth.getUser();

      async function processOne(idx: number) {
        const item = pageImages[idx];
        try {
          // Upload page image to storage as the duty slip image
          const path = `${user?.id ?? "anon"}/${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 8)}.jpg`;
          const { error: upErr } = await supabase.storage.from("duty-slips").upload(path, item.blob, {
            contentType: "image/jpeg",
            upsert: false,
          });
          if (upErr) throw upErr;

          const b64 = await blobToBase64(item.blob);
          // Fire-and-forget: mirror to Google Drive
          {
            const instName = (selectedInstitution as any)?.name ?? null;
            uploadToDrive({ data: {
              folderPath: driveFolder("Duty-Slips", instName, new Date()),
              fileName: `slip-${Date.now()}-p${item.page}.jpg`,
              mimeType: "image/jpeg",
              base64: b64,
            } }).catch((e) => console.warn("Drive mirror failed", e));
          }
          const { extracted, error } = await ocr({ data: {
            image_base64: b64,
            mime: "image/jpeg",
            extra_fields: instCustomFields.map((f) => ({ key: f.key, label: f.label })),
          } });
          if (error) throw new Error(error);

          const { data: slipRow, error: slipErr } = await supabase.from("duty_slips").insert({
            file_path: path,
            file_type: "image/jpeg",
            uploaded_by: user?.id ?? null,
            ocr_raw: extracted ?? null,
            status: "uploaded",
          }).select("id").single();
          if (slipErr) throw slipErr;

          const cf: Record<string, string> = {};
          for (const c of instCustomFields) {
            const v = (extracted as any)?.[c.key] ?? (extracted as any)?.[c.label] ?? "";
            if (v) cf[c.key] = String(v);
          }
          // Default User Name to Guest name when not provided
          for (const c of instCustomFields) {
            const isUserName = c.key === "user_name" || /user\s*name/i.test(c.label);
            if (isUserName && !cf[c.key]) {
              const g = (extracted as any)?.guest ?? (extracted as any)?.guest_name ?? "";
              if (g) cf[c.key] = String(g);
            }
          }

          setRows((s) => s.map((r) => r.page === item.page ? {
            ...r,
            status: "ready",
            storage_path: path,
            duty_slip_id: slipRow.id,
            custom_fields: cf,
            data: mapExtracted(extracted),
          } : r));
        } catch (err: any) {
          setRows((s) => s.map((r) => r.page === item.page ? {
            ...r, status: "error", error: err.message || "Failed",
          } : r));
        } finally {
          done++;
          setProgress({ done, total });
        }
      }

      const workers = Array.from({ length: concurrency }, async () => {
        while (cursor < pageImages.length) {
          const i = cursor++;
          await processOne(i);
        }
      });
      await Promise.all(workers);
      toast.success(`Extracted ${done} of ${total} pages`);
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "PDF processing failed");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function onImages(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    if (files.length > MAX_PAGES) {
      toast.warning(`Selected ${files.length} images — only first ${MAX_PAGES} will be processed.`);
    }
    const list = files.slice(0, MAX_PAGES);
    setBusy(true);
    setRows([]);
    try {
      setProgress({ done: 0, total: list.length });
      // Build thumbnails + jpeg blobs (re-encode to keep payload sane)
      const pageImages: { page: number; blob: Blob; dataUrl: string }[] = [];
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        const { blob, dataUrl } = await imageFileToJpeg(f);
        pageImages.push({ page: i + 1, blob, dataUrl });
      }

      const initial: Row[] = pageImages.map((p) => ({
        page: p.page,
        status: "ocr",
        thumb: p.dataUrl,
        package_id: null,
        data: {},
      }));
      setRows(initial);

      const concurrency = 3;
      let cursor = 0;
      let done = 0;
      const { data: { user } } = await supabase.auth.getUser();

      async function processOne(idx: number) {
        const item = pageImages[idx];
        try {
          const path = `${user?.id ?? "anon"}/${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 8)}.jpg`;
          const { error: upErr } = await supabase.storage.from("duty-slips").upload(path, item.blob, {
            contentType: "image/jpeg",
            upsert: false,
          });
          if (upErr) throw upErr;

          const b64 = await blobToBase64(item.blob);
          {
            const instName = (selectedInstitution as any)?.name ?? null;
            uploadToDrive({ data: {
              folderPath: driveFolder("Duty-Slips", instName, new Date()),
              fileName: `slip-${Date.now()}-p${item.page}.jpg`,
              mimeType: "image/jpeg",
              base64: b64,
            } }).catch((e) => console.warn("Drive mirror failed", e));
          }
          const { extracted, error } = await ocr({ data: {
            image_base64: b64,
            mime: "image/jpeg",
            extra_fields: instCustomFields.map((f) => ({ key: f.key, label: f.label })),
          } });
          if (error) throw new Error(error);

          const { data: slipRow, error: slipErr } = await supabase.from("duty_slips").insert({
            file_path: path,
            file_type: "image/jpeg",
            uploaded_by: user?.id ?? null,
            ocr_raw: extracted ?? null,
            status: "uploaded",
          }).select("id").single();
          if (slipErr) throw slipErr;

          const cf: Record<string, string> = {};
          for (const c of instCustomFields) {
            const v = (extracted as any)?.[c.key] ?? (extracted as any)?.[c.label] ?? "";
            if (v) cf[c.key] = String(v);
          }
          // Default User Name to Guest name when not provided
          for (const c of instCustomFields) {
            const isUserName = c.key === "user_name" || /user\s*name/i.test(c.label);
            if (isUserName && !cf[c.key]) {
              const g = (extracted as any)?.guest ?? (extracted as any)?.guest_name ?? "";
              if (g) cf[c.key] = String(g);
            }
          }

          setRows((s) => s.map((r) => r.page === item.page ? {
            ...r,
            status: "ready",
            storage_path: path,
            duty_slip_id: slipRow.id,
            custom_fields: cf,
            data: mapExtracted(extracted),
          } : r));
        } catch (err: any) {
          setRows((s) => s.map((r) => r.page === item.page ? {
            ...r, status: "error", error: err.message || "Failed",
          } : r));
        } finally {
          done++;
          setProgress({ done, total: list.length });
        }
      }

      const workers = Array.from({ length: concurrency }, async () => {
        while (cursor < pageImages.length) {
          const i = cursor++;
          await processOne(i);
        }
      });
      await Promise.all(workers);
      toast.success(`Extracted ${done} of ${list.length} image(s)`);
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "Image processing failed");
    } finally {
      setBusy(false);
      if (imgInputRef.current) imgInputRef.current.value = "";
    }
  }

  function updateField(page: number, key: string, value: any) {
    setRows((s) => s.map((r) => {
      if (r.page !== page) return r;
      const next = { ...r, data: { ...r.data, [key]: value } } as typeof r;
      // Mirror guest_name into the User Name custom field if defined
      if (key === "guest_name") {
        const unField = instCustomFields.find((c) => c.key === "user_name" || /user\s*name/i.test(c.label));
        if (unField) {
          next.custom_fields = { ...(r.custom_fields ?? {}), [unField.key]: String(value ?? "") };
        }
      }
      // Auto-recompute total_hours when time/date fields change
      if (key === "opening_time" || key === "closing_time" || key === "duty_date" || key === "closing_date") {
        const h = computeHours(next.data.opening_time, next.data.closing_time, next.data.duty_date, next.data.closing_date);
        if (h != null) next.data = { ...next.data, total_hours: h };
      }
      // Auto-recompute total_km when opening/closing km change
      if (key === "opening_km" || key === "closing_km") {
        const km = deriveTotalKm(next.data);
        if (km != null) next.data = { ...next.data, total_km: km };
      }
      return next;
    }));
  }

  function updateRowPackage(page: number, pkgId: string | null) {
    setRows((s) => s.map((r) => r.page === page ? { ...r, package_id: pkgId } : r));
  }

  function updateCustomField(page: number, key: string, value: string) {
    setRows((s) => s.map((r) => r.page === page ? { ...r, custom_fields: { ...(r.custom_fields ?? {}), [key]: value } } : r));
  }

  function removeRow(page: number) {
    setRows((s) => s.filter((r) => r.page !== page));
  }

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filterVehicle && (r.data.vehicle_type ?? "") !== filterVehicle) return false;
      if (filterPackage === "__none__" && r.package_id) return false;
      if (filterPackage && filterPackage !== "__none__" && r.package_id !== filterPackage) return false;
      if (filterStatus && r.status !== filterStatus) return false;
      if (q) {
        const hay = [
          r.data.duty_date, r.data.car_number, r.data.driver_name,
          r.data.guest_name, r.data.vehicle_type, r.data.company_name,
        ].map((v) => String(v ?? "").toLowerCase()).join(" ");
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, search, filterVehicle, filterPackage, filterStatus]);

  function applyPaste() {
    const target = pasteScope === "filtered" ? filteredRows : rows;
    const targetPages = new Set(target.map((r) => r.page));

    // Build value list per target row based on mode
    let getValueFor: (row: Row, idx: number) => string | undefined;

    if (pasteMode === "fill") {
      const v = pasteFillValue;
      if (v === "") { toast.error("Enter a value to fill"); return; }
      getValueFor = () => v;
    } else if (pasteMode === "from_col") {
      if (pasteSourceCol === pasteCol) { toast.error("Source and target must differ"); return; }
      getValueFor = (row) => {
        if (pasteSourceCol === "__package__") {
          const rc = row.package_id ? pkgById.get(row.package_id) : null;
          return rc ? `${rc.vehicle_name} · ${rc.package_type}` : "";
        }
        const v = row.data[pasteSourceCol];
        return v == null ? "" : String(v);
      };
    } else {
      const lines = pasteText.replace(/\r/g, "").split("\n").map((l) => l.split("\t")[0]);
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      if (!lines.length) { toast.error("Nothing to paste"); return; }
      getValueFor = (_row, i) => lines[i];
    }

    setRows((s) => {
      let i = 0;
      return s.map((r) => {
        if (!targetPages.has(r.page)) return r;
        const v = getValueFor(r, i++);
        if (v === undefined) return r;
        if (pasteCol === "__package__") {
          const match = (rateCards.data ?? []).find((rc: any) =>
            String(rc.vehicle_name).toLowerCase().includes(v.toLowerCase()) ||
            String(`${rc.vehicle_name} ${rc.package_type}`).toLowerCase().includes(v.toLowerCase())
          );
          return { ...r, package_id: match?.id ?? r.package_id };
        }
        return { ...r, data: { ...r.data, [pasteCol]: v.trim() } };
      });
    });
    toast.success(`Updated ${target.length} row(s) — ${PASTE_COLUMNS.find((c) => c.key === pasteCol)?.label}`);
    setPasteOpen(false);
    setPasteText("");
    setPasteFillValue("");
  }

  async function copyColumn(colKey: string) {
    const target = filteredRows.length ? filteredRows : rows;
    const lines = target.map((r) => {
      if (colKey === "__package__") {
        const rc = r.package_id ? pkgById.get(r.package_id) : null;
        return rc ? `${rc.vehicle_name} · ${rc.package_type}` : "";
      }
      return String(r.data[colKey] ?? "");
    });
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      toast.success(`Copied ${lines.length} cell(s) — paste into Excel`);
    } catch {
      toast.error("Clipboard access denied");
    }
  }

  async function copyAllAsTSV() {
    const target = filteredRows.length ? filteredRows : rows;
    const headers = ["#", "Date", "Car", "Vehicle", "Driver", "Guest", "Package", "Open KM", "Close KM", "Total KM", "Open Time", "Close Time", "Hrs", "Parking", "Tolls"];
    const lines = [headers.join("\t")];
    for (const r of target) {
      const rc = r.package_id ? pkgById.get(r.package_id) : null;
      lines.push([
        r.page, r.data.duty_date ?? "", r.data.car_number ?? "", r.data.vehicle_type ?? "",
        r.data.driver_name ?? "", r.data.guest_name ?? "",
        rc ? `${rc.vehicle_name} · ${rc.package_type}` : "",
        r.data.opening_km ?? "", r.data.closing_km ?? "", r.data.total_km ?? "",
        r.data.opening_time ?? "", r.data.closing_time ?? "", r.data.total_hours ?? "",
        r.data.parking ?? "", r.data.tolls ?? "",
      ].join("\t"));
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      toast.success(`Copied ${target.length} row(s) as TSV`);
    } catch {
      toast.error("Clipboard access denied");
    }
  }

  async function downloadFormattedXlsx() {
    const target = filteredRows.length ? filteredRows : rows;
    if (!target.length) { toast.error("No rows to export"); return; }
    // Vendor lookup: map cab (4-digit) → vendor name from vehicle_vendors
    const { data: vendorRows } = await supabase
      .from("vehicle_vendors")
      .select("cab_no, full_cab_no, vendor_name");
    const vendorByCab = new Map<string, string>();
    for (const v of (vendorRows ?? []) as any[]) {
      const k = String(v.cab_no ?? "").trim();
      if (k) vendorByCab.set(k.padStart(4, "0"), v.vendor_name);
      const full = String(v.full_cab_no ?? "").replace(/\s+/g, "").toUpperCase();
      if (full) vendorByCab.set(full, v.vendor_name);
    }
    const lookupVendor = (carNo?: string | null): string | null => {
      if (!carNo) return null;
      const raw = String(carNo).trim();
      const full = raw.replace(/\s+/g, "").toUpperCase();
      if (vendorByCab.has(full)) return vendorByCab.get(full)!;
      const last4 = full.replace(/[^0-9]/g, "").slice(-4).padStart(4, "0");
      return vendorByCab.get(last4) ?? null;
    };
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Trips");
    const headers = [
      "S.NO", "Date", "Vender Name", "Vehicle Type", "Vehicle No", "Driver",
      "Department", "User name", "Starting Km", "Closing Km", "Starting time",
      "Closing time", "Toll Tax &", "FASTag", "Return", "Remarks",
    ];
    const widths = [6, 12, 12, 13, 11, 14, 13, 20, 12, 12, 13, 13, 11, 10, 9, 18];
    ws.columns = headers.map((h, i) => ({ header: h, width: widths[i] }));

    const fallbackVendor = (selectedInstitution as any)?.code || "LR";
    const deptName = (departments.data ?? []).find((d: any) => d.id === departmentId)?.name || "";

    target.forEach((r, idx) => {
      const userName = r.custom_fields?.user_name
        || Object.entries(r.custom_fields ?? {}).find(([k]) => /user/i.test(k))?.[1]
        || r.data.guest_name || "";
      const vendor = lookupVendor(r.data.car_number) ?? fallbackVendor;
      ws.addRow([
        idx + 1,
        r.data.duty_date ?? "",
        vendor,
        r.data.vehicle_type ?? "",
        r.data.car_number ?? "",
        r.data.driver_name ?? "",
        deptName,
        userName,
        r.data.opening_km ?? "",
        r.data.closing_km ?? "",
        r.data.opening_time ?? "",
        r.data.closing_time ?? "",
        r.data.tolls ?? "",
        "",
        "",
        "",
      ]);
    });

    const border = { style: "thin" as const, color: { argb: "FF000000" } };
    const allBorders = { top: border, left: border, bottom: border, right: border };

    // Header row styling (light green like screenshot)
    const headerRow = ws.getRow(1);
    headerRow.eachCell((cell) => {
      cell.font = { bold: true };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9EAD3" } };
      cell.border = allBorders;
    });
    headerRow.height = 22;

    // Body rows: yellow fill, borders, centered
    for (let i = 2; i <= target.length + 1; i++) {
      const row = ws.getRow(i);
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
        cell.border = allBorders;
        cell.alignment = { horizontal: "center", vertical: "middle" };
      });
    }

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Trips-${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Downloaded ${target.length} row(s)`);
  }

  function clearFilters() {
    setSearch(""); setFilterVehicle(""); setFilterPackage(""); setFilterStatus("");
  }

  async function saveAll() {
    const ready = rows.filter((r) => r.status === "ready" || r.status === "error" && r.duty_slip_id);
    if (!ready.length) { toast.error("No rows to save"); return; }
    setBusy(true);

    // Resolve fallback GST once; rate-card tax is applied per row when present.
    let fallbackGst: GstSetting | null = null;
    if (autoInvoice) {
      if (departmentId) {
        const { data: dept } = await supabase.from("departments").select("default_gst_setting_id").eq("id", departmentId).single();
        const gstId = (dept as any)?.default_gst_setting_id;
        if (gstId) {
          const { data: g } = await supabase.from("gst_settings").select("*").eq("id", gstId).single();
          fallbackGst = (g as any) ?? null;
        }
      }
      if (!fallbackGst) {
        const { data: g } = await supabase.from("gst_settings").select("*").eq("is_default", true).maybeSingle();
        fallbackGst = (g as any) ?? null;
      }
    }

    const companyName = (companies.data ?? []).find((c: any) => c.id === companyId)?.name ?? null;

    let savedCount = 0;
    let invoicedCount = 0;

    for (const row of ready) {
      setRows((s) => s.map((r) => r.page === row.page ? { ...r, status: "saving" } : r));
      try {
        const f = row.data;
        const rowPkg = findRateCardForRow(row);
        const pricing = pkgToPricing(rowPkg);
        const insertPayload: any = {
          duty_date: toIsoDate(f.duty_date) || null,
          car_number: f.car_number || null,
          vehicle_type: f.vehicle_type || null,
          driver_name: f.driver_name || null,
          guest_name: f.guest_name || null,
          company_name: companyName || f.company_name || null,
          company_id: companyId,
          opening_km: num(f.opening_km),
          closing_km: num(f.closing_km),
          total_km: num(f.total_km),
          opening_time: f.opening_time || null,
          closing_time: f.closing_time || null,
          total_hours: num(f.total_hours),
          parking: num(f.parking),
          tolls: num(f.tolls),
          days: num(f.days),
          duty_slip_id: row.duty_slip_id ?? null,
          department_id: departmentId,
          package_id: row.package_id ?? rowPkg?.id ?? null,
          institution_id: institutionId,
          custom_fields: row.custom_fields ?? {},
        };
        const { data: trip, error } = await supabase.from("trips").insert(insertPayload).select("*").single();
        if (error) throw error;
        savedCount++;

        let invoiceNo: string | undefined;
        if (autoInvoice && pricing) {
          const gst = gstFromRateCard(rowPkg) ?? fallbackGst;
          const calc = computeTrip({
            total_km: Number(trip.total_km || 0),
            total_hours: Number(trip.total_hours || 0),
            parking: Number(trip.parking || 0),
            tolls: Number(trip.tolls || 0),
            days: Number((trip as any).days || f.days || 1),
            opening_time: (trip as any).opening_time ?? f.opening_time ?? null,
            closing_time: (trip as any).closing_time ?? f.closing_time ?? null,
            duty_date: (trip as any).duty_date ?? f.duty_date ?? null,
            closing_date: (trip as any).closing_date ?? f.closing_date ?? null,
            package: pricing,
          }, gst);
          await supabase.from("trips").update({
            base_fare: calc.base_fare,
            extra_km_charge: calc.extra_km_charge,
            extra_hour_charge: calc.extra_hour_charge,
            night_charge: calc.night_charge,
            driver_allowance: calc.driver_allowance,
            taxable_amount: calc.taxable_amount,
            gst_breakup: calc.gst_breakup,
            gst_total: calc.gst_total,
            grand_total: calc.grand_total,
          }).eq("id", trip.id);
          const inv = await createInvoiceFromTrips({
            tripIds: [trip.id],
            type: "single",
            departmentId,
            institutionId,
          });
          invoiceNo = inv.invoice_no;
          invoicedCount++;
        }

        setRows((s) => s.map((r) => r.page === row.page ? {
          ...r, status: "saved", trip_id: trip.id, invoice_no: invoiceNo,
        } : r));
      } catch (err: any) {
        setRows((s) => s.map((r) => r.page === row.page ? {
          ...r, status: "error", error: err.message || "Save failed",
        } : r));
      }
    }
    setBusy(false);
    toast.success(`${savedCount} trip(s) saved${invoicedCount ? `, ${invoicedCount} invoiced` : ""}`);
    if (invoicedCount > 0) {
      setTimeout(() => nav({ to: "/trips", search: {} as any }), 800);
    }
  }

  const readyCount = rows.filter((r) => r.status === "ready").length;
  const savedCount = rows.filter((r) => r.status === "saved").length;
  const errorCount = rows.filter((r) => r.status === "error").length;

  return (
    <div>
      <PageHeader title="Bulk PDF Upload" description="Upload a multi-page PDF (up to 200 slips). Each page is OCR-extracted into one trip row." />

      <DataCard className="mb-6">
        <Label className="font-display text-lg text-gold">Defaults applied to every page</Label>
        <p className="text-xs text-muted-foreground mt-1 mb-3">Pick the department, institution, company and package once — they apply to all extracted trips.</p>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <Label className="text-xs">Department</Label>
            <select className="w-full bg-background border rounded-md px-3 py-2 mt-1" value={departmentId ?? ""} onChange={(e) => setDepartmentId(e.target.value || null)}>
              <option value="">— None —</option>
              {(departments.data ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div>
            <Label className="text-xs">Institution template</Label>
            <select className="w-full bg-background border rounded-md px-3 py-2 mt-1" value={institutionId ?? ""} onChange={(e) => setInstitutionId(e.target.value || null)}>
              <option value="">— None —</option>
              {(institutions.data ?? []).map((i: any) => <option key={i.id} value={i.id}>{i.code} — {i.name}</option>)}
            </select>
          </div>
          <div>
            <Label className="text-xs">Company</Label>
            <select className="w-full bg-background border rounded-md px-3 py-2 mt-1" value={companyId ?? ""} onChange={(e) => setCompanyId(e.target.value || null)}>
              <option value="">— Use OCR-detected —</option>
              {(companies.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="md:col-span-2 text-xs text-muted-foreground italic">
            Pick a Package per trip in the Extracted trips table below — every trip can use a different rate card.
          </div>
        </div>
        <label className="flex items-center gap-2 mt-4 text-sm">
          <input type="checkbox" checked={autoInvoice} onChange={(e) => setAutoInvoice(e.target.checked)} />
          Generate invoices automatically when saving (uses the package selected on each row)
        </label>
      </DataCard>

      <DataCard className="mb-6">
        <Label className="font-display text-lg text-gold flex items-center gap-2"><Files className="h-4 w-4" /> PDF file (max {MAX_PAGES} pages)</Label>
        <Input ref={inputRef} type="file" accept="application/pdf" onChange={onFile} className="mt-3" disabled={busy} />
        {busy && progress.total > 0 && (
          <div className="mt-3 text-gold text-sm flex items-center gap-2">
            <Sparkles className="h-4 w-4 animate-pulse" /> Extracting page {progress.done} / {progress.total}…
          </div>
        )}
      </DataCard>

      <DataCard className="mb-6">
        <Label className="font-display text-lg text-gold flex items-center gap-2"><ImageIcon className="h-4 w-4" /> Or upload multiple slip images (max {MAX_PAGES})</Label>
        <p className="text-xs text-muted-foreground mt-1">Select multiple JPG/PNG photos of duty slips — each image is OCR-extracted into one trip row, same as PDF pages.</p>
        <Input ref={imgInputRef} type="file" accept="image/*" multiple onChange={onImages} className="mt-3" disabled={busy} />
      </DataCard>

      {rows.length > 0 && (
        <DataCard>
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h3 className="font-display text-lg text-gold">
              Extracted trips ({filteredRows.length}{filteredRows.length !== rows.length ? ` of ${rows.length}` : ""})
            </h3>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="text-foreground">{readyCount} ready</span>
              {savedCount > 0 && <span className="text-emerald-500">{savedCount} saved</span>}
              {errorCount > 0 && <span className="text-destructive">{errorCount} errors</span>}
              <Button onClick={saveAll} disabled={busy || readyCount === 0} className="bg-gold text-primary-foreground hover:opacity-90 glow-gold">
                Save all {readyCount > 0 ? `(${readyCount})` : ""}
              </Button>
              {savedCount > 0 && <Button variant="outline" onClick={() => nav({ to: "/invoices" })}>View invoices</Button>}
            </div>
          </div>

          {/* Filters + Excel paste/copy toolbar */}
          <div className="flex items-end flex-wrap gap-2 mb-3 p-2 rounded-md bg-muted/30 border hairline">
            <div className="relative">
              <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-8 text-xs pl-7 w-56"
                placeholder="Search car / driver / guest…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <select className="h-8 text-xs bg-background border rounded-md px-2" value={filterVehicle} onChange={(e) => setFilterVehicle(e.target.value)}>
              <option value="">All vehicles</option>
              {VEHICLE_TYPES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
            <select className="h-8 text-xs bg-background border rounded-md px-2" value={filterPackage} onChange={(e) => setFilterPackage(e.target.value)} disabled={!departmentId && !institutionId}>
              <option value="">All packages</option>
              <option value="__none__">— No package —</option>
              {(rateCards.data ?? []).map((rc: any) => (
                <option key={rc.id} value={rc.id}>{rc.vehicle_name} · {rc.package_type}</option>
              ))}
            </select>
            <select className="h-8 text-xs bg-background border rounded-md px-2" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="">All statuses</option>
              <option value="ready">Ready</option>
              <option value="saved">Saved</option>
              <option value="error">Errors</option>
              <option value="ocr">Reading</option>
            </select>
            {(search || filterVehicle || filterPackage || filterStatus) && (
              <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={clearFilters}>
                <X className="h-3 w-3 mr-1" /> Clear
              </Button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setPasteOpen(true)}>
                <ClipboardPaste className="h-3.5 w-3.5 mr-1" /> Paste column
              </Button>
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={copyAllAsTSV}>
                <ClipboardCopy className="h-3.5 w-3.5 mr-1" /> Copy table
              </Button>
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={downloadFormattedXlsx}>
                <Download className="h-3.5 w-3.5 mr-1" /> Download Excel
              </Button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground border-b hairline">
                <tr>
                  <th className="p-2 text-left">#</th>
                  <th className="p-2 text-left">Status</th>
                  <ColHeader label="Date" colKey="duty_date" onCopy={copyColumn} />
                  <ColHeader label="Car" colKey="car_number" onCopy={copyColumn} />
                  <ColHeader label="Vehicle" colKey="vehicle_type" onCopy={copyColumn} />
                  <ColHeader label="Driver" colKey="driver_name" onCopy={copyColumn} />
                  <ColHeader label="Guest" colKey="guest_name" onCopy={copyColumn} />
                  {instCustomFields.map((cf) => (
                    <th key={cf.key} className="p-2 text-left whitespace-nowrap">{cf.label}</th>
                  ))}
                  <ColHeader label="Package" colKey="__package__" onCopy={copyColumn} />
                  <ColHeader label="Open KM" colKey="opening_km" onCopy={copyColumn} align="right" />
                  <ColHeader label="Close KM" colKey="closing_km" onCopy={copyColumn} align="right" />
                  <ColHeader label="KM" colKey="total_km" onCopy={copyColumn} align="right" />
                  <ColHeader label="Open Time" colKey="opening_time" onCopy={copyColumn} />
                  <ColHeader label="Close Time" colKey="closing_time" onCopy={copyColumn} />
                  <ColHeader label="Hrs" colKey="total_hours" onCopy={copyColumn} align="right" />
                  <ColHeader label="Days" colKey="days" onCopy={copyColumn} align="right" />
                  <th className="p-2 text-right">Extra KM</th>
                  <th className="p-2 text-right">Extra Hrs</th>
                  <th className="p-2 text-right whitespace-nowrap">Night</th>
                  <ColHeader label="Parking" colKey="parking" onCopy={copyColumn} align="right" />
                  <ColHeader label="Tolls" colKey="tolls" onCopy={copyColumn} align="right" />
                  <th className="p-2 text-right">Total</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((r) => {
                  const rc = findRateCardForRow(r);
                  const pricing = pkgToPricing(rc);
                  const totalKm = num(r.data.total_km) ?? deriveTotalKm(r.data);
                  const totalHrs = num(r.data.total_hours) ?? deriveTotalHours(r.data);
                  const days = Math.max(1, Math.floor(num(r.data.days) || 1));
                  const mult = pricing && !pricing.is_fixed_price ? days : 1;
                  const extraKm = pricing && !pricing.is_fixed_price
                    ? Math.max(0, (totalKm ?? 0) - (pricing.included_km || 0) * mult) : 0;
                  const extraHrs = pricing && !pricing.is_fixed_price
                    ? Math.max(0, (totalHrs ?? 0) - (pricing.included_hours || 0) * mult) : 0;
                  const nightOn = !!(pricing && !pricing.is_fixed_price && (pricing.night_charges || 0) > 0 && (
                    isWithinNightWindow(r.data.opening_time ?? "", pricing.night_start_time, pricing.night_end_time)
                    || isWithinNightWindow(r.data.closing_time ?? "", pricing.night_start_time, pricing.night_end_time)
                  ));
                  const nightCharge = nightOn ? (pricing!.night_charges || 0) : 0;
                  const calcTotal = pricing
                    ? (pricing.base_fare * mult
                        + (pricing.is_fixed_price ? 0 : extraKm * (pricing.extra_km_rate || 0))
                        + (pricing.is_fixed_price ? 0 : extraHrs * (pricing.extra_hour_rate || 0))
                        + (pricing.is_fixed_price ? 0 : (pricing.driver_allowance || 0))
                        + nightCharge
                        + (num(r.data.parking) || 0)
                        + (num(r.data.tolls) || 0))
                    : null;
                  return (
                  <tr key={r.page} className="border-b hairline align-top">
                    <td className="p-2 text-muted-foreground">{r.page}</td>
                    <td className="p-2"><StatusPill row={r} /></td>
                    <td className="p-1"><DateCell value={r.data.duty_date ?? ""} onChange={(v) => updateField(r.page, "duty_date", v)} /></td>
                    <td className="p-1"><Input className="h-8 text-xs w-28" value={r.data.car_number ?? ""} onChange={(e) => updateField(r.page, "car_number", e.target.value)} /></td>
                    <td className="p-1">
                      <select
                        className="h-8 text-xs bg-background border rounded-md px-2 w-24"
                        value={r.data.vehicle_type ?? ""}
                        onChange={(e) => updateField(r.page, "vehicle_type", e.target.value)}
                      >
                        <option value="">—</option>
                        {VEHICLE_TYPES.map((v) => <option key={v} value={v}>{v}</option>)}
                        {r.data.vehicle_type && !VEHICLE_TYPES.includes(r.data.vehicle_type) && (
                          <option value={r.data.vehicle_type}>{r.data.vehicle_type}</option>
                        )}
                      </select>
                    </td>
                    <td className="p-1"><Input className="h-8 text-xs w-32" value={r.data.driver_name ?? ""} onChange={(e) => updateField(r.page, "driver_name", e.target.value)} /></td>
                    <td className="p-1"><Input className="h-8 text-xs w-32" value={r.data.guest_name ?? ""} onChange={(e) => updateField(r.page, "guest_name", e.target.value)} /></td>
                    {instCustomFields.map((cf) => (
                      <td key={cf.key} className="p-1">
                        <Input
                          className="h-8 text-xs w-32"
                          value={(r.custom_fields ?? {})[cf.key] ?? ""}
                          onChange={(e) => updateCustomField(r.page, cf.key, e.target.value)}
                        />
                      </td>
                    ))}
                    <td className="p-1">
                      <select
                        className="h-8 text-xs bg-background border rounded-md px-2 w-44"
                        value={r.package_id ?? ""}
                        onChange={(e) => updateRowPackage(r.page, e.target.value || null)}
                        disabled={!departmentId && !institutionId}
                      >
                          <option value="">{(departmentId || institutionId) ? "Auto by vehicle" : "Pick department or institution first"}</option>
                        {(rateCards.data ?? []).map((rc: any) => (
                          <option key={rc.id} value={rc.id}>
                            {rc.vehicle_name} · {rc.package_type} · ₹{rc.base_fare}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="p-1"><Input className="h-8 text-xs w-16 text-right" value={r.data.opening_km ?? ""} onChange={(e) => updateField(r.page, "opening_km", e.target.value)} /></td>
                    <td className="p-1"><Input className="h-8 text-xs w-16 text-right" value={r.data.closing_km ?? ""} onChange={(e) => updateField(r.page, "closing_km", e.target.value)} /></td>
                    <td className="p-1"><Input className="h-8 text-xs w-16 text-right" value={r.data.total_km ?? ""} onChange={(e) => updateField(r.page, "total_km", e.target.value)} /></td>
                    <td className="p-1"><Input className="h-8 text-xs w-20" value={r.data.opening_time ?? ""} onChange={(e) => updateField(r.page, "opening_time", e.target.value)} /></td>
                    <td className="p-1"><TimeWithDateCell time={r.data.closing_time ?? ""} date={r.data.closing_date ?? ""} baseDate={r.data.duty_date ?? ""} onChangeTime={(v) => updateField(r.page, "closing_time", v)} onChangeDate={(v) => updateField(r.page, "closing_date", v)} /></td>
                    <td className="p-1"><Input className="h-8 text-xs w-14 text-right" value={r.data.total_hours ?? ""} onChange={(e) => updateField(r.page, "total_hours", e.target.value)} /></td>
                    <td className="p-1">
                      <Input
                        className={`h-8 text-xs w-14 text-right ${isOutstationPkg(rc) && !num(r.data.days) ? "border-destructive" : ""}`}
                        placeholder={isOutstationPkg(rc) ? "req" : "1"}
                        value={r.data.days ?? ""}
                        onChange={(e) => updateField(r.page, "days", e.target.value)}
                      />
                    </td>
                    <td className="p-2 text-right text-muted-foreground">{pricing ? extraKm.toFixed(0) : "—"}</td>
                    <td className="p-2 text-right text-muted-foreground">{pricing ? extraHrs.toFixed(1) : "—"}</td>
                    <td className="p-2 text-right whitespace-nowrap">
                      {pricing
                        ? (nightOn
                            ? <span className="text-gold font-medium" title={`Night window ${pricing.night_start_time ?? "?"}–${pricing.night_end_time ?? "?"}`}>₹{nightCharge.toFixed(0)}</span>
                            : <span className="text-muted-foreground">—</span>)
                        : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="p-1"><Input className="h-8 text-xs w-16 text-right" value={r.data.parking ?? ""} onChange={(e) => updateField(r.page, "parking", e.target.value)} /></td>
                    <td className="p-1"><Input className="h-8 text-xs w-16 text-right" value={r.data.tolls ?? ""} onChange={(e) => updateField(r.page, "tolls", e.target.value)} /></td>
                    <td className="p-2 text-right text-gold font-medium">{calcTotal != null ? `₹${calcTotal.toFixed(0)}` : "—"}</td>
                    <td className="p-1 text-right">
                      <Button variant="ghost" size="icon" onClick={() => removeRow(r.page)} disabled={r.status === "saving"}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">
            Extra KM / Extra Hrs and Total are calculated from the selected package. On Save all, each trip is billed with its own package and moved to the Invoiced column on the Trips dashboard.
          </p>
        </DataCard>
      )}

      {/* Paste-column dialog */}
      <Dialog open={pasteOpen} onOpenChange={setPasteOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Fill / Paste column</DialogTitle>
            <DialogDescription>
              Paste from Excel, copy values from another column, or fill one value into every row.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Mode</Label>
              <div className="flex gap-1 mt-1">
                {([
                  { v: "text", l: "Paste from Excel" },
                  { v: "fill", l: "Fill one value" },
                  { v: "from_col", l: "Copy from column" },
                ] as const).map((m) => (
                  <button
                    key={m.v}
                    type="button"
                    onClick={() => setPasteMode(m.v)}
                    className={`flex-1 text-xs px-2 py-1.5 rounded-md border ${pasteMode === m.v ? "bg-gold text-primary-foreground border-gold" : "bg-background hover:bg-muted"}`}
                  >
                    {m.l}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <Label className="text-xs">Target column</Label>
              <select
                className="w-full bg-background border rounded-md px-2 py-2 mt-1 text-sm"
                value={pasteCol}
                onChange={(e) => setPasteCol(e.target.value)}
              >
                {PASTE_COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-xs">Apply to</Label>
              <select
                className="w-full bg-background border rounded-md px-2 py-2 mt-1 text-sm"
                value={pasteScope}
                onChange={(e) => setPasteScope(e.target.value as "filtered" | "all")}
              >
                <option value="filtered">Filtered rows ({filteredRows.length})</option>
                <option value="all">All rows ({rows.length})</option>
              </select>
            </div>
            {pasteMode === "text" && (
              <div>
                <Label className="text-xs">Pasted values (one per line)</Label>
                <Textarea
                  className="mt-1 font-mono text-xs h-40"
                  placeholder={"e.g.\n8-4-2026\n9-4-2026\n10-4-2026"}
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  autoFocus
                />
              </div>
            )}
            {pasteMode === "fill" && (
              <div>
                <Label className="text-xs">Value to fill into every row</Label>
                <Input
                  className="mt-1"
                  placeholder="e.g. HR-38 AF 78"
                  value={pasteFillValue}
                  onChange={(e) => setPasteFillValue(e.target.value)}
                  autoFocus
                />
              </div>
            )}
            {pasteMode === "from_col" && (
              <div>
                <Label className="text-xs">Copy values from</Label>
                <select
                  className="w-full bg-background border rounded-md px-2 py-2 mt-1 text-sm"
                  value={pasteSourceCol}
                  onChange={(e) => setPasteSourceCol(e.target.value)}
                >
                  {PASTE_COLUMNS.filter((c) => c.key !== pasteCol).map((c) => (
                    <option key={c.key} value={c.key}>{c.label}</option>
                  ))}
                </select>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Each row's <b>{PASTE_COLUMNS.find((c) => c.key === pasteSourceCol)?.label}</b> will be copied into <b>{PASTE_COLUMNS.find((c) => c.key === pasteCol)?.label}</b>.
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPasteOpen(false)}>Cancel</Button>
            <Button onClick={applyPaste} className="bg-gold text-primary-foreground hover:opacity-90">Apply</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ColHeader({
  label, colKey, onCopy, align = "left",
}: { label: string; colKey: string; onCopy: (k: string) => void; align?: "left" | "right" }) {
  return (
    <th className={`p-2 ${align === "right" ? "text-right" : "text-left"}`}>
      <button
        type="button"
        onClick={() => onCopy(colKey)}
        title="Copy column to clipboard"
        className="inline-flex items-center gap-1 hover:text-gold transition-colors"
      >
        {label}
        <ClipboardCopy className="h-3 w-3 opacity-40" />
      </button>
    </th>
  );
}

async function imageFileToJpeg(file: File): Promise<{ blob: Blob; dataUrl: string }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const maxSide = 2000;
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, w, h);
    const blob: Blob = await new Promise((res) => canvas.toBlob((b) => res(b!), "image/jpeg", 0.85));
    const dataUrl = canvas.toDataURL("image/jpeg", 0.5);
    return { blob, dataUrl };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function StatusPill({ row }: { row: Row }) {
  const map: Record<Row["status"], { label: string; cls: string; icon?: any }> = {
    pending: { label: "Pending", cls: "bg-muted text-muted-foreground" },
    ocr: { label: "Reading…", cls: "bg-gold/15 text-gold" },
    ready: { label: "Ready", cls: "bg-emerald-500/15 text-emerald-500" },
    saving: { label: "Saving…", cls: "bg-gold/15 text-gold" },
    saved: { label: row.invoice_no ? `Invoiced ${row.invoice_no}` : "Saved", cls: "bg-emerald-500/15 text-emerald-500", icon: CheckCircle2 },
    error: { label: row.error || "Error", cls: "bg-destructive/15 text-destructive", icon: AlertTriangle },
  };
  const { label, cls, icon: Icon } = map[row.status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${cls}`}>
      {Icon && <Icon className="h-3 w-3" />} {label}
    </span>
  );
}

function mapExtracted(extracted: any) {
  const openKm = extracted?.openingKM ?? extracted?.opening_km ?? "";
  const closeKm = extracted?.closingKM ?? extracted?.closing_km ?? "";
  const openT = extracted?.openingTime ?? extracted?.opening_time ?? "";
  const closeT = extracted?.closingTime ?? extracted?.closing_time ?? "";
  let totalKm = extracted?.totalKM ?? extracted?.total_km ?? "";
  let totalHours = extracted?.totalHours ?? extracted?.total_hours ?? "";
  if ((totalKm === "" || totalKm == null)) {
    const o = num(openKm), c = num(closeKm);
    if (o != null && c != null && c >= o) totalKm = c - o;
  }
  if ((totalHours === "" || totalHours == null)) {
    const h = computeHours(openT, closeT);
    if (h != null) totalHours = h;
  }
  return {
    duty_date: extracted?.dutyDate ?? extracted?.duty_date ?? "",
    car_number: extracted?.carNumber ?? extracted?.car_number ?? "",
    vehicle_type: extracted?.vehicleType ?? extracted?.vehicle_type ?? "",
    driver_name: extracted?.driver ?? extracted?.driver_name ?? "",
    guest_name: extracted?.guest ?? extracted?.guest_name ?? "",
    company_name: extracted?.company ?? extracted?.company_name ?? "",
    opening_km: openKm,
    closing_km: closeKm,
    total_km: totalKm,
    opening_time: openT,
    closing_time: closeT,
    total_hours: totalHours,
    parking: extracted?.parking ?? "",
    tolls: extracted?.tolls ?? "",
  };
}

function num(v: any) {
  if (v === "" || v == null) return null;
  const n = Number(String(v).replace(/[^\d.\-]/g, ""));
  return isNaN(n) ? null : n;
}

function isOutstationPkg(rc: any): boolean {
  if (!rc) return false;
  const s = `${rc.package_type || ""} ${rc.vehicle_name || ""}`.toLowerCase();
  return /outstation|per\s*day|\/day|kms?\s*per\s*day/.test(s);
}

function deriveTotalKm(d: any): number | null {
  const o = num(d.opening_km), c = num(d.closing_km);
  if (o != null && c != null && c >= o) return c - o;
  return null;
}
function deriveTotalHours(d: any): number | null {
  return computeHours(d.opening_time, d.closing_time, d.duty_date, d.closing_date);
}

function parseTimeToMinutes(t: any): number | null {
  if (!t) return null;
  const s = String(t).trim();
  const m = s.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3]?.toLowerCase().replace(/\./g, "");
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
function computeHours(o: any, c: any, openDate?: string, closeDate?: string): number | null {
  const a = parseTimeToMinutes(o), b = parseTimeToMinutes(c);
  if (a == null || b == null) return null;
  let dayDiff = 0;
  if (openDate && closeDate) {
    const od = parseDateFlexible(openDate), cd = parseDateFlexible(closeDate);
    if (od && cd) {
      const ms = cd.setHours(0,0,0,0) - od.setHours(0,0,0,0);
      dayDiff = Math.max(0, Math.round(ms / 86400000));
    }
  }
  let d = (b - a) + dayDiff * 24 * 60;
  if (d < 0) d += 24 * 60;
  return Math.round((d / 60) * 100) / 100;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as any);
  }
  return btoa(binary);
}
function parseDateFlexible(s: string): Date | undefined {
  if (!s) return undefined;
  const t = s.trim();
  let m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    let [_, d, mo, y] = m as any;
    if (y.length === 2) y = "20" + y;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d));
    if (!isNaN(dt.getTime())) return dt;
  }
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!isNaN(dt.getTime())) return dt;
  }
  const dt = new Date(t);
  return isNaN(dt.getTime()) ? undefined : dt;
}

function formatDMY(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = d.getFullYear();
  return `${dd}/${mm}/${yy}`;
}

function toIsoDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = parseDateFlexible(s);
  if (!d) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function DateCell({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const parsed = parseDateFlexible(value);
  return (
    <div className="flex items-center gap-1">
      <Input
        className="h-8 text-xs w-24"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="dd/mm/yyyy"
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0">
            <CalendarIcon className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={parsed}
            defaultMonth={parsed}
            onSelect={(d) => { if (d) { onChange(formatDMY(d)); setOpen(false); } }}
            initialFocus
            className={cn("p-3 pointer-events-auto")}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

function TimeWithDateCell({ time, date, baseDate, onChangeTime, onChangeDate }: { time: string; date: string; baseDate: string; onChangeTime: (v: string) => void; onChangeDate: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const parsed = parseDateFlexible(date) ?? parseDateFlexible(baseDate);
  const base = parseDateFlexible(baseDate);
  const cd = parseDateFlexible(date);
  const dayOffset = base && cd ? Math.round((cd.setHours(0,0,0,0) - base.setHours(0,0,0,0)) / 86400000) : 0;
  return (
    <div className="flex items-center gap-1">
      <Input className="h-8 text-xs w-20" value={time} onChange={(e) => onChangeTime(e.target.value)} />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 relative" title="Closing date (for overnight trips)">
            <CalendarIcon className="h-3.5 w-3.5" />
            {dayOffset > 0 && <span className="absolute -top-0.5 -right-0.5 text-[9px] font-bold text-primary">+{dayOffset}</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={parsed}
            defaultMonth={parsed}
            onSelect={(d) => { if (d) { onChangeDate(formatDMY(d)); setOpen(false); } }}
            initialFocus
            className={cn("p-3 pointer-events-auto")}
          />
          {date && (
            <div className="p-2 border-t flex justify-end">
              <Button type="button" size="sm" variant="ghost" onClick={() => { onChangeDate(""); setOpen(false); }}>Clear</Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
