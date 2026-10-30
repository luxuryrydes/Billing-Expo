-- Duty slip scanning: a batch of scanned (or uploaded) slip images, the pages in it, and what was read from each page.

CREATE TABLE scan_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  source text NOT NULL DEFAULT 'scanner' CHECK (source IN ('scanner', 'upload')),
  device_name text,
  color_mode text,
  dpi int,
  scan_source text,                         -- feeder | flatbed
  status text NOT NULL DEFAULT 'scanning' CHECK (status IN ('scanning', 'ready', 'failed')),
  error text,
  contract_id uuid REFERENCES contracts(id),  -- optional default contract for the slips in the batch
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scan_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES scan_batches(id) ON DELETE CASCADE,
  position int NOT NULL,
  file_id uuid NOT NULL REFERENCES files(id),           -- the image as it is now (after rotate / crop / rescan)
  original_file_id uuid NOT NULL REFERENCES files(id),  -- the image as it was scanned
  deleted boolean NOT NULL DEFAULT false,               -- removed from the batch, kept for audit
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scan_pages_batch_idx ON scan_pages(batch_id, position);

CREATE TABLE slip_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid NOT NULL UNIQUE REFERENCES scan_pages(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES scan_batches(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reading', 'read', 'failed')),
  fields jsonb NOT NULL DEFAULT '{}'::jsonb,   -- key -> { value, confidence } as read from the image
  edited jsonb NOT NULL DEFAULT '{}'::jsonb,   -- key -> value typed by a person; wins over the reading
  notes text,
  error text,
  model text,
  contract_id uuid REFERENCES contracts(id),
  duty_id uuid REFERENCES duties(id),          -- set once the slip has been saved as a duty
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX slip_readings_batch_idx ON slip_readings(batch_id);
