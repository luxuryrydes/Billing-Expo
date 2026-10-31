import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/db";
import { PageHeader } from "@/components/app/PageHeader";
import { DataCard } from "@/components/app/DataCard";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { fmtINR } from "@/lib/billing";
import { buildInvoicePdfData, exportInvoiceXlsxById, generateInvoicePdfBytes } from "@/lib/invoice";
import { downloadBytes, mergePdfs, generateInvoicePdf } from "@/lib/pdf";
import { buildBillDoc, splitBillDocPerUserIfNeeded } from "@/lib/bill-template";
import { exportBillXlsxMulti, exportBillPdf, exportBillDocxUniversalMulti } from "@/lib/bill-export";
import { toast } from "sonner";
import { FileSpreadsheet, FileText, Layers, Trash2, MessageCircle, Mail, FileType, Image as ImageIcon, Pencil } from "lucide-react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const Route = createFileRoute("/_app/invoices")({ component: Page });

function parseDutyDate(s: any): number {
  if (!s) return Number.MAX_SAFE_INTEGER;
  const str = String(s).trim();
  let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = str.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    let y = +m[3]; if (y < 100) y += 2000;
    return Date.UTC(y, +m[2] - 1, +m[1]);
  }
  const t = new Date(str).getTime();
  return isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
}

function Page() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [monthFilter, setMonthFilter] = useState<string>("all");
  const [yearFilter, setYearFilter] = useState<string>("all");
  const [editInv, setEditInv] = useState<any | null>(null);
  const [exportFmt, setExportFmt] = useState<null | "xlsx" | "docx" | "pdf">(null);
  const [exportDate, setExportDate] = useState<string>(() => {
    const d = new Date();
    return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getFullYear()).slice(-2)}`;
  });

  const runExport = async () => {
    const fmt = exportFmt;
    if (!fmt) return;
    try {
      const ids = Array.from(selected);
      const doc = await buildBillDoc(ids, { meta: { date: exportDate } });
      const stamp = new Date().toISOString().slice(0, 10);
      const docs = splitBillDocPerUserIfNeeded(doc);
      // Universal rule (ALL institutions): when format is Word, export ALL
      // per-user bills as a single portrait-A4 .docx with one bill per page.
      if (fmt === "docx") {
        const monthNamesFull = ["January","February","March","April","May","June","July","August","September","October","November","December"];
        const parts = exportDate.split(".");
        let monthYear = stamp;
        if (parts.length >= 3) {
          const m = Number(parts[1]);
          const y = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
          if (m >= 1 && m <= 12) monthYear = `${monthNamesFull[m - 1]}_${y}`;
        }
        const inst = (doc.institution_code || "LR").toUpperCase();
        await exportBillDocxUniversalMulti(docs, `${inst}_Bills_${monthYear}.docx`);
        toast.success(docs.length > 1 ? `${docs.length} bills exported in one file` : "Downloaded");
        setExportFmt(null);
        return;
      }
      if (fmt === "xlsx") {
        await exportBillXlsxMulti(docs, `LR-Merged-${stamp}.xlsx`);
        toast.success(docs.length > 1 ? `${docs.length} bills exported in one workbook` : "Downloaded");
        setExportFmt(null);
        return;
      }
      for (const d of docs) {
        const userTag = docs.length > 1
          ? "-" + (d.custom_fields?.find((cf) => cf.label.toLowerCase().includes("user"))?.value || "user").replace(/[^a-z0-9]+/gi, "_")
          : "";
        const base = `LR-Merged-${stamp}${userTag}`;
        await exportBillPdf(d, `${base}.pdf`);
      }
      toast.success(docs.length > 1 ? `${docs.length} bills downloaded` : "Downloaded");
      setExportFmt(null);
    } catch (e: any) { toast.error(e.message); }
  };

  const { data, isLoading } = useQuery({
    queryKey: ["invoices"],
    queryFn: async () => {
      // Only merged/monthly invoices belong on the Invoices dashboard.
      // Single-trip invoices are managed from the Trips page where each
      // trip's uploaded duty slip is shown inline.
      const { data, error } = await supabase
        .from("invoices")
        .select("*")
        .is("deleted_at", null)
        .neq("type", "single")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: tripMap } = useQuery({
    queryKey: ["invoice-trip-summary", (data ?? []).map((i: any) => i.id).join(",")],
    enabled: (data ?? []).length > 0,
    queryFn: async () => {
      const ids = (data ?? []).map((i: any) => i.id);
      const { data: links } = await supabase.from("invoice_trips").select("invoice_id, trip_id").in("invoice_id", ids);
      const tripIds = Array.from(new Set((links ?? []).map((l: any) => l.trip_id)));
      const { data: trips } = tripIds.length
        ? await supabase.from("trips").select("id, duty_date, guest_name, duty_slip_id").in("id", tripIds)
        : { data: [] as any[] };
      const tById: Record<string, any> = {};
      for (const t of (trips ?? []) as any[]) tById[t.id] = t;
      const map: Record<string, any[]> = {};
      for (const l of (links ?? []) as any[]) {
        const t = tById[l.trip_id];
        if (!t) continue;
        (map[l.invoice_id] ||= []).push(t);
      }
      for (const k of Object.keys(map)) {
        map[k].sort((a, b) => parseDutyDate(a.duty_date) - parseDutyDate(b.duty_date));
      }
      return map;
    },
  });

  const { data: slipMap } = useQuery({
    queryKey: ["invoice-slip-paths", Object.entries(tripMap ?? {}).map(([k, v]: any) => `${k}:${v.length}`).join(",")],
    enabled: !!tripMap && Object.keys(tripMap ?? {}).length > 0,
    queryFn: async () => {
      const slipIds = Array.from(new Set(
        Object.values(tripMap ?? {}).flat().map((t: any) => t.duty_slip_id).filter(Boolean)
      )) as string[];
      if (!slipIds.length) return {} as Record<string, string[]>;
      const { data: slips } = await supabase.from("duty_slips").select("id, file_path").in("id", slipIds);
      const pathById: Record<string, string> = {};
      for (const s of (slips ?? []) as any[]) pathById[s.id] = s.file_path;
      const out: Record<string, string[]> = {};
      for (const [invId, ts] of Object.entries(tripMap ?? {})) {
        const paths = (ts as any[]).map((t) => pathById[t.duty_slip_id]).filter(Boolean);
        if (paths.length) out[invId] = paths;
      }
      return out;
    },
  });

  const viewSlips = async (invId: string) => {
    const paths = slipMap?.[invId] ?? [];
    if (!paths.length) { toast.error("No duty slip linked to this invoice"); return; }
    for (const p of paths) {
      const { data, error } = await supabase.storage.from("duty-slips").createSignedUrl(p, 3600);
      if (error) { toast.error(error.message); continue; }
      window.open(data.signedUrl, "_blank");
    }
  };

  const invoiceMonthYear = (r: any): { m: number; y: number } | null => {
    const ts = (tripMap?.[r.id] ?? []) as any[];
    const first = ts[0]?.duty_date;
    const ms = first ? parseDutyDate(first) : new Date(r.created_at || 0).getTime();
    if (!ms || ms === Number.MAX_SAFE_INTEGER) return null;
    const d = new Date(ms);
    return { m: d.getUTCMonth() + 1, y: d.getUTCFullYear() };
  };

  const availableYears = Array.from(new Set((data ?? []).map((r: any) => invoiceMonthYear(r)?.y).filter(Boolean) as number[])).sort((a, b) => b - a);

  const rows = (data ?? []).filter((r: any) => {
    const my = invoiceMonthYear(r);
    if (monthFilter !== "all" && (!my || my.m !== Number(monthFilter))) return false;
    if (yearFilter !== "all" && (!my || my.y !== Number(yearFilter))) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    const ts = (tripMap?.[r.id] ?? []) as any[];
    const guestStr = ts.map((t) => t.guest_name).join(" ");
    const dateStr = ts.map((t) => t.duty_date).join(" ");
    return [r.invoice_no, r.company_name, guestStr, dateStr].some((v) => String(v ?? "").toLowerCase().includes(q));
  }).sort((a: any, b: any) => {
    const ad = (tripMap?.[a.id] ?? [])[0]?.duty_date;
    const bd = (tripMap?.[b.id] ?? [])[0]?.duty_date;
    const av = ad ? parseDutyDate(ad) : new Date(a.created_at || 0).getTime();
    const bv = bd ? parseDutyDate(bd) : new Date(b.created_at || 0).getTime();
    return av - bv;
  });

  const toggle = (id: string) => { const s = new Set(selected); s.has(id) ? s.delete(id) : s.add(id); setSelected(s); };

  const downloadPdf = async (id: string, no: string) => {
    try {
      const doc = await buildBillDoc([id], { meta: { date: exportDate } });
      const docs = splitBillDocPerUserIfNeeded(doc);
      for (const d of docs) {
        const tag = docs.length > 1
          ? "-" + (d.custom_fields?.find((cf) => cf.label.toLowerCase().includes("user"))?.value || "user").replace(/[^a-z0-9]+/gi, "_")
          : "";
        await exportBillPdf(d, `${no}${tag}.pdf`);
      }
    } catch (e: any) { toast.error(e.message); }
  };
  const downloadXlsx = async (id: string) => {
    try {
      const doc = await buildBillDoc([id], { meta: { date: exportDate } });
      const inv = (data ?? []).find((r: any) => r.id === id);
      const docs = splitBillDocPerUserIfNeeded(doc);
      await exportBillXlsxMulti(docs, `${inv?.invoice_no || "invoice"}.xlsx`);
    } catch (e: any) { toast.error(e.message); }
  };

  const mergeMut = useMutation({
    mutationFn: async () => {
      const ids = Array.from(selected);
      if (ids.length < 2) throw new Error("Select at least 2 invoices");
      const pdfs: Uint8Array[] = [];
      for (const id of ids) {
        const data = await buildInvoicePdfData(id);
        pdfs.push(await generateInvoicePdf(data));
      }
      const merged = await mergePdfs(pdfs);
      downloadBytes(merged, `LR-Corporate-${new Date().toISOString().slice(0, 10)}.pdf`);
    },
    onSuccess: () => toast.success("Merged PDF downloaded"),
    onError: (e: any) => toast.error(e.message),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      await supabase.from("invoices").update({ deleted_at: new Date().toISOString() }).eq("id", id);
    },
    onSuccess: () => { toast.success("Invoice moved to Recycle Bin"); qc.invalidateQueries({ queryKey: ["invoices"] }); qc.invalidateQueries({ queryKey: ["trips"] }); },
    onError: (e: any) => toast.error(e.message),
  });

  const bulkDel = useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await supabase.from("invoices").update({ deleted_at: new Date().toISOString() }).in("id", ids);
      if (error) throw error;
    },
    onSuccess: (_d, ids) => {
      toast.success(`${ids.length} invoice(s) moved to Recycle Bin`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["trips"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader
        title="Invoices"
        description="Generated GST invoices. Download PDF, Excel, or merge multiple into one corporate billing PDF."
        action={
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={selected.size < 1}
              onClick={() => {
                const ids = Array.from(selected);
                if (!ids.length) return;
                if (confirm(`Delete ${ids.length} selected invoice(s)? They will be moved to Recycle Bin.`)) bulkDel.mutate(ids);
              }}
            >
              <Trash2 className="h-4 w-4 mr-1" /> Delete {selected.size > 0 ? `(${selected.size})` : ""}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" disabled={selected.size < 1}>
                  <Layers className="h-4 w-4 mr-1" /> Merge & Export {selected.size > 0 ? `(${selected.size})` : ""}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setExportFmt("xlsx")}><FileSpreadsheet className="h-4 w-4 mr-2" /> Excel (.xlsx) — editable</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setExportFmt("docx")}><FileType className="h-4 w-4 mr-2" /> Word (.docx) — editable</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setExportFmt("pdf")}><FileText className="h-4 w-4 mr-2" /> PDF (formatted)</DropdownMenuItem>
                <DropdownMenuItem disabled={selected.size < 2} onClick={() => mergeMut.mutate()}>
                  <Layers className="h-4 w-4 mr-2" /> Legacy: merge per-invoice PDFs
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />
      <Dialog open={!!exportFmt} onOpenChange={(o) => !o && setExportFmt(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bill date for export</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Label htmlFor="export-date">Date shown on the bill (DATE field)</Label>
            <Input id="export-date" value={exportDate} onChange={(e) => setExportDate(e.target.value)} placeholder="e.g. 15.05.26 or 15-May-2026" autoFocus />
            <p className="text-xs text-muted-foreground">Type any date format you want printed on the merged bill.</p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setExportFmt(null)}>Cancel</Button>
            <Button onClick={runExport}>Export {exportFmt?.toUpperCase()}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DataCard>
        <div className="mb-4 flex flex-wrap gap-2 items-center">
          <Input placeholder="Search invoice / company…" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-sm" />
          <Select value={monthFilter} onValueChange={setMonthFilter}>
            <SelectTrigger className="w-[150px]"><SelectValue placeholder="Month" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All months</SelectItem>
              {["January","February","March","April","May","June","July","August","September","October","November","December"].map((n, i) => (
                <SelectItem key={i+1} value={String(i+1)}>{n}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={yearFilter} onValueChange={setYearFilter}>
            <SelectTrigger className="w-[120px]"><SelectValue placeholder="Year" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All years</SelectItem>
              {availableYears.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
            </SelectContent>
          </Select>
          {(monthFilter !== "all" || yearFilter !== "all") && (
            <Button size="sm" variant="ghost" onClick={() => { setMonthFilter("all"); setYearFilter("all"); }}>Clear</Button>
          )}
        </div>
        {isLoading ? (
          <div className="text-muted-foreground text-sm">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="text-muted-foreground text-sm py-8 text-center">No invoices yet. Create one from Trips.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground border-b">
                  <th className="py-2 w-8">
                    <Checkbox
                      checked={rows.length > 0 && rows.every((r: any) => selected.has(r.id))}
                      onCheckedChange={(c) => {
                        const s = new Set(selected);
                        if (c) rows.forEach((r: any) => s.add(r.id));
                        else rows.forEach((r: any) => s.delete(r.id));
                        setSelected(s);
                      }}
                      title="Select all filtered"
                    />
                  </th>
                  <th className="py-2 pr-4">Company</th>
                  <th className="py-2 pr-4">Trip Date(s)</th>
                  <th className="py-2 pr-4">Guest(s)</th>
                  <th className="py-2 pr-4">Type</th>
                  <th className="py-2 pr-4">Total</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((inv: any) => (
                  <tr key={inv.id} className="border-b border-border/40 hover:bg-muted/20">
                    <td className="py-2"><Checkbox checked={selected.has(inv.id)} onCheckedChange={() => toggle(inv.id)} /></td>
                    <td className="py-2 pr-4">{inv.company_name || "—"}</td>
                    <td className="py-2 pr-4 text-xs">
                      {(tripMap?.[inv.id] ?? []).length === 0 ? "—" :
                        (tripMap![inv.id].length <= 2
                          ? tripMap![inv.id].map((t: any) => t.duty_date ? new Date(t.duty_date).toLocaleDateString("en-IN") : "—").join(", ")
                          : `${new Date(tripMap![inv.id][0].duty_date).toLocaleDateString("en-IN")} → ${new Date(tripMap![inv.id][tripMap![inv.id].length - 1].duty_date).toLocaleDateString("en-IN")} (${tripMap![inv.id].length})`)}
                    </td>
                    <td className="py-2 pr-4 text-xs">
                      {(() => {
                        const guests = Array.from(new Set((tripMap?.[inv.id] ?? []).map((t: any) => t.guest_name).filter(Boolean)));
                        if (guests.length === 0) return "—";
                        if (guests.length <= 2) return guests.join(", ");
                        return `${guests.slice(0, 2).join(", ")} +${guests.length - 2}`;
                      })()}
                    </td>
                    <td className="py-2 pr-4 capitalize">{inv.type}</td>
                    <td className="py-2 pr-4 font-medium gold-text">{fmtINR(inv.grand_total)}</td>
                    <td className="py-2 pr-4"><Badge variant={inv.status === "paid" ? "secondary" : "default"}>{inv.status}</Badge></td>
                    <td className="py-2">
                      <div className="flex gap-1">
                        <Button size="icon" variant="ghost" title="Download PDF" aria-label={`Download PDF for invoice ${inv.invoice_no}`} onClick={() => downloadPdf(inv.id, inv.invoice_no)}><FileText className="h-4 w-4" /></Button>
                        <Button size="icon" variant="ghost" title="Download Excel" aria-label={`Download Excel for invoice ${inv.invoice_no}`} onClick={() => downloadXlsx(inv.id)}><FileSpreadsheet className="h-4 w-4" /></Button>
                        <Button size="icon" variant="ghost" title="View Duty Slip" aria-label={`View duty slip for invoice ${inv.invoice_no}`} disabled={!slipMap?.[inv.id]?.length} onClick={() => viewSlips(inv.id)}><ImageIcon className="h-4 w-4" /></Button>
                        <Button size="icon" variant="ghost" title="WhatsApp" aria-label={`Share invoice ${inv.invoice_no} via WhatsApp`} onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(`Invoice ${inv.invoice_no} - ${fmtINR(inv.grand_total)}`)}`)}><MessageCircle className="h-4 w-4" /></Button>
                        <Button size="icon" variant="ghost" title="Email" aria-label={`Email invoice ${inv.invoice_no}`} onClick={() => window.open(`mailto:?subject=${encodeURIComponent(`Invoice ${inv.invoice_no}`)}&body=${encodeURIComponent(`Total: ${fmtINR(inv.grand_total)}`)}`)}><Mail className="h-4 w-4" /></Button>
                        <Button size="icon" variant="ghost" title="Edit trips in this invoice" aria-label={`Edit trips in invoice ${inv.invoice_no}`} onClick={() => setEditInv(inv)}><Pencil className="h-4 w-4" /></Button>
                        <Button size="icon" variant="ghost" title="Delete" aria-label={`Delete invoice ${inv.invoice_no}`} onClick={() => { if (confirm("Delete invoice?")) del.mutate(inv.id); }}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DataCard>
      <Dialog open={!!editInv} onOpenChange={(o) => !o && setEditInv(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit trips in {editInv?.invoice_no}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto divide-y">
            {(editInv && (tripMap?.[editInv.id] ?? []).length > 0) ? (
              (tripMap![editInv.id] as any[]).map((t) => (
                <div key={t.id} className="flex items-center justify-between py-2 gap-3">
                  <div className="text-sm">
                    <div className="font-medium">{t.guest_name || "—"}</div>
                    <div className="text-xs text-muted-foreground">
                      {t.duty_date ? new Date(t.duty_date).toLocaleDateString("en-IN") : "—"}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEditInv(null);
                      nav({ to: "/trips", search: { editTrip: t.id } });
                    }}
                  >
                    <Pencil className="h-4 w-4 mr-1" /> Edit trip
                  </Button>
                </div>
              ))
            ) : (
              <div className="text-sm text-muted-foreground py-4">No trips linked to this invoice.</div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditInv(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}