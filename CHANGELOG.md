# Changelog

## 2.0.0

A new look and a cleaner workflow. **No data is removed on upgrade**: departments, contracts, rate cards, tax rules, duties, templates and bills stay exactly as they were (the only database changes are additions).

- **New design:** three themes (Light, Dark, Ocean) chosen in the sidebar and remembered; sidebar icons, a version badge, a redesigned sign-in page, softer cards and clearer tables and buttons.
- **Motion (Framer Motion):** screens fade and rise in, the sidebar highlight slides between pages, dialogs spring open, toasts slide in, and on the dashboard the numbers count up, the monthly columns, department bars, stage bar and progress bar grow, and the cards appear in turn. It follows the system *reduce motion* setting.
- **Buttons and fields:** clear focus rings, hover and disabled states, red highlight on invalid fields, brand-coloured checkboxes, and a tab underline that glides between tabs. The same buttons and fields are laid out in the Figma file *LR Billing 2.0 Design System* (colour tokens for Light and Dark, Button and Text field components).
- **Delete duty slips:** select duties in the Duty Register and press *Delete selected* (permission `duty.delete`, admin by default); a duty that is on a bill is refused with the bill's number, and each deletion is kept in the audit log.
- **Delete invoices:** an invoice (or several selected in Billing Export / Invoices) can be deleted by people with the new `bill.delete` permission (admin by default), with a reason that is kept in the audit log. Only the invoice goes: its duties return to *not billed*, and departments, rate cards, tax rules, templates and duties are never deleted. An invoice that has revisions cannot be deleted until they are.
- **Cleaner Rate Schemes:** expired, rejected and retired versions are hidden unless *Show old versions* is ticked; the tax badge only shows when a tax setting exists.
- **Billing:** one tax rule per tax type is used, so GST is never charged twice; Excel bills carry live formulas; department-wise invoices, optional rate cards, manual amounts, tax set on rate cards, scanned-slip calculation and contract extension letters (see the README).
- **Safety:** the database is backed up automatically at every start and shut down cleanly when the window closes.
- `GET /api/version` returns the version.
