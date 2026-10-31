# Billing query source paths

Paths are relative to the software project root; inside the ZIP the same paths are preserved.

These are existing application client/API queries, not standalone SQL scripts. Line numbers refer to this source snapshot.

## src/lib/bill-template.ts:163–163

```typescript
  if (invoiceIds.length === 0) throw new Error("No invoices selected");
  const { data: invs } = await supabase.from("invoices").select("*").in("id", invoiceIds);
```

## src/lib/bill-template.ts:164–164

```typescript
  const { data: invs } = await supabase.from("invoices").select("*").in("id", invoiceIds);
  const { data: links } = await supabase.from("invoice_trips").select("*").in("invoice_id", invoiceIds);
```

## src/lib/bill-template.ts:165–165

```typescript
  const { data: links } = await supabase.from("invoice_trips").select("*").in("invoice_id", invoiceIds);
  const tripIds = Array.from(new Set((links ?? []).map((l: any) => l.trip_id)));
```

## src/lib/bill-template.ts:167–168

```typescript
  const { data: trips } = tripIds.length
    ? await supabase.from("trips").select("*").in("id", tripIds)
    : { data: [] as any[] };
```

## src/lib/bill-template.ts:176–176

```typescript
  if (deptId) {
    const { data: d } = await supabase.from("departments").select("*").eq("id", deptId).single();
```

## src/lib/bill-template.ts:179–179

```typescript
    if (dept?.default_company_id) {
      const { data: c } = await supabase.from("companies").select("*").eq("id", dept.default_company_id).single();
```

## src/lib/bill-template.ts:182–182

```typescript
    }
    const { data: rc } = await supabase.from("department_rate_cards").select("*").eq("department_id", deptId);
```

## src/lib/bill-template.ts:196–196

```typescript
  }
  const pkgIds = Array.from(new Set((trips ?? []).map((t: any) => t.package_id).filter(Boolean)));
```

## src/lib/bill-template.ts:198–199

```typescript
  const { data: pkgs } = pkgIds.length
    ? await supabase.from("packages").select("*").in("id", pkgIds)
    : { data: [] as any[] };
```

## src/lib/bill-template.ts:207–209

```typescript
    const { data: rcRows } = await supabase
      .from("department_rate_cards")
      .select("*")
      .in("id", missingIds);
```

## src/lib/bill-template.ts:246–247

```typescript
      const { data: allInsts } = await supabase
        .from("institutions" as any)
        .select("id, invoice_prefix");
```

## src/lib/bill-template.ts:256–256

```typescript
  if (instId) {
    const { data: rc } = await supabase.from("department_rate_cards").select("*").eq("institution_id", instId);
```

## src/lib/bill-template.ts:454–454

```typescript
  if (instId) {
    const { data: inst } = await supabase.from("institutions" as any).select("*").eq("id", instId).single();
```

## src/lib/bill-template.ts:462–462

```typescript
    for (const cf of institution.custom_fields as any[]) {
      const vals = Array.from(new Set((allTrips as any[]).map((t) => (t.custom_fields ?? {})[cf.key]).filter(Boolean))) as string[];
```

## src/lib/bill-template.ts:475–477

```typescript
  if (gstMode === "include") {
    const gstIds = Array.from(
      new Set((invs ?? []).map((i: any) => i.gst_setting_id).filter(Boolean)),
    );
```

## src/lib/bill-template.ts:480–482

```typescript
      const { data: gsRows } = await supabase
        .from("gst_settings" as any)
        .select("id, mode")
        .in("id", gstIds);
```

## src/lib/bill-template.ts:737–737

```typescript
    const uniq = (arr: string[]) =>
      Array.from(new Set(arr.map((v) => v.trim()).filter(Boolean)));
```

## src/lib/invoice.ts:40–40

```typescript

  const { data: trips, error } = await supabase.from("trips").select("*").in("id", tripIds);
```

## src/lib/invoice.ts:45–45

```typescript
  // Validate same company for merged/single
  const companies = Array.from(new Set(trips.map((t: any) => t.company_id || t.company_name || "—")));
```

## src/lib/invoice.ts:68–68

```typescript
  if (!resolvedDeptId) {
    const depts = Array.from(new Set((trips as any[]).map((t) => t.department_id).filter(Boolean)));
```

## src/lib/invoice.ts:74–74

```typescript
  if (!resolvedInstId) {
    const ids = Array.from(new Set((trips as any[]).map((t) => t.institution_id).filter(Boolean)));
```

## src/lib/invoice.ts:98–98

```typescript

  const { data: inv, error: e2 } = await supabase.from("invoices").insert(payload).select("*").single();
```

## src/lib/invoice.ts:102–102

```typescript
  const links = tripIds.map((tid) => ({ invoice_id: inv.id, trip_id: tid }));
  const { error: e3 } = await supabase.from("invoice_trips").insert(links);
```

## src/lib/invoice.ts:105–105

```typescript

  await supabase.from("trips").update({ invoiced: true }).in("id", tripIds);
```

## src/lib/invoice.ts:131–131

```typescript
export async function fetchInvoiceWithTrips(invoiceId: string) {
  const { data: inv, error } = await supabase.from("invoices").select("*").eq("id", invoiceId).single();
```

## src/lib/invoice.ts:133–133

```typescript
  if (error) throw error;
  const { data: links } = await supabase.from("invoice_trips").select("trip_id").eq("invoice_id", invoiceId);
```

## src/lib/invoice.ts:136–137

```typescript
  const { data: trips } = tripIds.length
    ? await supabase.from("trips").select("*").in("id", tripIds)
    : { data: [] as any[] };
```

## src/lib/invoice.ts:171–171

```typescript
  const { invoice, trips } = await fetchInvoiceWithTrips(invoiceId);
  const pkgIds = Array.from(new Set((trips as any[]).map((t) => t.package_id).filter(Boolean)));
```

## src/lib/invoice.ts:174–174

```typescript
  if (pkgIds.length) {
    const { data: pkgs } = await supabase.from("packages").select("*").in("id", pkgIds);
```

## src/lib/invoice.ts:205–205

```typescript
  // Pull all invoices + trips
  const { data: invs } = await supabase.from("invoices").select("*").in("id", invoiceIds);
```

## src/lib/invoice.ts:206–206

```typescript
  const { data: invs } = await supabase.from("invoices").select("*").in("id", invoiceIds);
  const { data: links } = await supabase.from("invoice_trips").select("*").in("invoice_id", invoiceIds);
```

## src/lib/invoice.ts:207–207

```typescript
  const { data: links } = await supabase.from("invoice_trips").select("*").in("invoice_id", invoiceIds);
  const tripIds = Array.from(new Set((links ?? []).map((l: any) => l.trip_id)));
```

## src/lib/invoice.ts:209–210

```typescript
  const { data: trips } = tripIds.length
    ? await supabase.from("trips").select("*").in("id", tripIds)
    : { data: [] as any[] };
```

## src/lib/invoice.ts:211–211

```typescript
    : { data: [] as any[] };
  const pkgIds = Array.from(new Set((trips ?? []).map((t: any) => t.package_id).filter(Boolean)));
```

## src/lib/invoice.ts:213–214

```typescript
  const { data: pkgs } = pkgIds.length
    ? await supabase.from("packages").select("*").in("id", pkgIds)
    : { data: [] as any[] };
```

## src/lib/supa-fetch-all.ts:16–16

```typescript
  for (let i = 0; i < 100; i++) {
    const q = build(supabase.from(table as any)).range(from, from + pageSize - 1);
```

## src/routes/_app/invoices.tsx:59–59

```typescript
    try {
      const ids = Array.from(selected);
```

## src/routes/_app/invoices.tsx:105–109

```typescript
      const { data, error } = await supabase
        .from("invoices")
        .select("*")
        .is("deleted_at", null)
        .neq("type", "single")
        .order("created_at", { ascending: false });
```

## src/routes/_app/invoices.tsx:120–120

```typescript
      const ids = (data ?? []).map((i: any) => i.id);
      const { data: links } = await supabase.from("invoice_trips").select("invoice_id, trip_id").in("invoice_id", ids);
```

## src/routes/_app/invoices.tsx:121–121

```typescript
      const { data: links } = await supabase.from("invoice_trips").select("invoice_id, trip_id").in("invoice_id", ids);
      const tripIds = Array.from(new Set((links ?? []).map((l: any) => l.trip_id)));
```

## src/routes/_app/invoices.tsx:123–124

```typescript
      const { data: trips } = tripIds.length
        ? await supabase.from("trips").select("id, duty_date, guest_name, duty_slip_id").in("id", tripIds)
        : { data: [] as any[] };
```

## src/routes/_app/invoices.tsx:144–146

```typescript
    queryFn: async () => {
      const slipIds = Array.from(new Set(
        Object.values(tripMap ?? {}).flat().map((t: any) => t.duty_slip_id).filter(Boolean)
      )) as string[];
```

## src/routes/_app/invoices.tsx:148–148

```typescript
      if (!slipIds.length) return {} as Record<string, string[]>;
      const { data: slips } = await supabase.from("duty_slips").select("id, file_path").in("id", slipIds);
```

## src/routes/_app/invoices.tsx:164–164

```typescript
    for (const p of paths) {
      const { data, error } = await supabase.storage.from("duty-slips").createSignedUrl(p, 3600);
```

## src/routes/_app/invoices.tsx:179–179

```typescript

  const availableYears = Array.from(new Set((data ?? []).map((r: any) => invoiceMonthYear(r)?.y).filter(Boolean) as number[])).sort((a, b) => b - a);
```

## src/routes/_app/invoices.tsx:224–224

```typescript
    mutationFn: async () => {
      const ids = Array.from(selected);
```

## src/routes/_app/invoices.tsx:240–240

```typescript
    mutationFn: async (id: string) => {
      await supabase.from("invoices").update({ deleted_at: new Date().toISOString() }).eq("id", id);
```

## src/routes/_app/invoices.tsx:248–248

```typescript
    mutationFn: async (ids: string[]) => {
      const { error } = await supabase.from("invoices").update({ deleted_at: new Date().toISOString() }).in("id", ids);
```

## src/routes/_app/invoices.tsx:272–272

```typescript
              onClick={() => {
                const ids = Array.from(selected);
```

## src/routes/_app/invoices.tsx:379–379

```typescript
                      {(() => {
                        const guests = Array.from(new Set((tripMap?.[inv.id] ?? []).map((t: any) => t.guest_name).filter(Boolean)));
```

## src/routes/_app/trips.tsx:69–69

```typescript
    queryFn: async () => {
      const { data, error } = await supabase.from("trips").select("*").is("deleted_at", null).order("duty_date", { ascending: false });
```

## src/routes/_app/trips.tsx:89–89

```typescript
    queryFn: async () => {
      const { data, error } = await supabase.from("packages").select("*").eq("active", true).order("vehicle_name");
```

## src/routes/_app/trips.tsx:98–98

```typescript
    queryFn: async () => {
      const { data, error } = await supabase.from("department_rate_cards").select("id, vehicle_name, package_type, included_km, included_hours");
```

## src/routes/_app/trips.tsx:112–112

```typescript
    queryFn: async () => {
      let q = supabase.from("department_rate_cards").select("*").order("vehicle_name");
```

## src/routes/_app/trips.tsx:136–136

```typescript
    queryFn: async () => {
      const { data, error } = await supabase.from("gst_settings").select("*").order("name");
```

## src/routes/_app/trips.tsx:144–146

```typescript
  const slipIds = useMemo(
    () => Array.from(new Set(((data ?? []) as any[]).map((t) => t.duty_slip_id).filter(Boolean))) as string[],
    [data],
  );
```

## src/routes/_app/trips.tsx:152–154

```typescript
      const { data: slips } = await supabase
        .from("duty_slips")
        .select("id, file_path, file_type")
        .in("id", slipIds);
```

## src/routes/_app/trips.tsx:158–159

```typescript
        const { data: signed } = await supabase.storage
          .from("duty-slips")
          .createSignedUrl(s.file_path, 3600);
```

## src/routes/_app/trips.tsx:173–173

```typescript
    const rows = (data ?? []).filter((t: any) => selected.has(t.id)) as any[];
    const ids = Array.from(new Set(rows.map((t) => t.department_id).filter(Boolean)));
```

## src/routes/_app/trips.tsx:179–179

```typescript
    const rows = (data ?? []).filter((t: any) => selected.has(t.id)) as any[];
    const ids = Array.from(new Set(rows.map((t) => t.institution_id).filter(Boolean)));
```

## src/routes/_app/trips.tsx:188–190

```typescript
      let q = supabase
        .from("department_rate_cards")
        .select("*")
        .order("vehicle_name");
```

## src/routes/_app/trips.tsx:202–202

```typescript
    queryFn: async () => {
      const { data } = await supabase.from("departments").select("*").eq("id", selectedDeptId as string).single();
```

## src/routes/_app/trips.tsx:317–317

```typescript
    }
    return Array.from(ys).sort((a, b) => b - a);
```

## src/routes/_app/trips.tsx:325–325

```typescript
    }
    return Array.from(cs).sort((a, b) => a.localeCompare(b));
```

## src/routes/_app/trips.tsx:382–382

```typescript
    // using each trip's own package + GST.
    const ids = Array.from(selected);
```

## src/routes/_app/trips.tsx:411–411

```typescript
    mutationFn: async (type: "single" | "merged" | "monthly") => {
      const ids = Array.from(selected);
```

## src/routes/_app/trips.tsx:413–413

```typescript
      const tripRows = (data ?? []).filter((t: any) => ids.includes(t.id)) as any[];
      const pkgIds = Array.from(new Set(tripRows.map((t: any) => t.package_id).filter(Boolean))) as string[];
```

## src/routes/_app/trips.tsx:417–419

```typescript
        const [{ data: pkgRows }, { data: rcRows }] = await Promise.all([
          supabase.from("packages").select("*").in("id", pkgIds),
          supabase.from("department_rate_cards").select("*").in("id", pkgIds),
        ]);
```

## src/routes/_app/trips.tsx:418–419

```typescript
          supabase.from("packages").select("*").in("id", pkgIds),
          supabase.from("department_rate_cards").select("*").in("id", pkgIds),
        ]);
```

## src/routes/_app/trips.tsx:439–449

```typescript
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
```

## src/routes/_app/trips.tsx:482–482

```typescript
    mutationFn: async () => {
      const ids = Array.from(selected);
```

## src/routes/_app/trips.tsx:509–522

```typescript
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
```

## src/routes/_app/trips.tsx:581–581

```typescript
    if (!pricing) return 0;
    const ids = Array.from(selected);
```

## src/routes/_app/trips.tsx:608–608

```typescript
  const selectedTripsInfo = useMemo(() => {
    const ids = Array.from(selected);
```

## src/routes/_app/trips.tsx:611–611

```typescript
    const isMultiDay = rows.some((t) => Number(t.days || 1) > 1);
    const vehicles = Array.from(new Set(rows.map((t) => String(t.vehicle_type || "").toLowerCase()).filter(Boolean)));
```

## src/routes/_app/trips.tsx:730–730

```typescript
      };
      const { error } = await supabase.from("trips").update(payload).eq("id", t.id);
```

## src/routes/_app/trips.tsx:744–746

```typescript
      const { error } = await supabase
        .from("trips")
        .update({ deleted_at: new Date().toISOString() })
        .in("id", ids);
```

## src/routes/_app/trips.tsx:779–792

```typescript
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
```

## src/routes/_app/trips.tsx:805–818

```typescript
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
```

## src/routes/_app/upload.tsx:56–57

```typescript
    queryKey: ["departments"],
    queryFn: async () => (await supabase.from("departments").select("*").order("name")).data ?? [],
  });
```

## src/routes/_app/upload.tsx:61–62

```typescript
    queryKey: ["institutions"],
    queryFn: async () => (await supabase.from("institutions" as any).select("*").order("name")).data ?? [],
  });
```

## src/routes/_app/upload.tsx:69–70

```typescript
    queryKey: ["companies"],
    queryFn: async () => (await supabase.from("companies").select("id, name").order("name")).data ?? [],
  });
```

## src/routes/_app/upload.tsx:76–76

```typescript
    queryFn: async () => {
      let q = supabase.from("department_rate_cards").select("*").order("vehicle_name");
```

## src/routes/_app/upload.tsx:129–129

```typescript
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as any);
```

## src/routes/_app/upload.tsx:154–157

```typescript
        const path = `${user?.id ?? "anon"}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const { error: upErr } = await supabase.storage.from("duty-slips").upload(path, f, {
          contentType: f.type || "application/octet-stream",
          upsert: false,
        });
```

## src/routes/_app/upload.tsx:172–178

```typescript
        } catch (e) { console.warn("Slip Drive mirror failed", e); }
        const { data: slipRow, error: slipErr } = await supabase.from("duty_slips").insert({
          file_path: path,
          file_type: f.type || null,
          uploaded_by: user?.id ?? null,
          ocr_raw: extracted ?? null,
          status: "uploaded",
        }).select("id, file_path").single();
```

## src/routes/_app/upload.tsx:225–238

```typescript
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
```

## src/routes/_app/upload.tsx:276–276

```typescript
        if (!gst && departmentId) {
          const { data: dept } = await supabase.from("departments").select("default_gst_setting_id").eq("id", departmentId).single();
```

## src/routes/_app/upload.tsx:279–279

```typescript
          if (gstId) {
            const { data: g } = await supabase.from("gst_settings").select("*").eq("id", gstId).single();
```

## src/routes/_app/upload.tsx:284–284

```typescript
        if (!gst) {
          const { data: g } = await supabase.from("gst_settings").select("*").eq("is_default", true).maybeSingle();
```

## src/routes/_app/upload.tsx:298–308

```typescript
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
```

## src/routes/_app/upload-bulk.tsx:95–96

```typescript
    queryKey: ["departments"],
    queryFn: async () => (await supabase.from("departments").select("*").order("name")).data ?? [],
  });
```

## src/routes/_app/upload-bulk.tsx:99–100

```typescript
    queryKey: ["institutions"],
    queryFn: async () => (await supabase.from("institutions" as any).select("*").order("name")).data ?? [],
  });
```

## src/routes/_app/upload-bulk.tsx:103–104

```typescript
    queryKey: ["companies"],
    queryFn: async () => (await supabase.from("companies").select("id, name").order("name")).data ?? [],
  });
```

## src/routes/_app/upload-bulk.tsx:109–109

```typescript
    queryFn: async () => {
      let q = supabase.from("department_rate_cards").select("*").order("vehicle_name");
```

## src/routes/_app/upload-bulk.tsx:234–237

```typescript
          const path = `${user?.id ?? "anon"}/${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 8)}.jpg`;
          const { error: upErr } = await supabase.storage.from("duty-slips").upload(path, item.blob, {
            contentType: "image/jpeg",
            upsert: false,
          });
```

## src/routes/_app/upload-bulk.tsx:258–264

```typescript

          const { data: slipRow, error: slipErr } = await supabase.from("duty_slips").insert({
            file_path: path,
            file_type: "image/jpeg",
            uploaded_by: user?.id ?? null,
            ocr_raw: extracted ?? null,
            status: "uploaded",
          }).select("id").single();
```

## src/routes/_app/upload-bulk.tsx:299–301

```typescript

      const workers = Array.from({ length: concurrency }, async () => {
        while (cursor < pageImages.length) {
          const i = cursor++;
```

## src/routes/_app/upload-bulk.tsx:317–317

```typescript
  async function onImages(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/"));
```

## src/routes/_app/upload-bulk.tsx:353–356

```typescript
          const path = `${user?.id ?? "anon"}/${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 8)}.jpg`;
          const { error: upErr } = await supabase.storage.from("duty-slips").upload(path, item.blob, {
            contentType: "image/jpeg",
            upsert: false,
          });
```

## src/routes/_app/upload-bulk.tsx:376–382

```typescript

          const { data: slipRow, error: slipErr } = await supabase.from("duty_slips").insert({
            file_path: path,
            file_type: "image/jpeg",
            uploaded_by: user?.id ?? null,
            ocr_raw: extracted ?? null,
            status: "uploaded",
          }).select("id").single();
```

## src/routes/_app/upload-bulk.tsx:417–419

```typescript

      const workers = Array.from({ length: concurrency }, async () => {
        while (cursor < pageImages.length) {
          const i = cursor++;
```

## src/routes/_app/upload-bulk.tsx:584–585

```typescript
    const { data: vendorRows } = await supabase
      .from("vehicle_vendors")
      .select("cab_no, full_cab_no, vendor_name");
```

## src/routes/_app/upload-bulk.tsx:687–687

```typescript
      if (departmentId) {
        const { data: dept } = await supabase.from("departments").select("default_gst_setting_id").eq("id", departmentId).single();
```

## src/routes/_app/upload-bulk.tsx:690–690

```typescript
        if (gstId) {
          const { data: g } = await supabase.from("gst_settings").select("*").eq("id", gstId).single();
```

## src/routes/_app/upload-bulk.tsx:695–695

```typescript
      if (!fallbackGst) {
        const { data: g } = await supabase.from("gst_settings").select("*").eq("is_default", true).maybeSingle();
```

## src/routes/_app/upload-bulk.tsx:734–734

```typescript
        };
        const { data: trip, error } = await supabase.from("trips").insert(insertPayload).select("*").single();
```

## src/routes/_app/upload-bulk.tsx:753–763

```typescript
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
```

## src/routes/_app/upload-bulk.tsx:1309–1309

```typescript
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as any);
```

## src/routes/_app/departments.tsx:75–75

```typescript
    queryFn: async () => {
      const { data, error } = await supabase.from("departments").select("*").order("name");
```

## src/routes/_app/departments.tsx:83–83

```typescript
    queryFn: async () => {
      const { data } = await supabase.from("packages").select("id,vehicle_name,package_type").eq("active", true).order("vehicle_name");
```

## src/routes/_app/departments.tsx:90–90

```typescript
    queryFn: async () => {
      const { data } = await supabase.from("gst_settings").select("id,name,mode").order("name");
```

## src/routes/_app/departments.tsx:97–97

```typescript
    queryFn: async () => {
      const { data } = await supabase.from("companies").select("id,name").order("name");
```

## src/routes/_app/departments.tsx:125–125

```typescript
      if (d.id) {
        const { error } = await supabase.from("departments").update(payload).eq("id", d.id);
```

## src/routes/_app/departments.tsx:128–128

```typescript
      } else {
        const { error } = await supabase.from("departments").insert(payload);
```

## src/routes/_app/departments.tsx:138–138

```typescript
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("departments").delete().eq("id", id);
```

## src/routes/_app/departments.tsx:361–361

```typescript
    queryFn: async () => {
      const { data } = await supabase.from("department_rate_cards").select("*").eq("department_id", dept!.id!).order("vehicle_name");
```

## src/routes/_app/departments.tsx:398–398

```typescript
        const { id, ...rest } = payload;
        const { error } = await supabase.from("department_rate_cards").update(rest).eq("id", editingId);
```

## src/routes/_app/departments.tsx:401–401

```typescript
      } else {
        const { error } = await supabase.from("department_rate_cards").insert(payload);
```

## src/routes/_app/departments.tsx:416–416

```typescript
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("department_rate_cards").delete().eq("id", id);
```

## src/routes/_app/institutions.tsx:71–71

```typescript
    queryFn: async () => {
      const { data, error } = await supabase.from("institutions" as any).select("*").order("name");
```

## src/routes/_app/institutions.tsx:81–81

```typescript
      if (i.id) {
        const { error } = await supabase.from("institutions" as any).update(payload).eq("id", i.id);
```

## src/routes/_app/institutions.tsx:85–85

```typescript
        delete payload.id;
        const { error } = await supabase.from("institutions" as any).insert(payload);
```

## src/routes/_app/institutions.tsx:95–95

```typescript
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("institutions" as any).delete().eq("id", id);
```

## src/routes/_app/institutions.tsx:104–104

```typescript
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("seed_default_institutions" as any);
```

## src/routes/_app/institutions.tsx:379–379

```typescript
    queryFn: async () => {
      const { data } = await supabase.from("department_rate_cards" as any).select("*").eq("institution_id", inst!.id!).order("vehicle_name");
```

## src/routes/_app/institutions.tsx:410–410

```typescript
      if (editingId) {
        const { error } = await supabase.from("department_rate_cards" as any).update(payload).eq("id", editingId);
```

## src/routes/_app/institutions.tsx:414–414

```typescript
        const insertPayload = { ...payload, upgrade_enabled: false, upgrade_base_fare: 0, upgrade_included_km: 0, upgrade_included_hours: 0, upgrade_extra_km_rate: 0, upgrade_extra_hour_rate: 0 };
        const { error } = await supabase.from("department_rate_cards" as any).insert(insertPayload);
```

## src/routes/_app/institutions.tsx:429–429

```typescript
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("department_rate_cards" as any).delete().eq("id", id);
```

## src/routes/_app/recycle-bin.tsx:22–25

```typescript
      const { data, error } = await supabase
        .from("trips")
        .select("*")
        .not("deleted_at", "is", null)
        .order("deleted_at", { ascending: false });
```

## src/routes/_app/recycle-bin.tsx:35–38

```typescript
      const { data, error } = await supabase
        .from("invoices")
        .select("*")
        .not("deleted_at", "is", null)
        .order("deleted_at", { ascending: false });
```

## src/routes/_app/recycle-bin.tsx:46–46

```typescript
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("trips").update({ deleted_at: null }).eq("id", id);
```

## src/routes/_app/recycle-bin.tsx:59–59

```typescript
    mutationFn: async (id: string) => {
      await supabase.from("invoice_trips").delete().eq("trip_id", id);
```

## src/routes/_app/recycle-bin.tsx:60–60

```typescript
      await supabase.from("invoice_trips").delete().eq("trip_id", id);
      const { error } = await supabase.from("trips").delete().eq("id", id);
```

## src/routes/_app/recycle-bin.tsx:72–72

```typescript
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("invoices").update({ deleted_at: null }).eq("id", id);
```

## src/routes/_app/recycle-bin.tsx:85–85

```typescript
    mutationFn: async (id: string) => {
      const { data: links } = await supabase.from("invoice_trips").select("trip_id").eq("invoice_id", id);
```

## src/routes/_app/recycle-bin.tsx:87–87

```typescript
      const tripIds = (links ?? []).map((l: any) => l.trip_id);
      await supabase.from("invoice_trips").delete().eq("invoice_id", id);
```

## src/routes/_app/recycle-bin.tsx:88–88

```typescript
      await supabase.from("invoice_trips").delete().eq("invoice_id", id);
      const { error } = await supabase.from("invoices").delete().eq("id", id);
```

## src/routes/_app/recycle-bin.tsx:91–91

```typescript
      if (tripIds.length) {
        await supabase.from("trips").update({ invoiced: false }).in("id", tripIds);
```

## src/routes/api/public/merge.commit.ts:43–47

```typescript
  const { data } = await supabaseAdmin
    .from("invoices")
    .select("invoice_no")
    .ilike("invoice_no", `${yearPrefix}%`)
    .order("invoice_no", { ascending: false })
    .limit(1);
```

## src/routes/api/public/merge.commit.ts:63–63

```typescript
          const { supabase, userId } = await requireBearerUser(request);
          const { data: owner, error: oErr } = await supabase.rpc("current_owner");
```

## src/routes/api/public/merge.commit.ts:92–96

```typescript
          const { data: pkgRow } = await supabaseAdmin
            .from("packages")
            .select("*")
            .eq("id", id)
            .eq("owner_id", ownerId)
            .maybeSingle();
```

## src/routes/api/public/merge.commit.ts:102–106

```typescript
          const { data: rcRow } = await supabaseAdmin
            .from("department_rate_cards")
            .select("*")
            .eq("id", id)
            .eq("owner_id", ownerId)
            .maybeSingle();
```

## src/routes/api/public/merge.commit.ts:120–124

```typescript
          const { data: dRow } = await supabaseAdmin
            .from("departments")
            .select("*")
            .eq("id", departmentId)
            .eq("owner_id", ownerId)
            .maybeSingle();
```

## src/routes/api/public/merge.commit.ts:131–135

```typescript
          const { data: cRow } = await supabaseAdmin
            .from("companies")
            .select("id")
            .eq("id", companyId)
            .eq("owner_id", ownerId)
            .maybeSingle();
```

## src/routes/api/public/merge.commit.ts:142–146

```typescript
          const { data: g } = await supabaseAdmin
            .from("gst_settings")
            .select("*")
            .eq("id", gstSettingId)
            .eq("owner_id", ownerId)
            .maybeSingle();
```

## src/routes/api/public/merge.commit.ts:151–156

```typescript
          const { data: g } = await supabaseAdmin
            .from("gst_settings")
            .select("*")
            .eq("owner_id", ownerId)
            .eq("is_default", true)
            .limit(1)
            .maybeSingle();
```

## src/routes/api/public/merge.commit.ts:162–174

```typescript
        const { data: batch, error: bErr } = await supabaseAdmin
          .from("merge_batches")
          .insert({
            owner_id: ownerId,
            file_name: fileName,
            department_id: departmentId,
            package_id: packageId,
            gst_setting_id: gstSettingId,
            company_id: companyId,
            status: "committed",
            raw_ai_json: rawAi,
          })
          .select("*")
          .single();
```

## src/routes/api/public/merge.commit.ts:239–241

```typescript
        const { data: inserted, error: iErr } = await supabaseAdmin
          .from("trips")
          .insert(tripRows)
          .select("id");
```

## src/routes/api/public/merge.commit.ts:243–243

```typescript
        if (iErr) {
          await supabaseAdmin.from("merge_batches").delete().eq("id", batch.id);
```

## src/routes/api/public/merge.commit.ts:258–270

```typescript

          const { data: inv, error: invErr } = await supabaseAdmin.from("invoices").insert({
            owner_id: ownerId,
            invoice_no: await genInvoiceNo(dept?.invoice_prefix),
            type: tripIds.length > 1 ? "merged" : "single",
            company_id: companyId,
            company_name: companyName,
            department_id: departmentId,
            subtotal, parking_total, tolls_total, gst_total, grand_total,
            gst_breakup: breakup,
            gst_setting_id: gstSettingId,
            status: "issued",
            notes: dept?.terms || `Auto-generated from merge batch (${fileName})`,
          }).select("*").single();
```

## src/routes/api/public/merge.commit.ts:273–273

```typescript
            invoiceId = inv.id;
            await supabaseAdmin.from("invoice_trips").insert(tripIds.map((tid) => ({ invoice_id: inv.id, trip_id: tid })));
```

## src/routes/api/public/merge.commit.ts:274–274

```typescript
            await supabaseAdmin.from("invoice_trips").insert(tripIds.map((tid) => ({ invoice_id: inv.id, trip_id: tid })));
            await supabaseAdmin.from("trips").update({ invoiced: true }).in("id", tripIds);
```

## src/routes/api/public/merge.commit.ts:278–283

```typescript

        await supabaseAdmin.from("merge_batches").update({
          trip_ids: tripIds,
          invoice_id: invoiceId,
          trips_count: tripIds.length,
          total_amount: totalAmount,
        }).eq("id", batch.id);
```

## src/routes/api/public/merge.rollback.ts:24–27

```typescript
        const { data: batch, error } = await auth.supabase
          .from("merge_batches")
          .select("*")
          .eq("id", batchId)
          .maybeSingle();
```

## src/routes/api/public/merge.rollback.ts:34–34

```typescript
        if (batch.invoice_id) {
          await supabaseAdmin.from("invoice_trips").delete().eq("invoice_id", batch.invoice_id);
```

## src/routes/api/public/merge.rollback.ts:35–35

```typescript
          await supabaseAdmin.from("invoice_trips").delete().eq("invoice_id", batch.invoice_id);
          await supabaseAdmin.from("invoices").delete().eq("id", batch.invoice_id);
```

## src/routes/api/public/merge.rollback.ts:38–38

```typescript
        if (tripIds.length > 0) {
          await supabaseAdmin.from("invoice_trips").delete().in("trip_id", tripIds);
```

## src/routes/api/public/merge.rollback.ts:39–39

```typescript
          await supabaseAdmin.from("invoice_trips").delete().in("trip_id", tripIds);
          await supabaseAdmin.from("trips").delete().in("id", tripIds);
```

## src/routes/api/public/merge.rollback.ts:41–41

```typescript
        }
        await supabaseAdmin.from("merge_batches").update({ status: "rolled_back" }).eq("id", batchId);
```

## src/lib/mcp/tools/list-invoices.ts:18–20

```typescript
    const sb = supabaseForUser(ctx);
    let q = sb.from("invoices").select(
      "id,invoice_no,type,company_name,department_id,subtotal,gst_total,grand_total,status,created_at",
    ).order("created_at", { ascending: false }).limit(limit);
```

## src/lib/mcp/tools/list-trips.ts:19–21

```typescript
    const sb = supabaseForUser(ctx);
    let q = sb.from("trips").select(
      "id,duty_date,car_number,vehicle_type,driver_name,guest_name,company_name,total_km,total_hours,grand_total,invoiced",
    ).order("duty_date", { ascending: false }).limit(limit);
```
