-- The calculation behind a duty saved from a scanned slip: which approved rate version was used, the lines and the totals.
-- It is a record of what was calculated when the duty was saved. Bills are still calculated from the duties and the
-- approved rates at billing time, and a bill that was approved keeps its own snapshot, so nothing here changes history.
CREATE TABLE duty_calculations (
  duty_id uuid PRIMARY KEY REFERENCES duties(id) ON DELETE CASCADE,
  scheme_version_id uuid REFERENCES rate_scheme_versions(id),
  scheme_name text,
  version_no int,
  effective_from date,
  status text NOT NULL CHECK (status IN ('ok', 'review')),
  message text,
  variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  totals jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'scan',
  calculated_by uuid REFERENCES app_users(id),
  calculated_at timestamptz NOT NULL DEFAULT now()
);

-- Contract extension letters. A contract keeps its original dates; each applied extension moves the current end date.
ALTER TABLE contracts ADD COLUMN original_end_date date;

CREATE TABLE contract_extensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES contracts(id),
  file_id uuid NOT NULL REFERENCES files(id),
  sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected')),
  -- what the reader found, with confidence for each value (never changed after reading)
  extracted jsonb NOT NULL DEFAULT '{}'::jsonb,
  reader text,
  read_error text,
  -- the values a person confirmed (or typed) before applying
  letter_no text,
  letter_date date,
  department_name text,
  contract_reference text,
  previous_end_date date,
  extension_start date,
  new_end_date date,
  remarks text,
  conflicts jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- the contract dates at the moment it was applied, kept for the history
  applied_prev_start date,
  applied_prev_end date,
  applied_prev_status text,
  uploaded_by uuid REFERENCES app_users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES app_users(id),
  applied_by uuid REFERENCES app_users(id),
  applied_at timestamptz,
  rejected_reason text
);
CREATE INDEX contract_extensions_contract_idx ON contract_extensions(contract_id);
-- The same letter cannot be uploaded twice for a contract (a rejected one can be uploaded again).
CREATE UNIQUE INDEX contract_extensions_one_file ON contract_extensions(contract_id, sha256) WHERE status <> 'rejected';
-- The same letter number cannot be applied twice to a contract.
CREATE UNIQUE INDEX contract_extensions_one_letter ON contract_extensions(contract_id, lower(letter_no)) WHERE status = 'applied' AND letter_no IS NOT NULL;
