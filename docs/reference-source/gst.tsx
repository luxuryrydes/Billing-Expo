import { createFileRoute } from "@tanstack/react-router";
import { CrudPage } from "@/components/app/CrudPage";

export const Route = createFileRoute("/_app/gst")({ component: Page });

function Page() {
  return (
    <CrudPage
      title="GST Settings"
      description="Configure GST modes (Split CGST/SGST, IGST, Simple GST, or RCM note). Admin only."
      table="gst_settings"
      searchKeys={["name"]}
      fields={[
        { key: "name", label: "Name", required: true },
        { key: "mode", label: "Mode", type: "select", required: true, options: [
          { label: "Split (CGST + SGST)", value: "split" },
          { label: "IGST", value: "igst" },
          { label: "Simple GST", value: "simple" },
          { label: "RCM (Show name only, no GST calculated)", value: "rcm" },
        ]},
        { key: "cgst_pct", label: "CGST %", type: "number", default: 0 },
        { key: "sgst_pct", label: "SGST %", type: "number", default: 0 },
        { key: "igst_pct", label: "IGST %", type: "number", default: 0 },
        { key: "gst_pct", label: "GST %", type: "number", default: 0 },
        { key: "is_default", label: "Default", type: "checkbox", default: false },
      ]}
    />
  );
}