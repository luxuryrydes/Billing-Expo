import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/db";
import { PageHeader } from "@/components/app/PageHeader";
import { DataCard } from "@/components/app/DataCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { Pencil, Plus, Trash2, Sparkles, Landmark, Tag, X, Download } from "lucide-react";
import { exportRowsToXlsx } from "@/lib/excel";

export const Route = createFileRoute("/_app/institutions")({ component: Page });

type CustomField = { key: string; label: string; required: boolean; source: "ocr" | "manual" };
type ShowCols = { vehicle_no: boolean; vehicle_type: boolean; user_name: boolean; division: boolean; project_code: boolean; scheme_no: boolean; non_taxable: boolean; taxable: boolean };

type Inst = {
  id?: string;
  code: string;
  name: string;
  header_title: string | null;
  header_subtitle: string | null;
  vendor_sac: string | null;
  vendor_pan: string | null;
  vendor_gstin: string | null;
  client_address: string | null;
  client_address2: string | null;
  client_gstin: string | null;
  invoice_prefix: string | null;
  custom_fields: CustomField[];
  show_columns: ShowCols;
  gst_mode: "include" | "show_separate" | "rcm_note";
  cgst_pct: number;
  sgst_pct: number;
  igst_pct: number;
  gst_pct: number;
  terms: string | null;
  notes: string | null;
};

function empty(): Inst {
  return {
    code: "custom", name: "", header_title: null, header_subtitle: null,
    vendor_sac: "996601", vendor_pan: null, vendor_gstin: null,
    client_address: null, client_address2: null, client_gstin: null,
    invoice_prefix: null,
    custom_fields: [],
    show_columns: { vehicle_no: true, vehicle_type: true, user_name: false, division: false, project_code: false, scheme_no: false, non_taxable: false, taxable: true },
    gst_mode: "include", cgst_pct: 2.5, sgst_pct: 2.5, igst_pct: 0, gst_pct: 0,
    terms: null, notes: null,
  };
}

function Page() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Inst | null>(null);
  const [open, setOpen] = useState(false);
  const [rateOpen, setRateOpen] = useState(false);
  const [rateInst, setRateInst] = useState<Inst | null>(null);

  const insts = useQuery({
    queryKey: ["institutions"],
    queryFn: async () => {
      const { data, error } = await supabase.from("institutions" as any).select("*").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const save = useMutation({
    mutationFn: async (i: Inst) => {
      const payload: any = { ...i };
      if (i.id) {
        const { error } = await supabase.from("institutions" as any).update(payload).eq("id", i.id);
        if (error) throw error;
      } else {
        delete payload.id;
        const { error } = await supabase.from("institutions" as any).insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => { toast.success("Saved"); setOpen(false); setEditing(null); qc.invalidateQueries({ queryKey: ["institutions"] }); },
    onError: (e: any) => toast.error(e.message),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("institutions" as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Deleted"); qc.invalidateQueries({ queryKey: ["institutions"] }); },
    onError: (e: any) => toast.error(e.message),
  });

  const seed = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("seed_default_institutions" as any);
      if (error) throw error;
      return data as number;
    },
    onSuccess: (n) => { toast.success(`Loaded ${n} default templates`); qc.invalidateQueries({ queryKey: ["institutions"] }); },
    onError: (e: any) => toast.error(e.message),
  });

  const startEdit = (row?: any) => { setEditing(row ? normalize(row) : empty()); setOpen(true); };

  return (
    <div>
      <PageHeader
        title="Institutions"
        description="Per-institution invoice templates: custom fields, columns and GST display (ISRO, CRRI, RBI, SAIL, or your own)."
        action={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                exportRowsToXlsx(
                  "institutions",
                  (insts.data ?? []).map((r: any) => {
                    const n = normalize(r);
                    return {
                      Code: n.code,
                      Name: n.name,
                      "Header Title": n.header_title || "",
                      "Header Subtitle": n.header_subtitle || "",
                      "Invoice Prefix": n.invoice_prefix || "",
                      "GST Mode": n.gst_mode,
                      "CGST %": n.cgst_pct,
                      "SGST %": n.sgst_pct,
                      "IGST %": n.igst_pct,
                      "Vendor SAC": n.vendor_sac || "",
                      "Vendor GSTIN": n.vendor_gstin || "",
                      "Client Address": n.client_address || "",
                      "Client GSTIN": n.client_gstin || "",
                      "Custom Fields": n.custom_fields.map((f) => f.label).join(", "),
                      Terms: n.terms || "",
                      Notes: n.notes || "",
                    };
                  }),
                )
              }
              disabled={!insts.data?.length}
            >
              <Download className="h-4 w-4 mr-1" /> Export
            </Button>
            <Button variant="outline" size="sm" onClick={() => seed.mutate()} disabled={seed.isPending}>
              <Sparkles className="h-4 w-4 mr-1" /> Load default templates
            </Button>
            <Button size="sm" onClick={() => startEdit()}>
              <Plus className="h-4 w-4 mr-1" /> New institution
            </Button>
          </div>
        }
      />
      <DataCard>
        {insts.isLoading ? (
          <div className="text-muted-foreground text-sm">Loading…</div>
        ) : (insts.data ?? []).length === 0 ? (
          <div className="text-sm text-muted-foreground py-8 text-center">
            No institutions yet. Click <b>Load default templates</b> to add CRRI, SAIL, RBI and ISRO.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground border-b">
                  <th className="py-2 pr-4">Code</th>
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">GST mode</th>
                  <th className="py-2 pr-4">Custom fields</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {(insts.data ?? []).map((r: any) => (
                  <tr key={r.id} className="border-b border-border/40 hover:bg-muted/20">
                    <td className="py-2 pr-4 uppercase text-xs">{r.code}</td>
                    <td className="py-2 pr-4 font-medium">
                      <div className="flex items-center gap-2"><Landmark className="h-4 w-4 text-gold" />{r.name}</div>
                      <div className="text-xs text-muted-foreground">{r.header_title}</div>
                    </td>
                    <td className="py-2 pr-4 text-xs">
                      {r.gst_mode === "include" && "Included in total"}
                      {r.gst_mode === "show_separate" && "Shown separately (not in total)"}
                      {r.gst_mode === "rcm_note" && "GST Under RCM (note only)"}
                    </td>
                    <td className="py-2 pr-4 text-xs">
                      {((r.custom_fields ?? []) as CustomField[]).map(f => f.label).join(", ") || "—"}
                    </td>
                    <td className="py-2 text-right">
                      <Button size="icon" variant="ghost" aria-label="Rate card" title="Rate Card" onClick={() => { setRateInst(normalize(r)); setRateOpen(true); }}><Tag className="h-4 w-4" /></Button>
                      <Button size="icon" variant="ghost" aria-label="Edit institution" onClick={() => startEdit(r)}><Pencil className="h-4 w-4" /></Button>
                      <Button size="icon" variant="ghost" aria-label="Delete institution" className="text-destructive" onClick={() => { if (confirm("Delete institution?")) del.mutate(r.id); }}><Trash2 className="h-4 w-4" /></Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DataCard>

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setEditing(null); }}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="text-gold">{editing?.id ? "Edit" : "New"} institution</DialogTitle></DialogHeader>
          {editing && (
            <div className="space-y-5">
              <div className="grid sm:grid-cols-2 gap-3">
                <Field label="Code (preset)">
                  <Select value={editing.code} onValueChange={(v) => setEditing({ ...editing, code: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="custom">Custom</SelectItem>
                      <SelectItem value="crri">CRRI</SelectItem>
                      <SelectItem value="sail">SAIL</SelectItem>
                      <SelectItem value="rbi">RBI</SelectItem>
                      <SelectItem value="isro">ISRO / DOS</SelectItem>
                      <SelectItem value="ntpc">NTPC</SelectItem>
                      <SelectItem value="cbi">CBI</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Display name *"><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
                <Field label="Header title (large)"><Input value={editing.header_title ?? ""} onChange={(e) => setEditing({ ...editing, header_title: e.target.value })} /></Field>
                <Field label="Header subtitle"><Input value={editing.header_subtitle ?? ""} onChange={(e) => setEditing({ ...editing, header_subtitle: e.target.value })} /></Field>
                <Field label="Invoice prefix"><Input value={editing.invoice_prefix ?? ""} onChange={(e) => setEditing({ ...editing, invoice_prefix: e.target.value })} /></Field>
              </div>

              <Section title="Vendor (your firm)">
                <div className="grid sm:grid-cols-3 gap-3">
                  <Field label="SAC"><Input value={editing.vendor_sac ?? ""} onChange={(e) => setEditing({ ...editing, vendor_sac: e.target.value })} /></Field>
                  <Field label="PAN"><Input value={editing.vendor_pan ?? ""} onChange={(e) => setEditing({ ...editing, vendor_pan: e.target.value })} /></Field>
                  <Field label="GSTIN"><Input value={editing.vendor_gstin ?? ""} onChange={(e) => setEditing({ ...editing, vendor_gstin: e.target.value })} /></Field>
                </div>
              </Section>

              <Section title="Client (institution)">
                <Field label="Address"><Input value={editing.client_address ?? ""} onChange={(e) => setEditing({ ...editing, client_address: e.target.value })} /></Field>
                <Field label="Address line 2"><Input value={editing.client_address2 ?? ""} onChange={(e) => setEditing({ ...editing, client_address2: e.target.value })} /></Field>
                <Field label="Client GSTIN"><Input value={editing.client_gstin ?? ""} onChange={(e) => setEditing({ ...editing, client_gstin: e.target.value })} /></Field>
              </Section>

              <Section title="GST behaviour">
                <Select value={editing.gst_mode} onValueChange={(v: any) => setEditing({ ...editing, gst_mode: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="include">Included in total (default)</SelectItem>
                    <SelectItem value="show_separate">Shown separately, NOT added to total (SAIL style)</SelectItem>
                    <SelectItem value="rcm_note">Print "GST Under RCM (Invoice)" — no GST amount</SelectItem>
                  </SelectContent>
                </Select>
                {editing.gst_mode !== "rcm_note" && (
                  <div className="grid grid-cols-4 gap-3 mt-3">
                    <Field label="CGST %"><Input type="number" value={editing.cgst_pct} onChange={(e) => setEditing({ ...editing, cgst_pct: Number(e.target.value || 0) })} /></Field>
                    <Field label="SGST %"><Input type="number" value={editing.sgst_pct} onChange={(e) => setEditing({ ...editing, sgst_pct: Number(e.target.value || 0) })} /></Field>
                    <Field label="IGST %"><Input type="number" value={editing.igst_pct} onChange={(e) => setEditing({ ...editing, igst_pct: Number(e.target.value || 0) })} /></Field>
                    <Field label="GST %"><Input type="number" value={editing.gst_pct} onChange={(e) => setEditing({ ...editing, gst_pct: Number(e.target.value || 0) })} /></Field>
                  </div>
                )}
              </Section>

              <Section title="Columns to show on the bill">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {(["vehicle_no","vehicle_type","user_name","division","project_code","scheme_no","non_taxable","taxable"] as const).map((k) => (
                    <label key={k} className="flex items-center gap-2 text-sm">
                      <Checkbox checked={editing.show_columns[k]} onCheckedChange={(v) => setEditing({ ...editing, show_columns: { ...editing.show_columns, [k]: !!v } })} />
                      {k.replace(/_/g, " ")}
                    </label>
                  ))}
                </div>
              </Section>

              <Section title="Custom fields (extracted from duty slip / manual)">
                <p className="text-xs text-muted-foreground mb-2">e.g. Division, Scheme No, Project Code, User Name. OCR will try to read these from the slip; you can override on the trip.</p>
                <div className="space-y-2">
                  {editing.custom_fields.map((f, i) => (
                    <div key={i} className="grid grid-cols-12 gap-2 items-center">
                      <Input className="col-span-3" placeholder="key" value={f.key} onChange={(e) => updateField(editing, setEditing, i, { key: e.target.value })} />
                      <Input className="col-span-4" placeholder="label" value={f.label} onChange={(e) => updateField(editing, setEditing, i, { label: e.target.value })} />
                      <Select value={f.source} onValueChange={(v: any) => updateField(editing, setEditing, i, { source: v })}>
                        <SelectTrigger className="col-span-3"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ocr">OCR + manual</SelectItem>
                          <SelectItem value="manual">Manual only</SelectItem>
                        </SelectContent>
                      </Select>
                      <label className="col-span-1 flex items-center gap-1 text-xs">
                        <Checkbox checked={f.required} onCheckedChange={(v) => updateField(editing, setEditing, i, { required: !!v })} /> req
                      </label>
                      <Button className="col-span-1" size="icon" variant="ghost" aria-label="Remove custom field" onClick={() => setEditing({ ...editing, custom_fields: editing.custom_fields.filter((_, j) => j !== i) })}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                  <Button size="sm" variant="outline" onClick={() => setEditing({ ...editing, custom_fields: [...editing.custom_fields, { key: "", label: "", required: false, source: "ocr" }] })}>
                    <Plus className="h-4 w-4 mr-1" /> Add field
                  </Button>
                </div>
              </Section>

              <Field label="Terms"><Textarea value={editing.terms ?? ""} onChange={(e) => setEditing({ ...editing, terms: e.target.value })} /></Field>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => editing && save.mutate(editing)} disabled={save.isPending || !editing?.name}>{save.isPending ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RateCardDialog open={rateOpen} onOpenChange={setRateOpen} inst={rateInst} />
    </div>
  );
}

function normalize(r: any): Inst {
  return {
    ...r,
    custom_fields: Array.isArray(r.custom_fields) ? r.custom_fields : [],
    show_columns: { vehicle_no: true, vehicle_type: true, user_name: false, division: false, project_code: false, scheme_no: false, non_taxable: false, taxable: true, ...(r.show_columns ?? {}) },
    cgst_pct: Number(r.cgst_pct || 0), sgst_pct: Number(r.sgst_pct || 0),
    igst_pct: Number(r.igst_pct || 0), gst_pct: Number(r.gst_pct || 0),
  };
}

function updateField(e: Inst, set: (v: Inst) => void, i: number, patch: Partial<CustomField>) {
  const next = [...e.custom_fields];
  next[i] = { ...next[i], ...patch };
  set({ ...e, custom_fields: next });
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><Label className="text-xs">{label}</Label><div className="mt-1">{children}</div></div>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="rounded-md border p-3"><div className="text-xs font-medium text-gold mb-2 uppercase tracking-wide">{title}</div>{children}</div>;
}

type RateCard = {
  id?: string;
  institution_id: string;
  vehicle_name: string;
  package_type: string;
  base_fare: number;
  included_km: number;
  included_hours: number;
  extra_km_rate: number;
  extra_hour_rate: number;
  night_charge?: number;
  driver_allowance?: number;
  night_start_time?: string | null;
  night_end_time?: string | null;
  tax_mode?: string;
  gst_pct?: number;
  cgst_pct?: number;
  sgst_pct?: number;
  igst_pct?: number;
  is_fixed_price?: boolean;
};

function RateCardDialog({ open, onOpenChange, inst }: { open: boolean; onOpenChange: (v: boolean) => void; inst: Inst | null }) {
  const qc = useQueryClient();
  const emptyDraft: RateCard = { institution_id: "", vehicle_name: "", package_type: "", base_fare: 0, included_km: 0, included_hours: 0, extra_km_rate: 0, extra_hour_rate: 0, night_charge: 0, driver_allowance: 0, night_start_time: "", night_end_time: "", tax_mode: "none", gst_pct: 0, cgst_pct: 0, sgst_pct: 0, igst_pct: 0, is_fixed_price: false };
  const [draft, setDraft] = useState<RateCard>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);

  const cards = useQuery({
    queryKey: ["inst-rate-cards", inst?.id],
    enabled: !!inst?.id && open,
    queryFn: async () => {
      const { data } = await supabase.from("department_rate_cards" as any).select("*").eq("institution_id", inst!.id!).order("vehicle_name");
      return ((data ?? []) as unknown) as RateCard[];
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!inst?.id) throw new Error("No institution");
      if (!draft.vehicle_name || !draft.package_type) throw new Error("Vehicle + package required");
      const payload: any = {
        institution_id: inst.id,
        department_id: null,
        vehicle_name: draft.vehicle_name,
        package_type: draft.package_type,
        base_fare: Number(draft.base_fare || 0),
        night_charge: Number(draft.night_charge || 0),
        driver_allowance: Number(draft.driver_allowance || 0),
        night_start_time: draft.night_start_time || null,
        night_end_time: draft.night_end_time || null,
        tax_mode: draft.tax_mode || "none",
        gst_pct: Number(draft.gst_pct || 0),
        cgst_pct: Number(draft.cgst_pct || 0),
        sgst_pct: Number(draft.sgst_pct || 0),
        igst_pct: Number(draft.igst_pct || 0),
        is_fixed_price: !!draft.is_fixed_price,
        included_km: draft.is_fixed_price ? 0 : Number(draft.included_km || 0),
        included_hours: draft.is_fixed_price ? 0 : Number(draft.included_hours || 0),
        extra_km_rate: draft.is_fixed_price ? 0 : Number(draft.extra_km_rate || 0),
        extra_hour_rate: draft.is_fixed_price ? 0 : Number(draft.extra_hour_rate || 0),
      };
      if (editingId) {
        const { error } = await supabase.from("department_rate_cards" as any).update(payload).eq("id", editingId);
        if (error) throw error;
      } else {
        const insertPayload = { ...payload, upgrade_enabled: false, upgrade_base_fare: 0, upgrade_included_km: 0, upgrade_included_hours: 0, upgrade_extra_km_rate: 0, upgrade_extra_hour_rate: 0 };
        const { error } = await supabase.from("department_rate_cards" as any).insert(insertPayload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(editingId ? "Rate updated" : "Rate added");
      setDraft(emptyDraft);
      setEditingId(null);
      qc.invalidateQueries({ queryKey: ["inst-rate-cards", inst?.id] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("department_rate_cards" as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Removed"); qc.invalidateQueries({ queryKey: ["inst-rate-cards", inst?.id] }); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle className="text-gold">Rate Card — {inst?.name}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vehicle</TableHead>
                <TableHead>Package</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Base ₹</TableHead>
                <TableHead>Inc. Km</TableHead>
                <TableHead>Inc. Hrs</TableHead>
                <TableHead>Extra/Km</TableHead>
                <TableHead>Extra/Hr</TableHead>
                <TableHead>Night ₹</TableHead>
                <TableHead>Night Slot</TableHead>
                <TableHead>Driver Allow ₹/day</TableHead>
                <TableHead>Tax</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(cards.data ?? []).map((c) => (
                <TableRow key={c.id}>
                  <TableCell>{c.vehicle_name}</TableCell>
                  <TableCell>{c.package_type}</TableCell>
                  <TableCell className="text-xs">{c.is_fixed_price ? <span className="text-gold">Fixed price</span> : "Per km/hr"}</TableCell>
                  <TableCell>{c.base_fare}</TableCell>
                  <TableCell>{c.included_km}</TableCell>
                  <TableCell>{c.included_hours}</TableCell>
                  <TableCell>{c.extra_km_rate}</TableCell>
                  <TableCell>{c.extra_hour_rate}</TableCell>
                  <TableCell>{c.night_charge ?? 0}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{c.night_start_time && c.night_end_time ? `${c.night_start_time}–${c.night_end_time}` : "—"}</TableCell>
                  <TableCell>{c.driver_allowance ?? 0}</TableCell>
                  <TableCell className="text-xs">
                    {(() => {
                      const m = c.tax_mode || "none";
                      if (m === "none") return "—";
                      if (m === "gst") return `GST ${c.gst_pct ?? 0}%`;
                      if (m === "igst") return `IGST ${c.igst_pct ?? 0}%`;
                      if (m === "split") return `C ${c.cgst_pct ?? 0}% + S ${c.sgst_pct ?? 0}%`;
                      return m;
                    })()}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button size="icon" variant="ghost" aria-label="Edit rate card row" onClick={() => { if (!c.id) return; setEditingId(c.id); setDraft({ institution_id: inst?.id ?? "", vehicle_name: c.vehicle_name, package_type: c.package_type, base_fare: c.base_fare, included_km: c.included_km, included_hours: c.included_hours, extra_km_rate: c.extra_km_rate, extra_hour_rate: c.extra_hour_rate, night_charge: c.night_charge ?? 0, driver_allowance: c.driver_allowance ?? 0, night_start_time: c.night_start_time ?? "", night_end_time: c.night_end_time ?? "", tax_mode: c.tax_mode ?? "none", gst_pct: c.gst_pct ?? 0, cgst_pct: c.cgst_pct ?? 0, sgst_pct: c.sgst_pct ?? 0, igst_pct: c.igst_pct ?? 0, is_fixed_price: !!c.is_fixed_price }); }}><Pencil className="h-4 w-4" /></Button>
                      <Button size="icon" variant="ghost" aria-label="Delete rate card row" onClick={() => c.id && remove.mutate(c.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {cards.data?.length === 0 && <TableRow><TableCell colSpan={13} className="text-center text-muted-foreground py-6">No rate overrides yet</TableCell></TableRow>}
            </TableBody>
          </Table>

          <div className="border-t pt-3">
            <div className="text-sm font-medium mb-2 flex items-center justify-between">
              <span>{editingId ? "Edit rate" : "Add rate"}</span>
              {editingId && (
                <Button size="sm" variant="ghost" onClick={() => { setEditingId(null); setDraft(emptyDraft); }}>
                  <X className="h-4 w-4 mr-1" /> Cancel edit
                </Button>
              )}
            </div>
            <label className="flex items-center gap-2 text-xs mb-2 cursor-pointer">
              <input
                type="checkbox"
                checked={!!draft.is_fixed_price}
                onChange={(e) => setDraft({ ...draft, is_fixed_price: e.target.checked })}
              />
              <span>
                <span className="font-medium text-gold">Fixed price package</span>
                {" "}— e.g. Airport Pickup/Drop. Bills the base fare only; per-km / per-hour extras and night charges are ignored. Parking, tolls and taxes are still added to the invoice.
              </span>
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Input placeholder="Vehicle (Crysta)" value={draft.vehicle_name} onChange={(e) => setDraft({ ...draft, vehicle_name: e.target.value })} />
              <Input placeholder={draft.is_fixed_price ? "Package (Airport Drop)" : "Package (8hr/80km)"} value={draft.package_type} onChange={(e) => setDraft({ ...draft, package_type: e.target.value })} />
              <Input type="number" placeholder={draft.is_fixed_price ? "Fixed price ₹" : "Base fare"} value={draft.base_fare || ""} onChange={(e) => setDraft({ ...draft, base_fare: Number(e.target.value || 0) })} />
              <Input type="number" placeholder="Inc. km" value={draft.included_km || ""} disabled={!!draft.is_fixed_price} onChange={(e) => setDraft({ ...draft, included_km: Number(e.target.value || 0) })} />
              <Input type="number" placeholder="Inc. hrs" value={draft.included_hours || ""} disabled={!!draft.is_fixed_price} onChange={(e) => setDraft({ ...draft, included_hours: Number(e.target.value || 0) })} />
              <Input type="number" placeholder="Extra/km" value={draft.extra_km_rate || ""} disabled={!!draft.is_fixed_price} onChange={(e) => setDraft({ ...draft, extra_km_rate: Number(e.target.value || 0) })} />
              <Input type="number" placeholder="Extra/hr" value={draft.extra_hour_rate || ""} disabled={!!draft.is_fixed_price} onChange={(e) => setDraft({ ...draft, extra_hour_rate: Number(e.target.value || 0) })} />
              <Button onClick={() => save.mutate()} disabled={save.isPending} className="bg-gold text-primary-foreground hover:opacity-90"><Plus className="h-4 w-4 mr-1" /> {editingId ? "Update" : "Add"}</Button>
            </div>
            <div className="mt-3">
              <div className="text-xs font-medium mb-1 text-gold">Night charge (optional)</div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div>
                  <Label className="text-xs">Night charge ₹ (per trip)</Label>
                  <Input type="number" placeholder="e.g. 300" value={draft.night_charge || ""} onChange={(e) => setDraft({ ...draft, night_charge: Number(e.target.value || 0) })} />
                </div>
                <div>
                  <Label className="text-xs">Night starts at</Label>
                  <Input type="time" value={draft.night_start_time ?? ""} onChange={(e) => setDraft({ ...draft, night_start_time: e.target.value })} />
                </div>
                <div>
                  <Label className="text-xs">Night ends at</Label>
                  <Input type="time" value={draft.night_end_time ?? ""} onChange={(e) => setDraft({ ...draft, night_end_time: e.target.value })} />
                </div>
              </div>
            </div>
            <div className="mt-3">
              <div className="text-xs font-medium mb-1 text-gold">Driver allowance (optional)</div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div>
                  <Label className="text-xs">Driver allowance ₹ (per day)</Label>
                  <Input type="number" placeholder="e.g. 500" value={draft.driver_allowance || ""} disabled={!!draft.is_fixed_price} onChange={(e) => setDraft({ ...draft, driver_allowance: Number(e.target.value || 0) })} />
                </div>
              </div>
            </div>
            <div className="mt-3">
              <div className="text-xs font-medium mb-1 text-gold">GST / Taxes (optional)</div>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                <div>
                  <Label className="text-xs">Tax mode</Label>
                  <Select value={draft.tax_mode ?? "none"} onValueChange={(v) => setDraft({ ...draft, tax_mode: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No tax</SelectItem>
                      <SelectItem value="gst">Simple GST</SelectItem>
                      <SelectItem value="igst">IGST</SelectItem>
                      <SelectItem value="split">Split (CGST + SGST)</SelectItem>
                      <SelectItem value="rcm">RCM (Print "GST Under RCM (Invoice)" — no GST amount)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {draft.tax_mode && draft.tax_mode !== "none" && draft.tax_mode !== "rcm" && (
                  <>
                    <div>
                      <Label className="text-xs">CGST %</Label>
                      <Input type="number" placeholder="e.g. 2.5" value={draft.cgst_pct || ""} onChange={(e) => setDraft({ ...draft, cgst_pct: Number(e.target.value || 0) })} />
                    </div>
                    <div>
                      <Label className="text-xs">SGST %</Label>
                      <Input type="number" placeholder="e.g. 2.5" value={draft.sgst_pct || ""} onChange={(e) => setDraft({ ...draft, sgst_pct: Number(e.target.value || 0) })} />
                    </div>
                    <div>
                      <Label className="text-xs">IGST %</Label>
                      <Input type="number" placeholder="e.g. 12" value={draft.igst_pct || ""} onChange={(e) => setDraft({ ...draft, igst_pct: Number(e.target.value || 0) })} />
                    </div>
                    <div>
                      <Label className="text-xs">GST %</Label>
                      <Input type="number" placeholder="e.g. 5" value={draft.gst_pct || ""} onChange={(e) => setDraft({ ...draft, gst_pct: Number(e.target.value || 0) })} />
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
        <DialogFooter><Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}