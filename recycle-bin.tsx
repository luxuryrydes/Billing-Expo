import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/db";
import { PageHeader } from "@/components/app/PageHeader";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { fmtINR } from "@/lib/billing";

export const Route = createFileRoute("/_app/recycle-bin")({ component: Page });

function Page() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"trips" | "invoices">("trips");

  const trips = useQuery({
    queryKey: ["recycle-trips"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("trips")
        .select("*")
        .not("deleted_at", "is", null)
        .order("deleted_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const invoices = useQuery({
    queryKey: ["recycle-invoices"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select("*")
        .not("deleted_at", "is", null)
        .order("deleted_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const restoreTrip = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("trips").update({ deleted_at: null }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Trip restored");
      qc.invalidateQueries({ queryKey: ["recycle-trips"] });
      qc.invalidateQueries({ queryKey: ["trips"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const purgeTrip = useMutation({
    mutationFn: async (id: string) => {
      await supabase.from("invoice_trips").delete().eq("trip_id", id);
      const { error } = await supabase.from("trips").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Trip permanently deleted");
      qc.invalidateQueries({ queryKey: ["recycle-trips"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const restoreInvoice = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("invoices").update({ deleted_at: null }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Invoice restored");
      qc.invalidateQueries({ queryKey: ["recycle-invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const purgeInvoice = useMutation({
    mutationFn: async (id: string) => {
      const { data: links } = await supabase.from("invoice_trips").select("trip_id").eq("invoice_id", id);
      const tripIds = (links ?? []).map((l: any) => l.trip_id);
      await supabase.from("invoice_trips").delete().eq("invoice_id", id);
      const { error } = await supabase.from("invoices").delete().eq("id", id);
      if (error) throw error;
      if (tripIds.length) {
        await supabase.from("trips").update({ invoiced: false }).in("id", tripIds);
      }
    },
    onSuccess: () => {
      toast.success("Invoice permanently deleted");
      qc.invalidateQueries({ queryKey: ["recycle-invoices"] });
      qc.invalidateQueries({ queryKey: ["trips"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const confirmPurge = (label: string, fn: () => void) => {
    if (window.confirm(`Permanently delete this ${label}? This cannot be undone.`)) fn();
  };

  return (
    <div>
      <PageHeader
        title="Recycle Bin"
        description="Deleted trips and invoices. Restore to bring back, or delete permanently to remove forever."
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
        <TabsList>
          <TabsTrigger value="trips">Trips ({trips.data?.length ?? 0})</TabsTrigger>
          <TabsTrigger value="invoices">Invoices ({invoices.data?.length ?? 0})</TabsTrigger>
        </TabsList>
        <TabsContent value="trips" className="mt-4">
          <div className="rounded-md border hairline overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr className="text-left">
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Company</th>
                  <th className="px-3 py-2">Guest / Car</th>
                  <th className="px-3 py-2 text-right">Total</th>
                  <th className="px-3 py-2">Deleted</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(trips.data ?? []).map((t: any) => (
                  <tr key={t.id} className="border-t hairline">
                    <td className="px-3 py-2">{t.duty_date ? new Date(t.duty_date).toLocaleDateString("en-IN") : "—"}</td>
                    <td className="px-3 py-2">{t.company_name || "—"}</td>
                    <td className="px-3 py-2">{t.guest_name || "—"}{t.car_number ? ` · ${t.car_number}` : ""}</td>
                    <td className="px-3 py-2 text-right">{fmtINR(Number(t.grand_total || 0))}</td>
                    <td className="px-3 py-2 text-muted-foreground">{new Date(t.deleted_at).toLocaleString("en-IN")}</td>
                    <td className="px-3 py-2 text-right">
                      <Button size="sm" variant="outline" onClick={() => restoreTrip.mutate(t.id)} className="mr-2">
                        <RotateCcw className="h-4 w-4 mr-1" /> Restore
                      </Button>
                      <Button size="sm" variant="outline" className="text-destructive hover:text-destructive"
                        onClick={() => confirmPurge("trip", () => purgeTrip.mutate(t.id))}>
                        <Trash2 className="h-4 w-4 mr-1" /> Delete forever
                      </Button>
                    </td>
                  </tr>
                ))}
                {(trips.data ?? []).length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">Recycle bin is empty</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>
        <TabsContent value="invoices" className="mt-4">
          <div className="rounded-md border hairline overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr className="text-left">
                  <th className="px-3 py-2">Invoice No</th>
                  <th className="px-3 py-2">Company</th>
                  <th className="px-3 py-2 text-right">Total</th>
                  <th className="px-3 py-2">Deleted</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(invoices.data ?? []).map((r: any) => (
                  <tr key={r.id} className="border-t hairline">
                    <td className="px-3 py-2 font-mono text-xs">{r.invoice_no}</td>
                    <td className="px-3 py-2">{r.company_name || "—"}</td>
                    <td className="px-3 py-2 text-right">{fmtINR(Number(r.grand_total || 0))}</td>
                    <td className="px-3 py-2 text-muted-foreground">{new Date(r.deleted_at).toLocaleString("en-IN")}</td>
                    <td className="px-3 py-2 text-right">
                      <Button size="sm" variant="outline" onClick={() => restoreInvoice.mutate(r.id)} className="mr-2">
                        <RotateCcw className="h-4 w-4 mr-1" /> Restore
                      </Button>
                      <Button size="sm" variant="outline" className="text-destructive hover:text-destructive"
                        onClick={() => confirmPurge("invoice", () => purgeInvoice.mutate(r.id))}>
                        <Trash2 className="h-4 w-4 mr-1" /> Delete forever
                      </Button>
                    </td>
                  </tr>
                ))}
                {(invoices.data ?? []).length === 0 && (
                  <tr><td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">Recycle bin is empty</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}