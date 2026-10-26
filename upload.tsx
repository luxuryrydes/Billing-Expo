import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import imageCompression from "browser-image-compression";
import { useServerFn } from "@tanstack/react-start";
import { extractDutySlip } from "@/lib/ocr.functions";
import { supabase } from "@/integrations/supabase/db";
import { computeTrip, gstFromRateCard, type Pkg, type GstSetting } from "@/lib/billing";
import { createInvoiceFromTrips } from "@/lib/invoice";
import { mirrorBase64ToDrive, resolveInstitutionName } from "@/lib/drive-mirror";
import { PageHeader } from "@/components/app/PageHeader";
import { DataCard } from "@/components/app/DataCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Upload as UploadIcon, Sparkles, Search, Check, ChevronsUpDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/upload")({ component: UploadPage });

const fields = [
  ["duty_date","Duty Date"],["car_number","Car Number"],["vehicle_type","Vehicle Type"],
  ["driver_name","Driver"],["guest_name","Guest"],
  ["opening_km","Opening KM"],["closing_km","Closing KM"],["total_km","Total KM"],
  ["opening_time","Opening Time"],["closing_time","Closing Time"],["total_hours","Total Hours"],
  ["parking","Parking"],["tolls","Tolls"],
];

const VEHICLE_TYPES = ["Innova", "Dzire", "Ciaz"];

function UploadPage() {
  const ocr = useServerFn(extractDutySlip);
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Record<string, any>>({});
  const [preview, setPreview] = useState<string | null>(null);
  const [slipId, setSlipId] = useState<string | null>(null);
  const [slipPath, setSlipPath] = useState<string | null>(null);
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [institutionId, setInstitutionId] = useState<string | null>(null);
  const [customFieldVals, setCustomFieldVals] = useState<Record<string, string>>({});
  const [deptSearch, setDeptSearch] = useState("");
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [companyOpen, setCompanyOpen] = useState(false);
  const [packageId, setPackageId] = useState<string | null>(null);
  const [packageOpen, setPackageOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const processingRef = useRef(false);

  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: async () => (await supabase.from("departments").select("*").order("name")).data ?? [],
  });

  const institutions = useQuery({
    queryKey: ["institutions"],
    queryFn: async () => (await supabase.from("institutions" as any).select("*").order("name")).data ?? [],
  });

  const selectedInstitution = (institutions.data ?? []).find((i: any) => i.id === institutionId);
  const instCustomFields: { key: string; label: string; source: string }[] = (selectedInstitution as any)?.custom_fields ?? [];

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

  const visibleDepartments = useMemo(() => {
    const all = (departments.data ?? []) as any[];
    const q = deptSearch.trim().toLowerCase();
    if (!q) {
      const selected = all.find((d) => d.id === departmentId);
      const top = all.slice(0, 4);
      if (selected && !top.some((d) => d.id === selected.id)) {
        return [selected, ...top].slice(0, 4);
      }
      return top;
    }
    return all.filter((d) =>
      [d.name, d.invoice_prefix, d.header_title, ...((d.aliases as string[]) ?? [])]
        .filter(Boolean)
        .some((v: string) => String(v).toLowerCase().includes(q)),
    );
  }, [departments.data, deptSearch, departmentId]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    // Hard guard against duplicate / recursive invocations
    if (processingRef.current || busy) return;
    processingRef.current = true;
    setBusy(true);
    try {
      // Compress images before sending to OCR (skip for PDFs)
      let fileToSend: Blob = f;
      if (f.type.startsWith("image/")) {
        try {
          fileToSend = await imageCompression(f, {
            maxSizeMB: 1.5,
            maxWidthOrHeight: 2000,
            useWebWorker: true,
          });
        } catch {
          fileToSend = f;
        }
      }
      const url = URL.createObjectURL(fileToSend);
      setPreview(url);
      const buf = await fileToSend.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as any);
      }
      const b64 = btoa(binary);
      const { extracted, error } = await ocr({ data: {
        image_base64: b64,
        mime: fileToSend.type || f.type || "image/jpeg",
        extra_fields: instCustomFields.map((f) => ({ key: f.key, label: f.label })),
      } });
      if (error) {
        toast.error(error);
      }
      // Pre-fill any institution custom_fields the OCR returned
      if (instCustomFields.length && extracted) {
        const next: Record<string, string> = {};
        for (const cf of instCustomFields) {
          const v = (extracted as any)[cf.key] ?? (extracted as any)[cf.label] ?? "";
          if (v) next[cf.key] = String(v);
        }
        setCustomFieldVals((prev) => ({ ...prev, ...next }));
      }
      // Upload original file to storage and create a duty_slips record so it can be viewed later from the invoice
      try {
        const { data: { user } } = await supabase.auth.getUser();
        const ext = (f.name.split(".").pop() || "bin").toLowerCase();
        const path = `${user?.id ?? "anon"}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const { error: upErr } = await supabase.storage.from("duty-slips").upload(path, f, {
          contentType: f.type || "application/octet-stream",
          upsert: false,
        });
        if (upErr) throw upErr;
        // Fire-and-forget: mirror duty slip to Google Drive
        try {
          const instName = await resolveInstitutionName(institutionId);
          const dutyDate = (extracted?.dutyDate ?? extracted?.duty_date ?? null) as string | null;
          mirrorBase64ToDrive({
            type: "Duty-Slips",
            institution: instName,
            date: dutyDate,
            fileName: `${Date.now()}-${f.name}`,
            mimeType: f.type || "application/octet-stream",
            base64: b64,
          });
        } catch (e) { console.warn("Slip Drive mirror failed", e); }
        const { data: slipRow, error: slipErr } = await supabase.from("duty_slips").insert({
          file_path: path,
          file_type: f.type || null,
          uploaded_by: user?.id ?? null,
          ocr_raw: extracted ?? null,
          status: "uploaded",
        }).select("id, file_path").single();
        if (slipErr) throw slipErr;
        setSlipId(slipRow.id);
        setSlipPath(slipRow.file_path);
      } catch (e: any) {
        toast.error("Slip upload failed: " + (e.message || ""));
      }
      // One-time form population — no effects watching this state
      const openKm = extracted?.openingKM ?? extracted?.opening_km ?? "";
      const closeKm = extracted?.closingKM ?? extracted?.closing_km ?? "";
      const openT = extracted?.openingTime ?? extracted?.opening_time ?? "";
      const closeT = extracted?.closingTime ?? extracted?.closing_time ?? "";
      let totalKm = extracted?.totalKM ?? extracted?.total_km ?? "";
      let totalHours = extracted?.totalHours ?? extracted?.total_hours ?? "";
      const computedKm = computeTotalKm(openKm, closeKm);
      if ((totalKm === "" || totalKm == null) && computedKm != null) totalKm = computedKm;
      const computedHrs = computeTotalHours(openT, closeT);
      if ((totalHours === "" || totalHours == null) && computedHrs != null) totalHours = computedHrs;
      setForm({
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
      });
      toast.success("Slip data extracted");
    } catch (err: any) {
      toast.error(err.message || "OCR failed");
    } finally {
      setBusy(false);
      processingRef.current = false;
      // Allow re-uploading the same file later
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function save() {
    setBusy(true);
    const { data: inserted, error } = await supabase.from("trips").insert({
      duty_date: form.duty_date || null,
      car_number: form.car_number || null,
      vehicle_type: form.vehicle_type || null,
      driver_name: form.driver_name || null,
      guest_name: form.guest_name || null,
      company_name: form.company_name || null,
      company_id: companyId,
      opening_km: num(form.opening_km),
      closing_km: num(form.closing_km),
      total_km: num(form.total_km),
      opening_time: form.opening_time || null,
      closing_time: form.closing_time || null,
      total_hours: num(form.total_hours),
      parking: num(form.parking),
      tolls: num(form.tolls),
      duty_slip_id: slipId,
      department_id: departmentId,
      package_id: packageId,
      institution_id: institutionId,
      custom_fields: customFieldVals,
    }).select("*").single();
    if (error) { setBusy(false); return toast.error(error.message); }

    // Auto-bill: if a rate-card package was selected, compute totals,
    // update the trip with the calculation, then create an invoice and
    // mark the trip as Invoiced so it appears in the Invoiced column.
    try {
      const rc = (rateCards.data ?? []).find((r: any) => r.id === packageId);
      if (rc && inserted) {
        const pricing: Pkg = {
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
        };
        // Resolve GST: rate card tax → department default → first GST setting → none
        let gst: GstSetting | null = gstFromRateCard(rc);
        if (!gst && departmentId) {
          const { data: dept } = await supabase.from("departments").select("default_gst_setting_id").eq("id", departmentId).single();
          const gstId = (dept as any)?.default_gst_setting_id;
          if (gstId) {
            const { data: g } = await supabase.from("gst_settings").select("*").eq("id", gstId).single();
            gst = (g as any) ?? null;
          }
        }
        if (!gst) {
          const { data: g } = await supabase.from("gst_settings").select("*").eq("is_default", true).maybeSingle();
          gst = (g as any) ?? null;
        }
        const calc = computeTrip({
          total_km: Number(inserted.total_km || 0),
          total_hours: Number(inserted.total_hours || 0),
          parking: Number(inserted.parking || 0),
          tolls: Number(inserted.tolls || 0),
          duty_date: (inserted as any).duty_date || null,
          closing_date: (inserted as any).closing_date || null,
          opening_time: (inserted as any).opening_time || null,
          closing_time: (inserted as any).closing_time || null,
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
        }).eq("id", inserted.id);
        const inv = await createInvoiceFromTrips({
          tripIds: [inserted.id],
          type: "single",
          departmentId,
          institutionId,
        });
        toast.success(`Trip saved & invoice ${inv.invoice_no} generated`);
        setBusy(false);
        setForm({}); setPreview(null); setSlipId(null); setSlipPath(null); setDepartmentId(null); setCompanyId(null); setPackageId(null); setInstitutionId(null); setCustomFieldVals({});
        nav({ to: "/invoices" });
        return;
      }
    } catch (e: any) {
      toast.error("Auto-invoice failed: " + (e.message || ""));
    }
    setBusy(false);
    toast.success("Trip saved");
    setForm({}); setPreview(null); setSlipId(null); setSlipPath(null); setDepartmentId(null); setCompanyId(null); setPackageId(null); setInstitutionId(null); setCustomFieldVals({});
  }

  return (
    <div>
      <PageHeader title="Upload Duty Slip" description="AI extracts trip details from images or PDFs." />
      <DataCard className="mb-6">
        <Label className="font-display text-lg text-gold">Select Department</Label>
        <p className="text-xs text-muted-foreground mt-1 mb-3">Pick the department this duty slip belongs to. Invoice header, GST and rates will follow this choice.</p>
        <div className="relative mb-3 max-w-sm">
          <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={deptSearch}
            onChange={(e) => setDeptSearch(e.target.value)}
            placeholder={`Search ${(departments.data ?? []).length} departments…`}
            className="pl-8"
          />
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {visibleDepartments.map((d: any) => {
            const active = departmentId === d.id;
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => setDepartmentId(active ? null : d.id)}
                className={`text-left rounded-md border p-3 transition ${active ? "border-gold bg-gold/10 glow-gold" : "border-border hover:border-gold/60"}`}
              >
                <div className="font-medium">{d.name}</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {d.invoice_prefix ? `Prefix: ${d.invoice_prefix}` : "No prefix"}
                  {d.header_title ? ` · ${d.header_title}` : ""}
                </div>
              </button>
            );
          })}
          {(departments.data ?? []).length === 0 && (
            <div className="text-sm text-muted-foreground">No departments yet — add some in Departments.</div>
          )}
          {(departments.data ?? []).length > 0 && visibleDepartments.length === 0 && (
            <div className="text-sm text-muted-foreground sm:col-span-2 lg:col-span-3">No departments match “{deptSearch}”.</div>
          )}
        </div>
        {!deptSearch && (departments.data ?? []).length > 4 && (
          <p className="text-xs text-muted-foreground mt-2">Showing 4 of {(departments.data ?? []).length}. Use search to find others.</p>
        )}
      </DataCard>
      {(institutions.data ?? []).length > 0 && (
        <DataCard className="mb-6">
          <Label className="font-display text-lg text-gold">Institution template (optional)</Label>
          <p className="text-xs text-muted-foreground mt-1 mb-3">Pick an institution (CRRI, SAIL, RBI, ISRO, …) to apply its custom fields and bill format.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => { setInstitutionId(null); setCustomFieldVals({}); }} className={`rounded-md border px-3 py-2 text-sm ${!institutionId ? "border-gold bg-gold/10" : "border-border hover:border-gold/60"}`}>None</button>
            {(institutions.data ?? []).map((i: any) => (
              <button key={i.id} type="button" onClick={() => setInstitutionId(i.id)} className={`rounded-md border px-3 py-2 text-sm ${institutionId === i.id ? "border-gold bg-gold/10 glow-gold" : "border-border hover:border-gold/60"}`}>
                <span className="uppercase text-xs text-gold mr-1">{i.code}</span>{i.name}
              </button>
            ))}
          </div>
          {institutionId && instCustomFields.length > 0 && (
            <div className="mt-4 grid sm:grid-cols-2 gap-3">
              {instCustomFields.map((cf) => (
                <div key={cf.key}>
                  <Label className="text-xs">{cf.label}</Label>
                  <Input value={customFieldVals[cf.key] ?? ""} onChange={(e) => setCustomFieldVals((s) => ({ ...s, [cf.key]: e.target.value }))} placeholder={cf.source === "ocr" ? "Auto-filled from slip when possible" : ""} />
                </div>
              ))}
            </div>
          )}
        </DataCard>
      )}
      <div className="grid lg:grid-cols-2 gap-6">
        <DataCard>
          <Label className="font-display text-lg text-gold flex items-center gap-2"><UploadIcon className="h-4 w-4" /> Slip file</Label>
          <Input ref={inputRef} type="file" accept="image/*,application/pdf" onChange={onFile} className="mt-3" disabled={busy} />
          {preview && <img src={preview} alt="Slip preview" className="mt-4 rounded-md border hairline max-h-80 object-contain w-full bg-black/30" />}
          {busy && <div className="mt-3 text-gold text-sm flex items-center gap-2"><Sparkles className="h-4 w-4 animate-pulse" /> AI processing…</div>}
        </DataCard>
        <DataCard>
          <h3 className="font-display text-lg text-gold mb-3">Extracted details</h3>
          <div className="grid grid-cols-2 gap-3">
            {fields.map(([k, lbl]) => (
              <div key={k}>
                <Label className="text-xs">{lbl}</Label>
                {k === "vehicle_type" ? (
                  <select
                    className="w-full bg-background border rounded-md px-3 py-2 text-sm h-10"
                    value={form[k] ?? ""}
                    onChange={(e) => setForm((s) => ({ ...s, [k]: e.target.value }))}
                  >
                    <option value="">Select vehicle type…</option>
                    {VEHICLE_TYPES.map((v) => <option key={v} value={v}>{v}</option>)}
                    {form[k] && !VEHICLE_TYPES.includes(form[k]) && (
                      <option value={form[k]}>{form[k]}</option>
                    )}
                  </select>
                ) : (
                <Input
                  value={form[k] ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    setForm((s) => {
                      const next = { ...s, [k]: v };
                      if (k === "opening_km" || k === "closing_km") {
                        const tk = computeTotalKm(next.opening_km, next.closing_km);
                        if (tk != null) next.total_km = tk;
                      }
                      if (k === "opening_time" || k === "closing_time") {
                        const th = computeTotalHours(next.opening_time, next.closing_time);
                        if (th != null) next.total_hours = th;
                      }
                      return next;
                    });
                  }}
                />
                )}
              </div>
            ))}
            <div className="col-span-2">
              <Label className="text-xs">Company</Label>
              <Popover open={companyOpen} onOpenChange={setCompanyOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    role="combobox"
                    className="w-full justify-between font-normal"
                  >
                    <span className={cn("truncate", !companyId && !form.company_name && "text-muted-foreground")}>
                      {companyId
                        ? (companies.data ?? []).find((c: any) => c.id === companyId)?.name
                        : form.company_name || "Search & select company…"}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search company…" />
                    <CommandList>
                      <CommandEmpty>No company found.</CommandEmpty>
                      <CommandGroup>
                        {(companies.data ?? []).map((c: any) => (
                          <CommandItem
                            key={c.id}
                            value={c.name}
                            onSelect={() => {
                              setCompanyId(c.id);
                              setForm((s) => ({ ...s, company_name: c.name }));
                              setCompanyOpen(false);
                            }}
                          >
                            <Check className={cn("mr-2 h-4 w-4", companyId === c.id ? "opacity-100" : "opacity-0")} />
                            {c.name}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
            <div className="col-span-2">
              <Label className="text-xs">Package {institutionId ? "(from selected institution)" : "(from selected department)"}</Label>
              <Popover open={packageOpen} onOpenChange={setPackageOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    role="combobox"
                    disabled={!departmentId && !institutionId}
                    className="w-full justify-between font-normal"
                  >
                    <span className={cn("truncate", !packageId && "text-muted-foreground")}>
                      {packageId
                        ? (() => {
                            const rc = (rateCards.data ?? []).find((r: any) => r.id === packageId);
                            return rc ? `${rc.vehicle_name} · ${rc.package_type} · ₹${rc.base_fare}` : "Select package…";
                          })()
                        : (departmentId || institutionId) ? "Search & select package…" : "Select a department or institution first"}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search vehicle or package…" />
                    <CommandList>
                      <CommandEmpty>No rate card found. Add one in {institutionId ? "Institutions" : "Departments"}.</CommandEmpty>
                      <CommandGroup>
                        {(rateCards.data ?? []).map((rc: any) => (
                          <CommandItem
                            key={rc.id}
                            value={`${rc.vehicle_name} ${rc.package_type}`}
                            onSelect={() => {
                              setPackageId(rc.id);
                              setPackageOpen(false);
                            }}
                          >
                            <Check className={cn("mr-2 h-4 w-4", packageId === rc.id ? "opacity-100" : "opacity-0")} />
                            <div className="flex flex-col">
                              <span className="font-medium">{rc.vehicle_name} · {rc.package_type}</span>
                              <span className="text-xs text-muted-foreground">
                                ₹{rc.base_fare} base · {rc.included_km}km / {rc.included_hours}hr · ₹{rc.extra_km_rate}/km · ₹{rc.extra_hour_rate}/hr
                              </span>
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
          </div>
          <Button onClick={save} disabled={busy} className="w-full mt-5 bg-gold text-primary-foreground hover:opacity-90 glow-gold">
            Save Trip
          </Button>
        </DataCard>
      </div>
    </div>
  );
}

function num(v: any) {
  if (v === "" || v == null) return null;
  const n = Number(String(v).replace(/[^\d.\-]/g, ""));
  return isNaN(n) ? null : n;
}

function computeTotalKm(open: any, close: any): number | null {
  const o = num(open), c = num(close);
  if (o == null || c == null) return null;
  const diff = c - o;
  return diff >= 0 ? diff : null;
}

function parseTimeToMinutes(t: any): number | null {
  if (!t) return null;
  const s = String(t).trim();
  // Accept "23:00", "10:30 pm", "10.30pm", "10 pm", "10pm", "2 am", "2"
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

function computeTotalHours(open: any, close: any): number | null {
  const o = parseTimeToMinutes(open), c = parseTimeToMinutes(close);
  if (o == null || c == null) return null;
  let diff = c - o;
  if (diff < 0) diff += 24 * 60; // overnight
  return Math.round((diff / 60) * 100) / 100;
}
