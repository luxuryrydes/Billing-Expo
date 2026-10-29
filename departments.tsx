import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/db";
import { PageHeader } from "@/components/app/PageHeader";
import { DataCard } from "@/components/app/DataCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { Pencil, Plus, Trash2, Building, Tag, Download } from "lucide-react";
import { exportRowsToXlsx } from "@/lib/excel";

export const Route = createFileRoute("/_app/departments")({ component: DepartmentsPage });

type Dept = {
  id?: string;
  name: string;
  aliases: string[];
  default_package_id: string | null;
  default_gst_setting_id: string | null;
  default_company_id: string | null;
  notes: string | null;
  invoice_prefix: string | null;
  terms: string | null;
  header_title: string | null;
  logo_url: string | null;
  vendor_company: string | null;
  vendor_sac: string | null;
  vendor_pan: string | null;
  vendor_gstin: string | null;
  client_address: string | null;
  client_address2: string | null;
  client_gstin: string | null;
  hide_client_gstin?: boolean;
};

function emptyDept(): Dept {
  return { name: "", aliases: [], default_package_id: null, default_gst_setting_id: null, default_company_id: null, notes: null, invoice_prefix: null, terms: null, header_title: null, logo_url: null, vendor_company: null, vendor_sac: null, vendor_pan: null, vendor_gstin: null, client_address: null, client_address2: null, client_gstin: null, hide_client_gstin: false };
}

type RateCard = {
  id?: string;
  department_id: string;
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

function DepartmentsPage() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Dept | null>(null);
  const [open, setOpen] = useState(false);

  const depts = useQuery({
    queryKey: ["departments"],
    queryFn: async () => {
      const { data, error } = await supabase.from("departments").select("*").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
  const packages = useQuery({
    queryKey: ["packages-min"],
    queryFn: async () => {
      const { data } = await supabase.from("packages").select("id,vehicle_name,package_type").eq("active", true).order("vehicle_name");
      return data ?? [];
    },
  });
  const gst = useQuery({
    queryKey: ["gst-min"],
    queryFn: async () => {
      const { data } = await supabase.from("gst_settings").select("id,name,mode").order("name");
      return data ?? [];
    },
  });
  const companies = useQuery({
    queryKey: ["companies-min"],
    queryFn: async () => {
      const { data } = await supabase.from("companies").select("id,name").order("name");
      return data ?? [];
    },
  });

  const save = useMutation({
    mutationFn: async (d: Dept) => {
      const payload: any = {
        name: d.name.trim(),
        aliases: d.aliases,
        default_package_id: d.default_package_id,
        default_gst_setting_id: d.default_gst_setting_id,
        default_company_id: d.default_company_id,
        notes: d.notes,
        invoice_prefix: d.invoice_prefix?.trim() || null,
        terms: d.terms || null,
        header_title: d.header_title?.trim() || null,
        logo_url: d.logo_url?.trim() || null,
        vendor_company: d.vendor_company?.trim() || null,
        vendor_sac: d.vendor_sac?.trim() || null,
        vendor_pan: d.vendor_pan?.trim() || null,
        vendor_gstin: d.vendor_gstin?.trim() || null,
        client_address: d.client_address?.trim() || null,
        client_address2: d.client_address2?.trim() || null,
        client_gstin: d.client_gstin?.trim() || null,
        hide_client_gstin: !!d.hide_client_gstin,
      };
      if (d.id) {
        const { error } = await supabase.from("departments").update(payload).eq("id", d.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("departments").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => { toast.success("Saved"); setOpen(false); setEditing(null); qc.invalidateQueries({ queryKey: ["departments"] }); },
    onError: (e: any) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("departments").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Deleted"); qc.invalidateQueries({ queryKey: ["departments"] }); },
    onError: (e: any) => toast.error(e.message),
  });

  const pkgLabel = (id: string | null) => packages.data?.find((p: any) => p.id === id) ? `${(packages.data?.find((p: any) => p.id === id) as any).vehicle_name} — ${(packages.data?.find((p: any) => p.id === id) as any).package_type}` : "—";
  const gstLabel = (id: string | null) => (gst.data?.find((g: any) => g.id === id) as any)?.name ?? "—";
  const compLabel = (id: string | null) => (companies.data?.find((c: any) => c.id === id) as any)?.name ?? "—";

  const [rateOpen, setRateOpen] = useState(false);
  const [rateDept, setRateDept] = useState<Dept | null>(null);

  return (
    <div>
      <PageHeader
        title="Departments"
        description="Map each department/company to a default package + GST so merged Excel sheets bill automatically."
        action={
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() =>
                exportRowsToXlsx(
                  "departments",
                  (depts.data ?? []).map((d: any) => ({
                    Name: d.name,
                    Aliases: (d.aliases ?? []).join(", "),
                    "Invoice Prefix": d.invoice_prefix || "",
                    "Default Package": d.default_package_id ? pkgLabel(d.default_package_id) : "",
                    GST: gstLabel(d.default_gst_setting_id),
                    Company: compLabel(d.default_company_id),
                    "Client Address": d.client_address || "",
                    "Client GSTIN": d.client_gstin || "",
                    Notes: d.notes || "",
                  })),
                )
              }
              disabled={!depts.data?.length}
            >
              <Download className="h-4 w-4 mr-1" /> Export
            </Button>
            <Button onClick={() => { setEditing(emptyDept()); setOpen(true); }} className="bg-gold text-primary-foreground hover:opacity-90 glow-gold">
              <Plus className="h-4 w-4 mr-1" /> New Department
            </Button>
          </div>
        }
      />
      <DataCard>
        {depts.isLoading ? <div className="p-4 text-muted-foreground text-sm">Loading…</div> : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Default Package</TableHead>
                <TableHead>GST</TableHead>
                <TableHead>Company</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(depts.data ?? []).map((d: any) => (
                <TableRow key={d.id}>
                  <TableCell className="font-medium flex items-center gap-2"><Building className="h-4 w-4 text-gold" /> {d.name}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{d.invoice_prefix || "—"}</TableCell>
                  <TableCell>{pkgLabel(d.default_package_id)}</TableCell>
                  <TableCell>{gstLabel(d.default_gst_setting_id)}</TableCell>
                  <TableCell>{compLabel(d.default_company_id)}</TableCell>
                  <TableCell className="text-right">
                    <Button size="icon" variant="ghost" aria-label="Rate card" title="Rate Card" onClick={() => { setRateDept({ ...d, aliases: d.aliases ?? [] }); setRateOpen(true); }}><Tag className="h-4 w-4" /></Button>
                    <Button size="icon" variant="ghost" aria-label="Edit department" onClick={() => { setEditing({ ...d, aliases: d.aliases ?? [] }); setOpen(true); }}><Pencil className="h-4 w-4" /></Button>
                    <Button size="icon" variant="ghost" aria-label="Delete department" onClick={() => { if (confirm("Delete department?")) remove.mutate(d.id); }}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                  </TableCell>
                </TableRow>
              ))}
              {depts.data?.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">No departments yet</TableCell></TableRow>}
            </TableBody>
          </Table>
        )}
      </DataCard>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editing?.id ? "Edit" : "New"} Department</DialogTitle></DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div><Label>Name *</Label><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></div>
              <div>
                <Label>Aliases (comma separated — used for AI matching)</Label>
                <Input value={editing.aliases.join(", ")} onChange={(e) => setEditing({ ...editing, aliases: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} placeholder="Kinetic, KCPL, Kinetic Communications" />
              </div>
              <div>
                <Label>Invoice Prefix</Label>
                <Input value={editing.invoice_prefix ?? ""} onChange={(e) => setEditing({ ...editing, invoice_prefix: e.target.value })} placeholder="CEMW, DGCA, …" />
              </div>
              <div>
                <Label>Logo URL (optional)</Label>
                <Input value={editing.logo_url ?? ""} onChange={(e) => setEditing({ ...editing, logo_url: e.target.value })} placeholder="https://…" />
              </div>
              <div className="border-t pt-3">
                <div className="text-sm font-semibold mb-2 text-gold">Invoice Header (printed on Word/PDF/Excel)</div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Subject (vendor service line)</Label>
                    <Input value={editing.header_title ?? ""} onChange={(e) => setEditing({ ...editing, header_title: e.target.value })} placeholder="TOTAL TRANSPORT SOLUTION AND CONCEPT" />
                  </div>
                  <div>
                    <Label>Company (printed under Subject)</Label>
                    <Input value={editing.vendor_company ?? ""} onChange={(e) => setEditing({ ...editing, vendor_company: e.target.value })} placeholder="Kinetic Drop" />
                  </div>
                  <div>
                    <Label>SAC Code</Label>
                    <Input value={editing.vendor_sac ?? ""} onChange={(e) => setEditing({ ...editing, vendor_sac: e.target.value })} placeholder="996601" />
                  </div>
                  <div>
                    <Label>PAN No.</Label>
                    <Input value={editing.vendor_pan ?? ""} onChange={(e) => setEditing({ ...editing, vendor_pan: e.target.value })} placeholder="AAGFL5356A" />
                  </div>
                  <div>
                    <Label>Vendor GSTIN</Label>
                    <Input value={editing.vendor_gstin ?? ""} onChange={(e) => setEditing({ ...editing, vendor_gstin: e.target.value })} placeholder="07AAGFL5356A1ZK" />
                  </div>
                  <div>
                    <Label>Client GSTIN</Label>
                    <Input value={editing.client_gstin ?? ""} onChange={(e) => setEditing({ ...editing, client_gstin: e.target.value })} placeholder="07AAACA6412D2Z9" />
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <input
                    id="hide-client-gstin"
                    type="checkbox"
                    className="h-4 w-4"
                    checked={!!editing.hide_client_gstin}
                    onChange={(e) => setEditing({ ...editing, hide_client_gstin: e.target.checked })}
                  />
                  <Label htmlFor="hide-client-gstin" className="cursor-pointer">
                    Hide Client GSTIN on printed bill
                  </Label>
                </div>
                <div className="mt-3">
                  <Label>Client Billing Address</Label>
                  <textarea
                    className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[60px]"
                    value={editing.client_address ?? ""}
                    onChange={(e) => setEditing({ ...editing, client_address: e.target.value })}
                    placeholder="Central E&M Workshop, Safdarjung Airport, New Delhi - 110003"
                  />
                </div>
                <div className="mt-3">
                  <Label>Address Line 2 (optional)</Label>
                  <Input
                    value={editing.client_address2 ?? ""}
                    onChange={(e) => setEditing({ ...editing, client_address2: e.target.value })}
                    placeholder="Second line of client billing address"
                  />
                </div>
              </div>
              <div>
                <Label>Default Package</Label>
                <Select value={editing.default_package_id ?? "__none"} onValueChange={(v) => setEditing({ ...editing, default_package_id: v === "__none" ? null : v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">— none —</SelectItem>
                    {(packages.data ?? []).map((p: any) => <SelectItem key={p.id} value={p.id}>{p.vehicle_name} — {p.package_type}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>GST Setting</Label>
                <Select value={editing.default_gst_setting_id ?? "__none"} onValueChange={(v) => setEditing({ ...editing, default_gst_setting_id: v === "__none" ? null : v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">— default —</SelectItem>
                    {(gst.data ?? []).map((g: any) => <SelectItem key={g.id} value={g.id}>{g.name} ({g.mode})</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Company</Label>
                <Select value={editing.default_company_id ?? "__none"} onValueChange={(v) => setEditing({ ...editing, default_company_id: v === "__none" ? null : v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">— none —</SelectItem>
                    {(companies.data ?? []).map((c: any) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div><Label>Notes</Label><Input value={editing.notes ?? ""} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></div>
              <div>
                <Label>Terms &amp; Conditions (auto-loaded on invoice)</Label>
                <textarea
                  className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[80px]"
                  value={editing.terms ?? ""}
                  onChange={(e) => setEditing({ ...editing, terms: e.target.value })}
                  placeholder="Payment within 30 days. GST extra. …"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!editing?.name || save.isPending} onClick={() => editing && save.mutate(editing)} className="bg-gold text-primary-foreground hover:opacity-90">Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RateCardDialog open={rateOpen} onOpenChange={setRateOpen} dept={rateDept} />
    </div>
  );
}

function RateCardDialog({ open, onOpenChange, dept }: { open: boolean; onOpenChange: (v: boolean) => void; dept: Dept | null }) {
  const qc = useQueryClient();
  const emptyDraft: RateCard = { department_id: "", vehicle_name: "", package_type: "", base_fare: 0, included_km: 0, included_hours: 0, extra_km_rate: 0, extra_hour_rate: 0, night_charge: 0, driver_allowance: 0, night_start_time: "", night_end_time: "", tax_mode: "none", gst_pct: 0, cgst_pct: 0, sgst_pct: 0, igst_pct: 0, is_fixed_price: false };
  const [draft, setDraft] = useState<RateCard>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);

  const cards = useQuery({
    queryKey: ["rate-cards", dept?.id],
    enabled: !!dept?.id && open,
    queryFn: async () => {
      const { data } = await supabase.from("department_rate_cards").select("*").eq("department_id", dept!.id!).order("vehicle_name");
      return (data ?? []) as RateCard[];
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!dept?.id) throw new Error("No department");
      if (!draft.vehicle_name || !draft.package_type) throw new Error("Vehicle + package required");
      const payload: any = {
        ...draft,
        department_id: dept.id,
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
        // For fixed-price packages, ignore included/extra fields entirely.
        included_km: draft.is_fixed_price ? 0 : Number(draft.included_km || 0),
        included_hours: draft.is_fixed_price ? 0 : Number(draft.included_hours || 0),
        extra_km_rate: draft.is_fixed_price ? 0 : Number(draft.extra_km_rate || 0),
        extra_hour_rate: draft.is_fixed_price ? 0 : Number(draft.extra_hour_rate || 0),
        upgrade_enabled: false,
        upgrade_package_type: null,
        upgrade_base_fare: 0,
        upgrade_included_km: 0,
        upgrade_included_hours: 0,
        upgrade_extra_km_rate: 0,
        upgrade_extra_hour_rate: 0,
      };
      if (editingId) {
        const { id, ...rest } = payload;
        const { error } = await supabase.from("department_rate_cards").update(rest).eq("id", editingId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("department_rate_cards").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(editingId ? "Rate updated" : "Rate added");
      setDraft(emptyDraft);
      setEditingId(null);
      qc.invalidateQueries({ queryKey: ["rate-cards", dept?.id] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("department_rate_cards").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Removed"); qc.invalidateQueries({ queryKey: ["rate-cards", dept?.id] }); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Rate Card — {dept?.name}</DialogTitle></DialogHeader>
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
                  <TableCell>{(c as any).driver_allowance ?? 0}</TableCell>
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
                      <Button size="icon" variant="ghost" aria-label="Edit rate card row" onClick={() => { setEditingId(c.id ?? null); setDraft({ ...emptyDraft, ...c }); }}><Pencil className="h-4 w-4" /></Button>
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
                <Button size="sm" variant="ghost" onClick={() => { setEditingId(null); setDraft(emptyDraft); }}>Cancel edit</Button>
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
              <Button onClick={() => save.mutate()} disabled={save.isPending} className="bg-gold text-primary-foreground hover:opacity-90">
                {editingId ? <><Pencil className="h-4 w-4 mr-1" /> Update</> : <><Plus className="h-4 w-4 mr-1" /> Add</>}
              </Button>
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
              <p className="text-xs text-muted-foreground mt-1">Applied automatically when a trip's opening or closing time falls inside this slot, or when "Apply night charges" is enabled.</p>
            </div>
            <div className="mt-3">
              <div className="text-xs font-medium mb-1 text-gold">Driver allowance (optional)</div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div>
                  <Label className="text-xs">Driver allowance ₹ (per day)</Label>
                  <Input type="number" placeholder="e.g. 500" value={draft.driver_allowance || ""} disabled={!!draft.is_fixed_price} onChange={(e) => setDraft({ ...draft, driver_allowance: Number(e.target.value || 0) })} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-1">Added once per trip on top of the base fare. Skipped on fixed-price packages.</p>
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
              <p className="text-xs text-muted-foreground mt-1">Overrides the department's default GST setting for this vehicle/package.</p>
            </div>
          </div>
        </div>
        <DialogFooter><Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}