import { createFileRoute } from "@tanstack/react-router";
import { CrudPage } from "@/components/app/CrudPage";

export const Route = createFileRoute("/_app/companies")({ component: Page });

function Page() {
  return (
    <CrudPage
      title="Companies"
      description="Manage corporate clients for billing."
      table="companies"
      excel
      searchKeys={["name", "gstin", "billing_email"]}
      fields={[
        { key: "name", label: "Name", required: true },
        { key: "gstin", label: "GSTIN" },
        { key: "billing_email", label: "Billing Email" },
        { key: "phone", label: "Phone" },
        { key: "address", label: "Address", type: "textarea", hideInTable: true },
        { key: "notes", label: "Notes", type: "textarea", hideInTable: true },
      ]}
    />
  );
}
