-- Departments & institutions master data, Excel import history, document update tracking.

-- One table for both: departments (keyed by name) and institutions (keyed by code).
ALTER TABLE clients ADD COLUMN kind text NOT NULL DEFAULT 'department' CHECK (kind IN ('department','institution'));
ALTER TABLE clients ADD COLUMN code text;                     -- stable institution key, e.g. "crri"
ALTER TABLE clients ADD COLUMN company text;                  -- billing entity name printed on bills
ALTER TABLE clients ADD COLUMN header_title text;
ALTER TABLE clients ADD COLUMN header_subtitle text;
ALTER TABLE clients ADD COLUMN invoice_prefix text;           -- e.g. "LRTS/26-27"
ALTER TABLE clients ADD COLUMN default_package text;
ALTER TABLE clients ADD COLUMN gst_label text;                -- as written, e.g. "Split 2.5+2.5%", "18% GST"
ALTER TABLE clients ADD COLUMN gst_mode text;                 -- e.g. include / show_separate / rcm
ALTER TABLE clients ADD COLUMN cgst_rate numeric(7,4);
ALTER TABLE clients ADD COLUMN sgst_rate numeric(7,4);
ALTER TABLE clients ADD COLUMN igst_rate numeric(7,4);
ALTER TABLE clients ADD COLUMN vendor_sac text;
ALTER TABLE clients ADD COLUMN vendor_gstin text;             -- LR registration used for this client
ALTER TABLE clients ADD COLUMN duty_fields text[] NOT NULL DEFAULT '{}';  -- extra duty-slip fields, e.g. "Project Code"
ALTER TABLE clients ADD COLUMN terms text;
ALTER TABLE clients ADD COLUMN notes text;
ALTER TABLE clients ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb;  -- imported columns with no dedicated field

CREATE UNIQUE INDEX clients_department_name_uq ON clients (lower(name)) WHERE kind = 'department';
CREATE UNIQUE INDEX clients_institution_code_uq ON clients (lower(code)) WHERE kind = 'institution';

-- Every Excel import (master data or rate cards): what was read, what changed, and the rows that failed.
CREATE TABLE import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity text NOT NULL,                       -- departments | institutions | rate_card
  context jsonb NOT NULL DEFAULT '{}'::jsonb, -- e.g. { contractId }
  file_id uuid REFERENCES files(id),
  sheet text,
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  added int NOT NULL DEFAULT 0,
  updated int NOT NULL DEFAULT 0,
  unchanged int NOT NULL DEFAULT 0,
  skipped int NOT NULL DEFAULT 0,
  errors int NOT NULL DEFAULT 0,
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX import_runs_entity_idx ON import_runs(entity, created_at DESC);
ALTER TABLE import_runs ENABLE ROW LEVEL SECURITY;

ALTER TABLE documents ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE document_versions ADD COLUMN note text;
