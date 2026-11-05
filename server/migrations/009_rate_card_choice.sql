-- A rate card (rate scheme) can be chosen for a scanned slip and is kept on the duty made from it, so a bill uses the
-- chosen card. Blank means the software picks the approved rate that fits the department, vehicle type, duty type and date.
ALTER TABLE slip_readings ADD COLUMN rate_scheme_id uuid REFERENCES rate_schemes(id);
ALTER TABLE duties ADD COLUMN rate_scheme_id uuid REFERENCES rate_schemes(id);
