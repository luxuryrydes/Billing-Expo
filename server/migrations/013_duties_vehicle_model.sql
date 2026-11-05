-- Some databases were created before 002_onboarding.sql included this column and so never got it, which made saving scanned slips fail
-- ("column vehicle_model of relation duties does not exist"). Adding it again is harmless where it already exists.
ALTER TABLE duties ADD COLUMN IF NOT EXISTS vehicle_model text;
