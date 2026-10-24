-- Department rate register: billing metadata, the contract a department's rate card lives on,
-- and the rate-card row each rate version was created from.

ALTER TABLE clients ADD COLUMN billing_pattern text;        -- e.g. "MONTHLY/ DAY TO DAY", "DAY TO DAY"
ALTER TABLE clients ADD COLUMN billing_entity text;         -- e.g. "LR TAXI SERVICES", "SRC"
ALTER TABLE clients ADD COLUMN billing_registration text;   -- e.g. "DELHI GST", "HR GST", "UP GST"
ALTER TABLE clients ADD COLUMN rate_card_contract_id uuid REFERENCES contracts(id);

-- The rate-card row (vehicle, package, base fare, extras, night slot, driver allowance, tax…)
-- exactly as entered or imported, kept with every version so the register can be exported back.
ALTER TABLE rate_scheme_versions ADD COLUMN meta jsonb NOT NULL DEFAULT '{}'::jsonb;
