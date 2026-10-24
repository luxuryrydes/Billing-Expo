-- Onboarding from documents, category aliases, department codes, date-wise billing.

-- Names used for a category on duty sheets and bills (e.g. "Innova", "Ertiga" → "SUV AC").
ALTER TABLE vehicle_categories ADD COLUMN aliases text[] NOT NULL DEFAULT '{}';

-- Codes a department is known by on shared duty sheets (e.g. "DRI").
ALTER TABLE clients ADD COLUMN aliases text[] NOT NULL DEFAULT '{}';

ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_billing_frequency_check;
ALTER TABLE contracts ADD CONSTRAINT contracts_billing_frequency_check CHECK (billing_frequency IN ('monthly','fortnightly','weekly','daily','per_trip'));
ALTER TABLE contracts ADD COLUMN contract_value numeric(16,2);
ALTER TABLE contracts ADD COLUMN bid_no text;
ALTER TABLE contracts ADD COLUMN sac_code text;

ALTER TABLE supplier_profiles ADD COLUMN msme_no text;
ALTER TABLE supplier_profiles ADD COLUMN tagline text;

-- month = calendar month, date = a single duty date, range = any other period
ALTER TABLE bills ADD COLUMN period_type text NOT NULL DEFAULT 'month' CHECK (period_type IN ('month','date','range'));

-- Onboarding sessions: the merged proposal built from uploaded documents and what was created from it.
CREATE TABLE onboarding_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_version_ids uuid[] NOT NULL DEFAULT '{}',
  proposal jsonb,
  status text NOT NULL DEFAULT 'analysing' CHECK (status IN ('analysing','ready','failed','applied')),
  error text,
  applied jsonb,
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE onboarding_sessions ENABLE ROW LEVEL SECURITY;

-- Vehicle model/type as written on the duty slip (e.g. "Innova"); the billing category (e.g. "SUV AC") is resolved from it.
ALTER TABLE duties ADD COLUMN vehicle_model text;
