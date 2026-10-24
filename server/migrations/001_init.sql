-- LR Taxi Services billing platform: core schema.
-- Money is numeric(14,2); odometer numeric(12,1); duty times are naive local timestamps.


CREATE TABLE app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','operator','reviewer','approver','readonly')),
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  storage_path text NOT NULL,
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_sha_idx ON files(sha256);

-- Supplier (our company) profiles used on invoices.
CREATE TABLE supplier_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  address text NOT NULL DEFAULT '',
  gstin text,
  pan text,
  state_name text,
  state_code text,
  phone text,
  email text,
  bank_details text,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  short_code text NOT NULL UNIQUE,
  billing_address text NOT NULL DEFAULT '',
  gstin text,
  pan text,
  state_name text,
  state_code text,
  contact_name text,
  contact_email text,
  contact_phone text,
  special_instructions text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  supplier_profile_id uuid REFERENCES supplier_profiles(id),
  title text NOT NULL,
  reference_no text NOT NULL,
  po_number text,
  start_date date NOT NULL,
  end_date date,
  billing_frequency text NOT NULL DEFAULT 'monthly' CHECK (billing_frequency IN ('monthly','fortnightly','weekly','per_trip')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','expired','terminated')),
  tax_mode text NOT NULL DEFAULT 'exclusive' CHECK (tax_mode IN ('exclusive','inclusive')),
  tax_level text NOT NULL DEFAULT 'document' CHECK (tax_level IN ('document','line')),
  invoice_rounding text NOT NULL DEFAULT 'none' CHECK (invoice_rounding IN ('none','nearest_rupee','up_rupee','down_rupee')),
  approval_levels int NOT NULL DEFAULT 1 CHECK (approval_levels IN (1,2)),
  bill_no_format text NOT NULL DEFAULT '{CLIENT}/{YYYY}-{MM}/{SEQ}',
  required_formats text,
  special_instructions text,
  validation jsonb NOT NULL DEFAULT '{}'::jsonb,
  custom_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date),
  UNIQUE (client_id, reference_no)
);
CREATE INDEX contracts_client_idx ON contracts(client_id);

CREATE TABLE vehicle_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE duty_types (
  code text PRIMARY KEY,
  name text NOT NULL,
  description text
);

CREATE TABLE vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_no text NOT NULL,           -- stored exactly as entered (text, leading zeros kept)
  reg_key text NOT NULL UNIQUE,            -- normalised for matching
  category_id uuid REFERENCES vehicle_categories(id),
  vendor_name text,
  client_id uuid REFERENCES clients(id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  name_key text NOT NULL UNIQUE,
  phone text,
  licence_no text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Documents ---------------------------------------------------------------
CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES clients(id),
  contract_id uuid REFERENCES contracts(id),
  doc_type text NOT NULL CHECK (doc_type IN ('contract','tender','scc','acc','rate_schedule','work_order','sample_invoice','billing_register','duty_sheet','other')),
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_contract_idx ON documents(contract_id);

CREATE TABLE document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_no int NOT NULL,
  file_id uuid NOT NULL REFERENCES files(id),
  uploaded_by uuid REFERENCES app_users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  extraction_status text NOT NULL DEFAULT 'pending' CHECK (extraction_status IN ('pending','running','done','failed','skipped')),
  extraction_error text,
  extraction_method text,
  page_count int,
  extracted jsonb,
  UNIQUE (document_id, version_no)
);

CREATE TABLE extracted_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_version_id uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  contract_id uuid REFERENCES contracts(id),
  field_key text NOT NULL,
  label text NOT NULL,
  value text NOT NULL,
  unit text,
  qualifier text,               -- e.g. vehicle category the value relates to
  source_page int,
  source_text text,
  confidence numeric(4,3),
  method text NOT NULL CHECK (method IN ('rule','ai','manual')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','edited')),
  edited_value text,
  review_note text,
  reviewed_by uuid REFERENCES app_users(id),
  reviewed_at timestamptz,
  conflict boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX extracted_items_dv_idx ON extracted_items(document_version_id);
CREATE INDEX extracted_items_contract_idx ON extracted_items(contract_id, field_key);

-- Rates & taxes -------------------------------------------------------------
CREATE TABLE rate_schemes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES contracts(id),
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, name)
);

CREATE TABLE rate_scheme_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scheme_id uuid NOT NULL REFERENCES rate_schemes(id) ON DELETE CASCADE,
  version_no int NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','retired','rejected')),
  effective_from date NOT NULL,
  effective_to date,
  vehicle_category_ids uuid[] NOT NULL DEFAULT '{}',
  duty_type_codes text[] NOT NULL DEFAULT '{}',
  config jsonb NOT NULL,
  clause_ref text,
  notes text,
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_by uuid REFERENCES app_users(id),
  approved_by uuid REFERENCES app_users(id),
  approved_at timestamptz,
  UNIQUE (scheme_id, version_no),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE tax_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES contracts(id),
  name text NOT NULL,
  tax_type text NOT NULL CHECK (tax_type IN ('CGST','SGST','IGST','UTGST','CESS','OTHER')),
  rate numeric(7,4) NOT NULL CHECK (rate >= 0 AND rate <= 100),
  effective_from date NOT NULL,
  effective_to date,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','retired')),
  source_ref text,
  created_by uuid REFERENCES app_users(id),
  approved_by uuid REFERENCES app_users(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tax_rules_contract_idx ON tax_rules(contract_id);

-- Duties ------------------------------------------------------------------
CREATE TABLE duty_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id uuid REFERENCES files(id),
  client_id uuid REFERENCES clients(id),
  contract_id uuid REFERENCES contracts(id),
  row_count int NOT NULL DEFAULT 0,
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE duties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  contract_id uuid NOT NULL REFERENCES contracts(id),
  duty_date date NOT NULL,
  vendor_name text,
  vehicle_category_id uuid REFERENCES vehicle_categories(id),
  vehicle_reg_no text NOT NULL,             -- text: never numeric, leading zeros preserved
  vehicle_reg_key text NOT NULL,
  driver_name text,
  field_officer text,
  duty_type_code text REFERENCES duty_types(code),
  start_km numeric(12,1),
  end_km numeric(12,1),
  start_at timestamp,
  end_at timestamp,
  toll_amount numeric(14,2),
  parking_amount numeric(14,2),
  other_charges numeric(14,2),
  custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  remarks text,
  supporting_doc_ref text,
  attachment_file_id uuid REFERENCES files(id),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import')),
  import_batch_id uuid REFERENCES duty_import_batches(id),
  status text NOT NULL DEFAULT 'entered' CHECK (status IN ('entered','verified','billed','void')),
  issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_count int NOT NULL DEFAULT 0,
  warning_count int NOT NULL DEFAULT 0,
  created_by uuid REFERENCES app_users(id),
  updated_by uuid REFERENCES app_users(id),
  verified_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX duties_contract_date_idx ON duties(contract_id, duty_date);
CREATE INDEX duties_vehicle_idx ON duties(vehicle_reg_key, duty_date);
CREATE INDEX duties_status_idx ON duties(status);
CREATE INDEX duties_created_idx ON duties(created_at);

-- Templates ----------------------------------------------------------------
CREATE TABLE billing_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES clients(id),
  contract_id uuid REFERENCES contracts(id),
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE billing_template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES billing_templates(id) ON DELETE CASCADE,
  version_no int NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','retired')),
  layout jsonb NOT NULL,
  xlsx_file_id uuid REFERENCES files(id),
  xlsx_mapping jsonb,
  reference_file_id uuid REFERENCES files(id),
  notes text,
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES app_users(id),
  approved_at timestamptz,
  UNIQUE (template_id, version_no)
);

-- Bills --------------------------------------------------------------------
CREATE TABLE bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  contract_id uuid NOT NULL REFERENCES contracts(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  bill_no text,
  bill_date date,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','calculation_pending','validation_required','under_review','approved','generated','submitted','superseded','cancelled')),
  revision_no int NOT NULL DEFAULT 0,
  revision_of uuid REFERENCES bills(id),
  revision_reason text,
  excluded_duties jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{dutyId, reason, by, at}]
  include_unverified boolean NOT NULL DEFAULT true,
  notes text,
  template_version_id uuid REFERENCES billing_template_versions(id),
  current_snapshot_id uuid,
  taxable_value numeric(14,2),
  non_taxable_total numeric(14,2),
  tax_total numeric(14,2),
  round_off numeric(14,2),
  grand_total numeric(14,2),
  reviewed_by uuid REFERENCES app_users(id),
  reviewed_at timestamptz,
  approved_by uuid REFERENCES app_users(id),
  approved_at timestamptz,
  submitted_at timestamptz,
  submission_ref text,
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);
CREATE INDEX bills_contract_period_idx ON bills(contract_id, period_start);
CREATE UNIQUE INDEX bills_no_rev_uq ON bills(bill_no, revision_no) WHERE bill_no IS NOT NULL;

-- Which duties a bill covers. A duty may be active on only one live bill.
CREATE TABLE bill_duties (
  bill_id uuid NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  duty_id uuid NOT NULL REFERENCES duties(id),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (bill_id, duty_id)
);
CREATE UNIQUE INDEX bill_duties_one_active_uq ON bill_duties(duty_id) WHERE active;

CREATE TABLE calculation_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  engine_version text NOT NULL,
  input jsonb NOT NULL,
  output jsonb NOT NULL,
  content_hash text NOT NULL,
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE bills ADD CONSTRAINT bills_snapshot_fk FOREIGN KEY (current_snapshot_id) REFERENCES calculation_snapshots(id);

CREATE TABLE bill_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  snapshot_id uuid NOT NULL REFERENCES calculation_snapshots(id) ON DELETE CASCADE,
  duty_id uuid REFERENCES duties(id),
  vehicle_reg_no text,
  scope text NOT NULL,
  component_code text NOT NULL,
  label text NOT NULL,
  kind text NOT NULL,
  quantity numeric(18,6) NOT NULL,
  unit text,
  rate numeric(14,4) NOT NULL,
  amount numeric(14,2) NOT NULL,
  tax_category text NOT NULL CHECK (tax_category IN ('taxable','non_taxable')),
  trace jsonb NOT NULL,
  sort_order int NOT NULL
);
CREATE INDEX bill_lines_bill_idx ON bill_lines(bill_id, sort_order);

CREATE TABLE bill_tax_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  snapshot_id uuid NOT NULL REFERENCES calculation_snapshots(id) ON DELETE CASCADE,
  tax_rule_id uuid REFERENCES tax_rules(id),
  name text NOT NULL,
  tax_type text NOT NULL,
  rate numeric(7,4) NOT NULL,
  taxable_base numeric(14,2) NOT NULL,
  amount numeric(14,2) NOT NULL
);

CREATE TABLE billing_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  snapshot_id uuid REFERENCES calculation_snapshots(id) ON DELETE CASCADE,
  duty_id uuid REFERENCES duties(id),
  code text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('error','warning')),
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','waived')),
  resolution_note text,
  resolved_by uuid REFERENCES app_users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_exceptions_bill_idx ON billing_exceptions(bill_id, status);

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL,
  user_id uuid NOT NULL REFERENCES app_users(id),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approvals_entity_idx ON approvals(entity_type, entity_id);

CREATE TABLE generated_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  snapshot_id uuid NOT NULL REFERENCES calculation_snapshots(id),
  template_version_id uuid REFERENCES billing_template_versions(id),
  kind text NOT NULL CHECK (kind IN ('bill_xlsx','bill_pdf','register_xlsx','summary_xlsx','exceptions_xlsx')),
  file_id uuid NOT NULL REFERENCES files(id),
  reconciliation jsonb,
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX generated_files_bill_idx ON generated_files(bill_id);

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  user_id uuid REFERENCES app_users(id),
  entity_type text NOT NULL,
  entity_id text,
  action text NOT NULL,
  before jsonb,
  after jsonb,
  note text
);
CREATE INDEX audit_entity_idx ON audit_events(entity_type, entity_id);
CREATE INDEX audit_at_idx ON audit_events(at DESC);

-- Approved/generated/submitted bills are immutable except for status progression and submission details.
CREATE OR REPLACE FUNCTION protect_final_bills() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('approved','generated','submitted','superseded') THEN
    IF NEW.current_snapshot_id IS DISTINCT FROM OLD.current_snapshot_id
       OR NEW.grand_total IS DISTINCT FROM OLD.grand_total
       OR NEW.taxable_value IS DISTINCT FROM OLD.taxable_value
       OR NEW.tax_total IS DISTINCT FROM OLD.tax_total
       OR NEW.bill_no IS DISTINCT FROM OLD.bill_no
       OR NEW.period_start IS DISTINCT FROM OLD.period_start
       OR NEW.period_end IS DISTINCT FROM OLD.period_end
       OR NEW.template_version_id IS DISTINCT FROM OLD.template_version_id THEN
      RAISE EXCEPTION 'Bill % is % and cannot be modified; create a revision instead', OLD.id, OLD.status;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bills_protect_final BEFORE UPDATE ON bills FOR EACH ROW EXECUTE FUNCTION protect_final_bills();

CREATE OR REPLACE FUNCTION protect_final_lines() RETURNS trigger AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM bills WHERE id = COALESCE(OLD.bill_id, NEW.bill_id);
  IF s IN ('approved','generated','submitted','superseded') THEN
    RAISE EXCEPTION 'Lines of a % bill cannot be changed', s;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bill_lines_protect BEFORE UPDATE OR DELETE ON bill_lines FOR EACH ROW EXECUTE FUNCTION protect_final_lines();

-- Approved rate versions are immutable (create a new version instead).
CREATE OR REPLACE FUNCTION protect_approved_rates() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'approved' AND (NEW.config IS DISTINCT FROM OLD.config OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
      OR NEW.vehicle_category_ids IS DISTINCT FROM OLD.vehicle_category_ids OR NEW.duty_type_codes IS DISTINCT FROM OLD.duty_type_codes) THEN
    RAISE EXCEPTION 'Approved rate version cannot be edited; create a new version';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rate_versions_protect BEFORE UPDATE ON rate_scheme_versions FOR EACH ROW EXECUTE FUNCTION protect_approved_rates();

-- On Supabase, deny direct table access through the anon/authenticated API keys:
-- this backend connects as the table owner and enforces permissions itself.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
