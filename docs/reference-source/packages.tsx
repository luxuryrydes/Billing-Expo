import { createFileRoute } from "@tanstack/react-router";
import { CrudPage } from "@/components/app/CrudPage";

export const Route = createFileRoute("/_app/packages")({ component: Page });

function Page() {
  return (
    <CrudPage
      title="Packages"
      description="Vehicle pricing — admin only. Use Excel import for bulk uploads."
      table="packages"
      excel
      searchKeys={["vehicle_name", "package_type", "category"]}
      fields={[
        { key: "vehicle_name", label: "Vehicle Name", required: true },
        { key: "package_type", label: "Package Type", required: true },
        { key: "category", label: "Category" },
        { key: "base_fare", label: "Base Fare", type: "number", default: 0 },
        { key: "included_km", label: "Included KM", type: "number", default: 0 },
        { key: "included_hours", label: "Included Hours", type: "number", default: 0 },
        { key: "extra_km_rate", label: "Extra KM Rate", type: "number", default: 0 },
        { key: "extra_hour_rate", label: "Extra Hour Rate", type: "number", default: 0 },
        { key: "night_charges", label: "Night Charges", type: "number", default: 0 },
        { key: "driver_allowance", label: "Driver Allowance", type: "number", default: 0 },
        { key: "minimum_km", label: "Minimum KM", type: "number", default: 0 },
        { key: "active", label: "Active", type: "checkbox", default: true },
      ]}
    />
  );
}