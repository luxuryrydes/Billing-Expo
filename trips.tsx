import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/db";
import { PageHeader } from "@/components/app/PageHeader";
import { DataCard } from "@/components/app/DataCard";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { fmtINR, computeTrip, gstFromRateCard, parseTimeToHours, type Pkg, type GstSetting } from "@/lib/billing";
import { isOutstationPackage } from "@/lib/billing";
import { createInvoiceFromTrips } from "@/lib/invoice";
import { buildBillDoc, splitBillDocPerUserIfNeeded } from "@/lib/bill-template";
import { exportBillXlsxMulti, exportBillPdf, exportBillDocxUniversalMulti } from "@/lib/bill-export";
import { toast } from "sonner";
import { FileText, Layers, Calendar, Package as PackageIcon, Satellite, Pencil, Trash2, FilterX, Image as ImageIcon } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ColumnFilter } from "@/components/app/ColumnFilter";

export const Route = createFileRoute("/_app/trips")({
  component: Page,
  validateSearch: (s: Record<string, unknown>) => ({
    editTrip: typeof s.editTrip === "string" ? s.editTrip : undefined,
  }),
});

function Page() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const routeSearch = Route.useSearch();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "uninvoiced" | "invoiced">("uninvoiced");
  const [monthFilter, setMonthFilter] = useState<string>("all"); // "all" | "1".."12"
  const [yearFilter, setYearFilter] = useState<string>("all");
  const [companyFilter, setCompanyFilter] = useState<string>("all");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingType, setPendingType] = useState<"single" | "merged" | "monthly">("single");
  const [chosenPkgId, setChosenPkgId] = useState<string>("");
  // Rate-card mode: when the selected trips share a department with rate cards,
  // we let the user pick a department rate card instead of a global package.
  // chosenRateCardId === "" means "use global package (chosenPkgId)".
  const [chosenRateCardId, setChosenRateCardId] = useState<string>("");
  const [chosenGstId, setChosenGstId] = useState<string>("");
  const [isNight, setIsNight] = useState(false);
  const [exportFormat, setExportFormat] = useState<"none" | "xlsx" | "pdf" | "docx">("none");
  const [editing, setEditing] = useState<any | null>(null);
  const [colFilters, setColFilters] = useState<Record<string, Set<string> | null>>({});
  function setColFilter(col: string, next: Set<string> | null) {
    setColFilters((prev) => ({ ...prev, [col]: next }));
  }
  type NumRange = { min: number | null; max: number | null };
  const [numFilters, setNumFilters] = useState<Record<"km" | "hrs" | "total", NumRange>>({
    km: { min: null, max: null },
    hrs: { min: null, max: null },
    total: { min: null, max: null },
  });
  function setNumFilter(col: "km" | "hrs" | "total", next: NumRange | null) {
    setNumFilters((prev) => ({ ...prev, [col]: next ?? { min: null, max: null } }));
  }

  const { data, isLoading } = useQuery({
    queryKey: ["trips"],
    queryFn: async () => {
      const { data, error } = await supabase.from("trips").select("*").is("deleted_at", null).order("duty_date", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  // When navigated here with ?editTrip=<id>, auto-open the edit dialog.
  useEffect(() => {
    const id = routeSearch?.editTrip;
    if (!id || !data) return;
    const t = (data as any[]).find((x) => x.id === id);
    if (t) {
      setEditing({ ...t });
      nav({ to: "/trips", search: {} as any, replace: true });
    }
  }, [routeSearch?.editTrip, data, nav]);

  const { data: packages } = useQuery({
    queryKey: ["packages-active"],
    queryFn: async () => {
      const { data, error } = await supabase.from("packages").select("*").eq("active", true).order("vehicle_name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: allRateCards } = useQuery({
    queryKey: ["all-rate-cards"],
    queryFn: async () => {
      const { data, error } = await supabase.from("department_rate_cards").select("id, vehicle_name, package_type, included_km, included_hours");
      if (error) throw error;
      return data ?? [];
    },
  });

  // Rate cards available for the trip being edited — scoped by its department
  // or institution so the user can swap packages while editing.
  const editingDeptId = editing?.department_id ?? null;
  const editingInstId = editing?.institution_id ?? null;
  const { data: editRateCards } = useQuery({
    queryKey: ["edit-trip-rate-cards", editingDeptId, editingInstId],
    enabled: !!editing && (!!editingDeptId || !!editingInstId),
    queryFn: async () => {
      let q = supabase.from("department_rate_cards").select("*").order("vehicle_name");
      q = editingDeptId
        ? q.eq("department_id", editingDeptId)
        : q.eq("institution_id", editingInstId as string);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });

  const pkgLabelById = useMemo(() => {
    const m = new Map<string, string>();
    (packages ?? []).forEach((p: any) => {
      m.set(p.id, p.package_type || `${p.included_hours}hr/${p.included_km}km`);
    });
    (allRateCards ?? []).forEach((r: any) => {
      m.set(r.id, r.package_type || `${r.included_hours}hr/${r.included_km}km`);
    });
    return m;
  }, [packages, allRateCards]);

  const { data: gstSettings } = useQuery({
    queryKey: ["gst-settings"],
    queryFn: async () => {
      const { data, error } = await supabase.from("gst_settings").select("*").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  // Resolve uploaded duty-slip images for each trip → signed URLs.
  const slipIds = useMemo(
    () => Array.from(new Set(((data ?? []) as any[]).map((t) => t.duty_slip_id).filter(Boolean))) as string[],
    [data],
  );
  const { data: slipUrlByTrip } = useQuery({
    queryKey: ["trip-slip-urls", slipIds.join(",")],
    enabled: slipIds.length > 0,
    queryFn: async () => {
      const { data: slips } = await supabase
        .from("duty_slips")
        .select("id, file_path, file_type")
        .in("id", slipIds);
      const out: Record<string, { url: string; isImage: boolean }> = {};
      for (const s of (slips ?? []) as any[]) {
        const { data: signed } = await supabase.storage
          .from("duty-slips")
          .createSignedUrl(s.file_path, 3600);
        if (signed?.signedUrl) {
          const ft = String(s.file_type || s.file_path || "").toLowerCase();
          const isImage = /(png|jpe?g|webp|gif|heic|heif|bmp|image\/)/.test(ft);
          out[s.id] = { url: signed.signedUrl, isImage };
        }
      }
      return out;
    },
  });

  // Department rate cards for the (single) department shared by all selected trips.
  const selectedDeptId = useMemo(() => {
    const rows = (data ?? []).filter((t: any) => selected.has(t.id)) as any[];
    const ids = Array.from(new Set(rows.map((t) => t.department_id).filter(Boolean)));
    return ids.length === 1 ? (ids[0] as string) : null;
  }, [data, selected]);

  const selectedInstId = useMemo(() => {
    const rows = (data ?? []).filter((t: any) => selected.has(t.id)) as any[];
    const ids = Array.from(new Set(rows.map((t) => t.institution_id).filter(Boolean)));
    return ids.length === 1 ? (ids[0] as string) : null;
  }, [data, selected]);

  const { data: deptRateCards } = useQuery({
    queryKey: ["billing-rate-cards", selectedDeptId, selectedInstId],
    enabled: !!selectedDeptId || !!selectedInstId,
    queryFn: async () => {
      let q = supabase
        .from("department_rate_cards")
        .select("*")
        .order("vehicle_name");
      q = selectedDeptId ? q.eq("department_id", selectedDeptId) : q.eq("institution_id", selectedInstId as string);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: selectedDept } = useQuery({
    queryKey: ["department-detail", selectedDeptId],
    enabled: !!selectedDeptId,
    queryFn: async () => {
      const { data } = await supabase.from("departments").select("*").eq("id", selectedDeptId as string).single();
      return data;
    },
  });

  // Build a Pkg-like object from a department rate card so computeTrip can use it.
  function rateCardToPkg(rc: any): Pkg {
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

  // Detect whether a trip falls in the rate card's night slot.
  function timeToMin(t: any): number | null {
    if (!t) return null;
    const m = String(t).match(/(\d{1,2})[:.](\d{2})/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }
  function tripIsNight(t: any, rc: any | null, manual: boolean): boolean {
    if (manual) return true;
    if (!rc?.night_start_time || !rc?.night_end_time) return false;
    const s = timeToMin(rc.night_start_time);
    const e = timeToMin(rc.night_end_time);
    const o = timeToMin(t.opening_time);
    const c = timeToMin(t.closing_time);
    if (s == null || e == null) return false;
    const inSlot = (x: number | null) => {
      if (x == null) return false;
      return s <= e ? x >= s && x <= e : x >= s || x <= e; // wraps midnight
    };
    return inSlot(o) || inSlot(c);
  }

  const filtered = useMemo(() => {
    let rows = (data ?? []) as any[];
    if (filter === "uninvoiced") rows = rows.filter((r) => !r.invoiced);
    if (filter === "invoiced") rows = rows.filter((r) => r.invoiced);
    if (monthFilter !== "all") {
      const m = parseInt(monthFilter, 10);
      rows = rows.filter((r) => r.duty_date && new Date(r.duty_date).getMonth() + 1 === m);
    }
    if (yearFilter !== "all") {
      const y = parseInt(yearFilter, 10);
      rows = rows.filter((r) => r.duty_date && new Date(r.duty_date).getFullYear() === y);
    }
    if (companyFilter !== "all") {
      rows = rows.filter((r) => String(r.company_name ?? "") === companyFilter);
    }
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((r) =>
        [r.guest_name, r.car_number, r.company_name, r.driver_name].some((v) => String(v ?? "").toLowerCase().includes(q))
      );
    }
    const colKey = (r: any, col: string): string => {
      switch (col) {
        case "date": return r.duty_date ? new Date(r.duty_date).toLocaleDateString("en-IN") : "";
        case "company": return String(r.company_name ?? "");
        case "guest": return String(r.guest_name ?? "") + (r.car_number ? ` · ${r.car_number}` : "");
        case "vehicle": return String(r.vehicle_type ?? "");
        case "package": return r.package_id ? (pkgLabelById.get(r.package_id) ?? "") : "";
        case "km": return r.total_km == null ? "" : String(r.total_km);
        case "hrs": return r.total_hours == null ? "" : String(r.total_hours);
        case "total": return r.grand_total == null ? "" : String(r.grand_total);
        case "status": return r.invoiced ? "Invoiced" : "Pending";
        default: return "";
      }
    };
    for (const [col, sel] of Object.entries(colFilters)) {
      if (!sel) continue;
      if (sel.size === 0) continue;
      rows = rows.filter((r) => sel.has(colKey(r, col)));
    }
    const numKey: Record<"km" | "hrs" | "total", (r: any) => number | null> = {
      km: (r) => (r.total_km == null ? null : Number(r.total_km)),
      hrs: (r) => (r.total_hours == null ? null : Number(r.total_hours)),
      total: (r) => (r.grand_total == null ? null : Number(r.grand_total)),
    };
    for (const k of ["km", "hrs", "total"] as const) {
      const { min, max } = numFilters[k];
      if (min == null && max == null) continue;
      rows = rows.filter((r) => {
        const v = numKey[k](r);
        if (v == null) return false;
        if (min != null && v < min) return false;
        if (max != null && v > max) return false;
        return true;
      });
    }
    return rows;
  }, [data, search, filter, monthFilter, yearFilter, companyFilter, colFilters, numFilters]);

  const yearOptions = useMemo(() => {
    const ys = new Set<number>();
    for (const r of (data ?? []) as any[]) {
      if (r.duty_date) ys.add(new Date(r.duty_date).getFullYear());
    }
    return Array.from(ys).sort((a, b) => b - a);
  }, [data]);
  const companyOptions = useMemo(() => {
    const cs = new Set<string>();
    for (const r of (data ?? []) as any[]) {
      const v = String(r.company_name ?? "").trim();
      if (v) cs.add(v);
    }
    return Array.from(cs).sort((a, b) => a.localeCompare(b));
  }, [data]);

  const colValues = useMemo(() => {
    const base = (data ?? []) as any[];
    return {
      date: base.map((r) => (r.duty_date ? new Date(r.duty_date).toLocaleDateString("en-IN") : "")),
      company: base.map((r) => String(r.company_name ?? "")),
      guest: base.map((r) => String(r.guest_name ?? "") + (r.car_number ? ` · ${r.car_number}` : "")),
      vehicle: base.map((r) => String(r.vehicle_type ?? "")),
      package: base.map((r) => (r.package_id ? (pkgLabelById.get(r.package_id) ?? "") : "")),
      km: base.map((r) => (r.total_km == null ? "" : String(r.total_km))),
      hrs: base.map((r) => (r.total_hours == null ? "" : String(r.total_hours))),
      total: base.map((r) => (r.grand_total == null ? "" : String(r.grand_total))),
      status: base.map((r) => (r.invoiced ? "Invoiced" : "Pending")),
    };
  }, [data]);

  const activeFilterCount = useMemo(
    () =>
      Object.values(colFilters).filter((s) => s && s.size > 0).length +
      (["km", "hrs", "total"] as const).filter(
        (k) => numFilters[k].min != null || numFilters[k].max != null,
      ).length,
    [colFilters, numFilters],
  );

  const toggle = (id: string) => {
    const s = new Set(selected);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelected(s);
  };
  const visibleIds = useMemo(() => filtered.map((r: any) => r.id as string), [filtered]);
  const visibleSelectedCount = useMemo(
    () => visibleIds.reduce((n, id) => n + (selected.has(id) ? 1 : 0), 0),
    [visibleIds, selected],
  );
  const allVisibleSelected = visibleIds.length > 0 && visibleSelectedCount === visibleIds.length;
  const someVisibleSelected = visibleSelectedCount > 0 && visibleSelectedCount < visibleIds.length;
  const toggleAll = () => {
    const next = new Set(selected);
    if (allVisibleSelected) {
      visibleIds.forEach((id) => next.delete(id));
    } else {
      visibleIds.forEach((id) => next.add(id));
    }
    setSelected(next);
  };

  function openPicker(type: "single" | "merged" | "monthly") {
    if (type === "single" && selected.size !== 1) return toast.error("Select exactly 1 trip");
    if (type === "merged" && selected.size < 2) return toast.error("Select at least 2 trips");
    if (selected.size === 0) return toast.error("Select at least 1 trip");

    // Fast path: if every selected trip already has a package + computed total
    // (assigned during upload), skip the picker and generate the bill directly
    // using each trip's own package + GST.
    const ids = Array.from(selected);
    const rows = (data ?? []).filter((t: any) => ids.includes(t.id)) as any[];
    const allReady = rows.length > 0 && rows.every((t) =>
      t.package_id && Number(t.grand_total || 0) > 0,
    );
    if (allReady) {
      setPendingType(type);
      fastCreate.mutate(type);
      return;
    }

    setPendingType(type);
    // Default to first active package and default GST
    if (!chosenPkgId && packages?.[0]) setChosenPkgId(packages[0].id);
    // Reset rate card pick — it'll be auto-selected when the picker opens if a dept is shared
    setChosenRateCardId("");
    const def = gstSettings?.find((g: any) => g.is_default) || gstSettings?.[0];
    if (!chosenGstId && def) {
      // Prefer department's default GST when available
      setChosenGstId((selectedDept as any)?.default_gst_setting_id || def.id);
    } else if ((selectedDept as any)?.default_gst_setting_id) {
      setChosenGstId((selectedDept as any).default_gst_setting_id);
    }
    setPickerOpen(true);
  }

  // Fast-path: trips already have packages + totals → create invoice directly.
  const fastCreate = useMutation({
    mutationFn: async (type: "single" | "merged" | "monthly") => {
      const ids = Array.from(selected);
      const tripRows = (data ?? []).filter((t: any) => ids.includes(t.id)) as any[];
      const pkgIds = Array.from(new Set(tripRows.map((t: any) => t.package_id).filter(Boolean))) as string[];
      const pkgMap = new Map<string, Pkg>();
      if (pkgIds.length) {
        const [{ data: pkgRows }, { data: rcRows }] = await Promise.all([
          supabase.from("packages").select("*").in("id", pkgIds),
          supabase.from("department_rate_cards").select("*").in("id", pkgIds),
        ]);
        (pkgRows ?? []).forEach((p: any) => pkgMap.set(p.id, p as Pkg));
        (rcRows ?? []).forEach((r: any) => pkgMap.set(r.id, rateCardToPkg(r)));
      }
      const defaultGst = (gstSettings?.find((g: any) => g.is_default) || gstSettings?.[0] || null) as GstSetting | null;
      for (const t of tripRows) {
        const pricing = t.package_id ? pkgMap.get(t.package_id) : null;
        if (!pricing) continue;
        const calc = computeTrip({
          total_km: Number(t.total_km || 0),
          total_hours: Number(t.total_hours || 0),
          parking: Number(t.parking || 0),
          tolls: Number(t.tolls || 0),
          days: Number(t.days || 1),
          duty_date: t.duty_date || null,
          closing_date: t.closing_date || null,
          opening_time: t.opening_time || null,
          closing_time: t.closing_time || null,
          package: pricing,
        }, gstFromRateCard(pricing) ?? defaultGst);
        const { error } = await supabase.from("trips").update({
          base_fare: calc.base_fare,
          extra_km_charge: calc.extra_km_charge,
          extra_hour_charge: calc.extra_hour_charge,
          night_charge: calc.night_charge,
          driver_allowance: calc.driver_allowance,
          taxable_amount: calc.taxable_amount,
          gst_breakup: calc.gst_breakup,
          gst_total: calc.gst_total,
          grand_total: calc.grand_total,
        }).eq("id", t.id);
        if (error) throw error;
      }
      let periodFrom: string | undefined; let periodTo: string | undefined;
      if (type === "monthly") {
        const dates = ids
          .map((id) => filtered.find((t) => t.id === id)?.duty_date)
          .filter(Boolean)
          .sort();
        periodFrom = dates[0]; periodTo = dates[dates.length - 1];
      }
      return await createInvoiceFromTrips({
        tripIds: ids,
        type,
        periodFrom,
        periodTo,
        departmentId: selectedDeptId,
        institutionId: selectedInstId,
      });
    },
    onSuccess: async (inv) => {
      toast.success(`Invoice ${inv.invoice_no} created`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["trips"] });
      // Do not auto-download the Word file when merging trips into an invoice.
      // The merged bill is generated from the Invoices dashboard.
      nav({ to: "/invoices" });
    },
    onError: (e: any) => toast.error(e.message || "Failed"),
  });

  const createInvoice = useMutation({
    mutationFn: async () => {
      const ids = Array.from(selected);
      const rc = (deptRateCards ?? []).find((r: any) => r.id === chosenRateCardId);
      const pkg = rc ? null : packages?.find((p: any) => p.id === chosenPkgId);
      if (!rc && !pkg) throw new Error("Please choose a rate card or package");
      const pricing: Pkg = rc ? rateCardToPkg(rc) : (pkg as unknown as Pkg);
      const gst = (rc ? gstFromRateCard(rc) : gstSettings?.find((g: any) => g.id === chosenGstId) || null) as GstSetting | null;

      // Recalculate each trip from the chosen package + GST and save back
      const tripRows = (data ?? []).filter((t: any) => ids.includes(t.id));
      for (const t of tripRows as any[]) {
        const calc = computeTrip(
          {
            total_km: Number(t.total_km || 0),
            total_hours: Number(t.total_hours || 0),
            parking: Number(t.parking || 0),
            tolls: Number(t.tolls || 0),
            is_night: tripIsNight(t, rc, isNight),
            days: Number(t.days || 1),
            duty_date: t.duty_date || null,
            closing_date: t.closing_date || null,
            opening_time: t.opening_time || null,
            closing_time: t.closing_time || null,
            package: pricing,
          },
          gst,
        );
        const { error: uErr } = await supabase
          .from("trips")
          .update({
            package_id: rc ? rc.id : (pkg ? pkg.id : null),
            base_fare: calc.base_fare,
            extra_km_charge: calc.extra_km_charge,
            extra_hour_charge: calc.extra_hour_charge,
            night_charge: calc.night_charge,
            driver_allowance: calc.driver_allowance,
            taxable_amount: calc.taxable_amount,
            gst_breakup: calc.gst_breakup,
            gst_total: calc.gst_total,
            grand_total: calc.grand_total,
          })
          .eq("id", t.id);
        if (uErr) throw uErr;
      }

      let periodFrom: string | undefined; let periodTo: string | undefined;
      if (pendingType === "monthly") {
        const dates = ids
          .map((id) => filtered.find((t) => t.id === id)?.duty_date)
          .filter(Boolean)
          .sort();
        periodFrom = dates[0]; periodTo = dates[dates.length - 1];
      }
      return await createInvoiceFromTrips({
        tripIds: ids,
        type: pendingType,
        periodFrom,
        periodTo,
        departmentId: selectedDeptId,
      });
    },
    onSuccess: async (inv) => {
      toast.success(`Invoice ${inv.invoice_no} created`);
      setSelected(new Set());
      setPickerOpen(false);
      qc.invalidateQueries({ queryKey: ["trips"] });
      // For Single Invoice always auto-download a Word (.docx) bill from here.
      // For merged/monthly: xlsx/pdf if explicitly chosen; .docx stays on Invoices.
      const autoDocx = pendingType === "single";
      const effFmt: "none" | "xlsx" | "pdf" | "docx" =
        autoDocx ? "docx" : (exportFormat === "docx" ? "none" : exportFormat);
      if (effFmt !== "none") {
        try {
          const doc = await buildBillDoc([inv.id]);
          const docs = splitBillDocPerUserIfNeeded(doc);
          if (effFmt === "docx") {
            await exportBillDocxUniversalMulti(docs, `${inv.invoice_no}.docx`);
          } else if (effFmt === "xlsx") {
            await exportBillXlsxMulti(docs, `${inv.invoice_no}-merged.xlsx`);
          } else for (const d of docs) {
            const tag = docs.length > 1
              ? "-" + (d.custom_fields?.find((cf) => cf.label.toLowerCase().includes("user"))?.value || "user").replace(/[^a-z0-9]+/gi, "_")
              : "";
            const base = `${inv.invoice_no}-merged${tag}`;
            if (effFmt === "pdf") await exportBillPdf(d, `${base}.pdf`);
          }
        } catch (e: any) { toast.error(e.message || "Export failed"); }
      }
      nav({ to: "/invoices" });
    },
    onError: (e: any) => toast.error(e.message || "Failed"),
  });

  // Live preview for the picker
  const previewTotal = useMemo(() => {
    const rc = (deptRateCards ?? []).find((r: any) => r.id === chosenRateCardId);
    const pkg = rc ? null : packages?.find((p: any) => p.id === chosenPkgId);
    const pricing: Pkg | null = rc ? rateCardToPkg(rc) : (pkg as unknown as Pkg) || null;
    const gst = (rc ? gstFromRateCard(rc) : gstSettings?.find((g: any) => g.id === chosenGstId) || null) as GstSetting | null;
    if (!pricing) return 0;
    const ids = Array.from(selected);
    const rows = (data ?? []).filter((t: any) => ids.includes(t.id)) as any[];
    return rows.reduce((sum, t) => {
      const c = computeTrip(
        {
          total_km: Number(t.total_km || 0),
          total_hours: Number(t.total_hours || 0),
          parking: Number(t.parking || 0),
          tolls: Number(t.tolls || 0),
          is_night: tripIsNight(t, rc, isNight),
          days: Number(t.days || 1),
            duty_date: t.duty_date || null,
            closing_date: t.closing_date || null,
            opening_time: t.opening_time || null,
            closing_time: t.closing_time || null,
          package: pricing,
        },
        gst,
      );
      return sum + c.grand_total;
    }, 0);
  }, [packages, deptRateCards, gstSettings, chosenPkgId, chosenRateCardId, chosenGstId, isNight, selected, data]);

  // Detect whether the selected batch is an outstation (multi-day) job.
  // Used to auto-pick the matching outstation rate-card row and warn the
  // user if they accidentally pick a local (per-day-hours) row instead.
  const selectedTripsInfo = useMemo(() => {
    const ids = Array.from(selected);
    const rows = (data ?? []).filter((t: any) => ids.includes(t.id)) as any[];
    const isMultiDay = rows.some((t) => Number(t.days || 1) > 1);
    const vehicles = Array.from(new Set(rows.map((t) => String(t.vehicle_type || "").toLowerCase()).filter(Boolean)));
    return { isMultiDay, vehicles, count: rows.length };
  }, [selected, data]);

  // Auto-pick the correct outstation row when the picker opens for a
  // multi-day batch — matches by vehicle name when possible.
  useEffect(() => {
    if (!pickerOpen) return;
    if (chosenRateCardId) return;
    if (!selectedTripsInfo.isMultiDay) return;
    const rows = (deptRateCards ?? []) as any[];
    const outstationRows = rows.filter((r) =>
      isOutstationPackage({ package_type: r.package_type, vehicle_name: r.vehicle_name }),
    );
    if (outstationRows.length === 0) return;
    const vehicleMatch = outstationRows.find((r) =>
      selectedTripsInfo.vehicles.includes(String(r.vehicle_name || "").toLowerCase()),
    );
    const pick = vehicleMatch || outstationRows[0];
    setChosenRateCardId(pick.id);
    setChosenPkgId("");
  }, [pickerOpen, selectedTripsInfo, deptRateCards, chosenRateCardId]);

  const syncGps = useMutation({
    mutationFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error("Not signed in");
      const res = await fetch("/api/public/gps/sync", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || "Sync failed");
      return j;
    },
    onSuccess: (r: any) => {
      toast.success(
        `GPS synced · ${r.devices} devices · ${r.opened} opened · ${r.closed} closed · ${r.skipped} unmapped`,
      );
      qc.invalidateQueries({ queryKey: ["trips"] });
    },
    onError: (e: any) => toast.error(e.message || "GPS sync failed"),
  });

  const saveTrip = useMutation({
    mutationFn: async (t: any) => {
      const num = (v: any) => (v === "" || v === null || v === undefined ? null : Number(v));
      // Auto-derive total_km / total_hours from opening/closing if user edited those.
      const ok = num(t.opening_km), ck = num(t.closing_km);
      let totalKm = num(t.total_km);
      if (ok != null && ck != null && ck >= ok) totalKm = ck - ok;
      let totalHours = num(t.total_hours);
      if (t.opening_time && t.closing_time) {
        const h = parseTimeToHours(t.opening_time, t.closing_time);
        if (h > 0) totalHours = h;
      }

      // Recompute bill totals from the chosen package + GST so the next
      // invoice generated for this trip uses the edited km / hours / package.
      const rc = (editRateCards ?? []).find((r: any) => r.id === t.package_id);
      const pkg = rc ? null : packages?.find((p: any) => p.id === t.package_id);
      const pricing: Pkg | null = rc ? rateCardToPkg(rc) : (pkg as unknown as Pkg) || null;
      const gst = (rc
        ? gstFromRateCard(rc)
        : gstSettings?.find((g: any) => g.is_default) || gstSettings?.[0] || null
      ) as GstSetting | null;

      let calcFields: Record<string, any> = {};
      if (pricing) {
        const calc = computeTrip(
          {
            total_km: Number(totalKm || 0),
            total_hours: Number(totalHours || 0),
            parking: Number(num(t.parking) ?? 0),
            tolls: Number(num(t.tolls) ?? 0),
            is_night: tripIsNight(t, rc, false),
            days: Number(num(t.days) ?? 1),
            duty_date: t.duty_date || null,
            closing_date: t.closing_date || null,
            opening_time: t.opening_time || null,
            closing_time: t.closing_time || null,
            package: pricing,
          },
          gst,
        );
        calcFields = {
          base_fare: calc.base_fare,
          extra_km_charge: calc.extra_km_charge,
          extra_hour_charge: calc.extra_hour_charge,
          night_charge: calc.night_charge,
          driver_allowance: calc.driver_allowance,
          taxable_amount: calc.taxable_amount,
          gst_breakup: calc.gst_breakup,
          gst_total: calc.gst_total,
          grand_total: calc.grand_total,
        };
      }

      const payload = {
        duty_date: t.duty_date || null,
        company_name: t.company_name || null,
        guest_name: t.guest_name || null,
        car_number: t.car_number || null,
        vehicle_type: t.vehicle_type || null,
        driver_name: t.driver_name || null,
        opening_km: num(t.opening_km),
        closing_km: num(t.closing_km),
        total_km: totalKm,
        opening_time: t.opening_time || null,
        closing_time: t.closing_time || null,
        total_hours: totalHours,
        parking: num(t.parking) ?? 0,
        tolls: num(t.tolls) ?? 0,
        days: num(t.days),
        notes: t.notes || null,
        package_id: t.package_id || null,
        ...calcFields,
      };
      const { error } = await supabase.from("trips").update(payload).eq("id", t.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Trip updated");
      setEditing(null);
      qc.invalidateQueries({ queryKey: ["trips"] });
    },
    onError: (e: any) => toast.error(e.message || "Failed to update"),
  });

  const deleteTrips = useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await supabase
        .from("trips")
        .update({ deleted_at: new Date().toISOString() })
        .in("id", ids);
      if (error) throw error;
    },
    onSuccess: (_d, ids) => {
      toast.success(`Moved ${ids.length} trip${ids.length === 1 ? "" : "s"} to Recycle Bin`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["trips"] });
    },
    onError: (e: any) => toast.error(e.message || "Delete failed"),
  });

  function confirmDelete(ids: string[]) {
    if (ids.length === 0) return;
    const msg = ids.length === 1
      ? "Move this trip to the Recycle Bin? You can restore it later."
      : `Move ${ids.length} trips to the Recycle Bin? You can restore them later.`;
    if (window.confirm(msg)) deleteTrips.mutate(ids);
  }

  return (
    <div>
      <PageHeader
        title="Trips"
        description="Verified trips ready to bill. Select trips and create invoices."
        action={
          <>
            <Button variant="outline" size="sm" disabled={syncGps.isPending} onClick={() => syncGps.mutate()}>
              <Satellite className="h-4 w-4 mr-1" /> {syncGps.isPending ? "Syncing…" : "Sync GPS"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={selected.size === 0 || deleteTrips.isPending}
              onClick={() => confirmDelete(Array.from(selected))}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="h-4 w-4 mr-1" /> Delete ({selected.size})
            </Button>
            <Button variant="outline" size="sm" disabled={selected.size !== 1 || createInvoice.isPending} onClick={() => openPicker("single")}>
              <FileText className="h-4 w-4 mr-1" /> Single Invoice
            </Button>
            <Button variant="outline" size="sm" disabled={selected.size < 2 || createInvoice.isPending} onClick={() => openPicker("merged")}>
              <Layers className="h-4 w-4 mr-1" /> Merge ({selected.size})
            </Button>
            <Button size="sm" disabled={selected.size === 0 || createInvoice.isPending} onClick={() => openPicker("monthly")}>
              <Calendar className="h-4 w-4 mr-1" /> Monthly
            </Button>
          </>
        }
      />
      <DataCard>
        <div className="flex flex-wrap gap-2 mb-4 items-center">
          <Input placeholder="Search guest / car / company…" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-sm" />
          <select
            value={monthFilter}
            onChange={(e) => setMonthFilter(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="all">All months</option>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <option key={m} value={String(m)}>
                {new Date(2000, m - 1, 1).toLocaleString("en-IN", { month: "long" })}
              </option>
            ))}
          </select>
          <select
            value={yearFilter}
            onChange={(e) => setYearFilter(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="all">All years</option>
            {yearOptions.map((y) => (
              <option key={y} value={String(y)}>{y}</option>
            ))}
          </select>
          <select
            value={companyFilter}
            onChange={(e) => setCompanyFilter(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm max-w-[200px]"
          >
            <option value="all">All companies</option>
            {companyOptions.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <div className="flex gap-1">
            {(["uninvoiced","invoiced","all"] as const).map((f) => (
              <Button key={f} size="sm" variant={filter === f ? "default" : "outline"} onClick={() => setFilter(f)} className="capitalize">{f}</Button>
            ))}
          </div>
          {activeFilterCount > 0 && (
            <>
              <Badge variant="secondary" className="ml-1">{activeFilterCount} filter{activeFilterCount === 1 ? "" : "s"} active</Badge>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setColFilters({});
                  setNumFilters({ km: { min: null, max: null }, hrs: { min: null, max: null }, total: { min: null, max: null } });
                }}
              >
                <FilterX className="h-4 w-4 mr-1" /> Clear all filters
              </Button>
            </>
          )}
          {selected.size > 0 && (
            <Badge variant="secondary" className="ml-auto">{selected.size} selected</Badge>
          )}
        </div>
        {isLoading ? (
          <div className="text-muted-foreground text-sm">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="text-muted-foreground text-sm py-8 text-center">No trips. Upload a duty slip to get started.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground border-b">
                  <th className="py-2 w-8"><Checkbox checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false} onCheckedChange={toggleAll} /></th>
                  <th className="py-2 pr-4"><span className="inline-flex items-center">Date<ColumnFilter values={colValues.date} selected={colFilters.date ?? null} onChange={(v) => setColFilter("date", v)} /></span></th>
                  <th className="py-2 pr-4"><span className="inline-flex items-center">Company<ColumnFilter values={colValues.company} selected={colFilters.company ?? null} onChange={(v) => setColFilter("company", v)} /></span></th>
                  <th className="py-2 pr-4"><span className="inline-flex items-center">Guest / Car<ColumnFilter values={colValues.guest} selected={colFilters.guest ?? null} onChange={(v) => setColFilter("guest", v)} /></span></th>
                  <th className="py-2 pr-4"><span className="inline-flex items-center">Vehicle<ColumnFilter values={colValues.vehicle} selected={colFilters.vehicle ?? null} onChange={(v) => setColFilter("vehicle", v)} /></span></th>
                  <th className="py-2 pr-4">Slip</th>
                  <th className="py-2 pr-4"><span className="inline-flex items-center">Package<ColumnFilter values={colValues.package} selected={colFilters.package ?? null} onChange={(v) => setColFilter("package", v)} /></span></th>
                  <th className="py-2 pr-4"><span className="inline-flex items-center">KM<ColumnFilter mode="range" values={colValues.km} selected={null} onChange={() => {}} range={numFilters.km} onRangeChange={(r) => setNumFilter("km", r)} /></span></th>
                  <th className="py-2 pr-4"><span className="inline-flex items-center">Hrs<ColumnFilter mode="range" values={colValues.hrs} selected={null} onChange={() => {}} range={numFilters.hrs} onRangeChange={(r) => setNumFilter("hrs", r)} /></span></th>
                  <th className="py-2 pr-4"><span className="inline-flex items-center">Total<ColumnFilter mode="range" values={colValues.total} selected={null} onChange={() => {}} range={numFilters.total} onRangeChange={(r) => setNumFilter("total", r)} /></span></th>
                  <th className="py-2"><span className="inline-flex items-center">Status<ColumnFilter values={colValues.status} selected={colFilters.status ?? null} onChange={(v) => setColFilter("status", v)} /></span></th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t: any) => (
                  <tr key={t.id} className="border-b border-border/40 hover:bg-muted/20">
                    <td className="py-2"><Checkbox checked={selected.has(t.id)} onCheckedChange={() => toggle(t.id)} /></td>
                    <td className="py-2 pr-4">{t.duty_date ? new Date(t.duty_date).toLocaleDateString("en-IN") : "—"}</td>
                    <td className="py-2 pr-4 max-w-[160px] truncate">{t.company_name || "—"}</td>
                    <td className="py-2 pr-4 max-w-[180px] truncate">{t.guest_name || "—"}<br /><span className="text-xs text-muted-foreground">{t.car_number}</span></td>
                    <td className="py-2 pr-4">{t.vehicle_type || "—"}</td>
                    <td className="py-2 pr-4">
                      {t.duty_slip_id && slipUrlByTrip?.[t.duty_slip_id] ? (
                        <a
                          href={slipUrlByTrip[t.duty_slip_id].url}
                          target="_blank"
                          rel="noreferrer"
                          title="View uploaded duty slip"
                          className="inline-block"
                        >
                          {slipUrlByTrip[t.duty_slip_id].isImage ? (
                            <img
                              src={slipUrlByTrip[t.duty_slip_id].url}
                              alt="Duty slip"
                              className="h-12 w-12 object-cover rounded border border-border hover:border-gold transition"
                              loading="lazy"
                            />
                          ) : (
                            <span className="inline-flex h-12 w-12 items-center justify-center rounded border border-border text-muted-foreground hover:border-gold">
                              <ImageIcon className="h-5 w-5" />
                            </span>
                          )}
                        </a>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-xs">{t.package_id ? (pkgLabelById.get(t.package_id) ?? "—") : "—"}</td>
                    <td className="py-2 pr-4">{t.total_km ?? "—"}</td>
                    <td className="py-2 pr-4">{t.total_hours ?? "—"}</td>
                    <td className="py-2 pr-4 font-medium gold-text">{fmtINR(t.grand_total)}</td>
                    <td className="py-2">{t.invoiced ? <Badge variant="secondary">Invoiced</Badge> : <Badge>Pending</Badge>}</td>
                    <td className="py-2">
                      <Button size="sm" variant="ghost" onClick={() => setEditing({ ...t })} title="Edit trip">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => confirmDelete([t.id])}
                        title="Delete trip"
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DataCard>

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display text-gold flex items-center gap-2">
              <PackageIcon className="h-5 w-5" /> Choose a package for billing
            </DialogTitle>
            <DialogDescription>
              The selected package's rates will be applied to {selected.size} trip{selected.size === 1 ? "" : "s"} and the bill will be generated.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {selectedDeptId && (deptRateCards?.length ?? 0) > 0 && (
              <div>
                <Label className="text-xs">Department Rate Card{(selectedDept as any)?.name ? ` — ${(selectedDept as any).name}` : ""}</Label>
                <p className="text-[11px] text-muted-foreground mt-0.5 mb-2">
                  These rates are tied to the department selected on the trip. Pick one to bill in that department's format.
                </p>
                <div className="mt-1 grid gap-2 max-h-60 overflow-y-auto pr-1">
                  {(deptRateCards ?? []).map((r: any) => {
                    const sel = chosenRateCardId === r.id;
                    const rowOutstation = isOutstationPackage({ package_type: r.package_type, vehicle_name: r.vehicle_name });
                    const mismatch = selectedTripsInfo.isMultiDay && !rowOutstation;
                    const recommended = selectedTripsInfo.isMultiDay && rowOutstation &&
                      selectedTripsInfo.vehicles.includes(String(r.vehicle_name || "").toLowerCase());
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => { setChosenRateCardId(r.id); setChosenPkgId(""); }}
                        className={`text-left rounded-md border p-3 transition ${sel ? "border-gold bg-gold/10 glow-gold" : mismatch ? "border-border/40 opacity-60 hover:opacity-100 hover:border-gold/40" : "border-border hover:border-gold/50"}`}
                      >
                        <div className="flex justify-between items-start gap-2">
                          <div>
                            <div className="font-medium flex items-center gap-2 flex-wrap">
                              <span>{r.vehicle_name} <span className="text-xs text-muted-foreground">· {r.package_type}</span></span>
                              {rowOutstation && <Badge variant="secondary" className="text-[10px] py-0">Outstation</Badge>}
                              {recommended && <Badge className="text-[10px] py-0 bg-gold/20 text-gold border-gold/40">Recommended</Badge>}
                              {mismatch && <Badge variant="outline" className="text-[10px] py-0 text-amber-500 border-amber-500/40">Local rate</Badge>}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {r.included_km} km / {r.included_hours} hr · ₹{r.extra_km_rate}/km · ₹{r.extra_hour_rate}/hr
                            </div>
                          </div>
                          <div className="font-medium gold-text whitespace-nowrap">{fmtINR(r.base_fare)}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
                {selectedTripsInfo.isMultiDay && (
                  <p className="text-[11px] text-amber-500 mt-2">
                    Multi-day trip detected ({selectedTripsInfo.count} trip{selectedTripsInfo.count === 1 ? "" : "s"}). Pick the <strong>Outstation</strong> row — local per-hour rates will bill the wrong base.
                  </p>
                )}
              </div>
            )}

            <div>
              <Label className="text-xs">{selectedDeptId && (deptRateCards?.length ?? 0) > 0 ? "Or pick a global Package" : "Package"}</Label>
              {(!packages || packages.length === 0) ? (
                <div className="text-sm text-muted-foreground py-3">
                  No active packages. Add one in the Packages page first.
                </div>
              ) : (
                <div className="mt-2 grid gap-2 max-h-60 overflow-y-auto pr-1">
                  {packages.map((p: any) => {
                    const sel = !chosenRateCardId && chosenPkgId === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => { setChosenPkgId(p.id); setChosenRateCardId(""); }}
                        className={`text-left rounded-md border p-3 transition ${sel ? "border-gold bg-gold/5 glow-gold" : "border-border hover:border-gold/50"}`}
                      >
                        <div className="flex justify-between items-start gap-2">
                          <div>
                            <div className="font-medium">{p.vehicle_name} <span className="text-xs text-muted-foreground">· {p.package_type}</span></div>
                            <div className="text-xs text-muted-foreground">
                              {p.included_km} km / {p.included_hours} hr · ₹{p.extra_km_rate}/km · ₹{p.extra_hour_rate}/hr
                            </div>
                          </div>
                          <div className="font-medium gold-text whitespace-nowrap">{fmtINR(p.base_fare)}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {gstSettings && gstSettings.length > 0 && (
              <div>
                <Label className="text-xs">GST</Label>
                <select
                  className="mt-1 w-full h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                  value={chosenGstId}
                  onChange={(e) => setChosenGstId(e.target.value)}
                >
                  <option value="">No GST</option>
                  {gstSettings.map((g: any) => (
                    <option key={g.id} value={g.id}>
                      {g.name} ({g.mode})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={isNight} onCheckedChange={(v) => setIsNight(!!v)} />
              Apply night charges
            </label>

            <div>
              <Label className="text-xs">Also export merged bill (AAI/Kinetic format)</Label>
              <select
                className="mt-1 w-full h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                value={exportFormat}
                onChange={(e) => setExportFormat(e.target.value as any)}
              >
                <option value="none">No — just create the bill</option>
                <option value="xlsx">Excel (.xlsx) — fully editable</option>
                <option value="pdf">PDF (formatted, print-ready)</option>
              </select>
            </div>

            <div className="rounded-md bg-muted/30 p-3 flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Estimated total</span>
              <span className="text-lg font-display gold-text">{fmtINR(previewTotal)}</span>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setPickerOpen(false)} disabled={createInvoice.isPending}>Cancel</Button>
            <Button
              onClick={() => createInvoice.mutate()}
              disabled={(!chosenPkgId && !chosenRateCardId) || createInvoice.isPending}
              className="bg-gold text-primary-foreground hover:opacity-90 glow-gold"
            >
              {createInvoice.isPending ? "Creating…" : "Create Bill"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-display text-gold flex items-center gap-2">
              <Pencil className="h-5 w-5" /> Edit Trip
            </DialogTitle>
            <DialogDescription>Update trip details. Bill totals will recalculate next time you generate a bill.</DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[60vh] overflow-y-auto pr-1">
              {[
                ["Date", "duty_date", "date"],
                ["Company", "company_name", "text"],
                ["Guest Name", "guest_name", "text"],
                ["Car Number", "car_number", "text"],
                ["Vehicle Type", "vehicle_type", "text"],
                ["Driver Name", "driver_name", "text"],
                ["Opening KM", "opening_km", "number"],
                ["Closing KM", "closing_km", "number"],
                ["Total KM", "total_km", "number"],
                ["Opening Time", "opening_time", "text"],
                ["Closing Time", "closing_time", "text"],
                ["Total Hours", "total_hours", "number"],
                ["Parking", "parking", "number"],
                ["Tolls", "tolls", "number"],
                ["Days (outstation)", "days", "number"],
              ].map(([label, key, type]) => (
                <div key={key as string}>
                  <Label className="text-xs">{label}</Label>
                  <Input
                    type={type as string}
                    value={editing[key as string] ?? ""}
                    onChange={(e) => {
                      const k = key as string;
                      const v = e.target.value;
                      const next: any = { ...editing, [k]: v };
                      // Auto-calc Total KM from Opening/Closing KM
                      if (k === "opening_km" || k === "closing_km") {
                        const ok = Number(k === "opening_km" ? v : next.opening_km);
                        const ck = Number(k === "closing_km" ? v : next.closing_km);
                        if (Number.isFinite(ok) && Number.isFinite(ck) && ck >= ok) {
                          next.total_km = ck - ok;
                        }
                      }
                      // Auto-calc Total Hours from Opening/Closing Time
                      if (k === "opening_time" || k === "closing_time") {
                        const ot = k === "opening_time" ? v : next.opening_time;
                        const ct = k === "closing_time" ? v : next.closing_time;
                        if (ot && ct) {
                          const h = parseTimeToHours(String(ot), String(ct));
                          if (h > 0) next.total_hours = h;
                        }
                      }
                      setEditing(next);
                    }}
                  />
                </div>
              ))}
              <div className="sm:col-span-2">
                <Label className="text-xs">Notes</Label>
                <Input
                  value={editing.notes ?? ""}
                  onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                />
              </div>
              <div className="sm:col-span-2">
                <Label className="text-xs">Package</Label>
                <select
                  className="mt-1 w-full h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                  value={editing.package_id ?? ""}
                  onChange={(e) => setEditing({ ...editing, package_id: e.target.value || null })}
                >
                  <option value="">— None —</option>
                  {(editRateCards?.length ?? 0) > 0 && (
                    <optgroup label={editingDeptId ? "Department Rate Cards" : "Institution Rate Cards"}>
                      {(editRateCards ?? []).map((r: any) => (
                        <option key={r.id} value={r.id}>
                          {r.vehicle_name} · {r.package_type} ({r.included_km}km/{r.included_hours}hr)
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {(packages?.length ?? 0) > 0 && (
                    <optgroup label="Global Packages">
                      {(packages ?? []).map((p: any) => (
                        <option key={p.id} value={p.id}>
                          {p.vehicle_name} · {p.package_type} ({p.included_km}km/{p.included_hours}hr)
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Pick from this trip's department/institution rate card or a global package. Bill totals recalculate next time you generate a bill.
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={saveTrip.isPending}>Cancel</Button>
            <Button
              onClick={() => saveTrip.mutate(editing)}
              disabled={saveTrip.isPending}
              className="bg-gold text-primary-foreground hover:opacity-90 glow-gold"
            >
              {saveTrip.isPending ? "Saving…" : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}