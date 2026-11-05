-- Duty types: a rate card can be marked for ALL duty types explicitly. Existing cards that list no duty type keep covering every
-- duty type (the column defaults to true), so nothing that billed before changes; a card created with no duty type and the flag off
-- covers none, and the software says so.
ALTER TABLE rate_scheme_versions ADD COLUMN all_duty_types boolean NOT NULL DEFAULT true;

-- A rate card is optional: an amount can be entered by hand for a slip, and it travels to the duty it is saved as.
ALTER TABLE slip_readings ADD COLUMN manual_amount numeric(14,2) CHECK (manual_amount IS NULL OR manual_amount >= 0);
ALTER TABLE slip_readings ADD COLUMN manual_note text;
ALTER TABLE duties ADD COLUMN manual_amount numeric(14,2) CHECK (manual_amount IS NULL OR manual_amount >= 0);
ALTER TABLE duties ADD COLUMN manual_note text;

-- Tax on amounts entered by hand, chosen on the invoice: {"mode":"contract"|"non_taxable"|"custom","rate":"5","included":false}.
-- Blank keeps the contract's approved tax rules, as for every bill made before this.
ALTER TABLE bills ADD COLUMN manual_tax jsonb;

-- Approved rate versions stay immutable except for their tax setting: rates, dates, vehicle categories and duty types still cannot change,
-- but a card's tax treatment (taxable / non-taxable, GST rate) can be set on the existing cards. Each change is written to the audit log.
CREATE OR REPLACE FUNCTION protect_approved_rates() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'approved' AND ((NEW.config - 'tax') IS DISTINCT FROM (OLD.config - 'tax') OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
      OR NEW.vehicle_category_ids IS DISTINCT FROM OLD.vehicle_category_ids OR NEW.duty_type_codes IS DISTINCT FROM OLD.duty_type_codes
      OR NEW.all_duty_types IS DISTINCT FROM OLD.all_duty_types) THEN
    RAISE EXCEPTION 'Approved rate version cannot be edited; create a new version';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
