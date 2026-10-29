-- Printed arithmetic of a contract's bills.
--   standard : every charge line and every tax is rounded to paise, then summed (default; unchanged behaviour)
--   lr_exact : charge lines keep unit x rate exactly (4 decimals), tax is taxable x rate / 100 without
--              intermediate rounding, and the bill total is rounded to the whole rupee - the way the
--              LR Taxi Services "merged invoice" prints. Chosen per contract.
ALTER TABLE contracts ADD COLUMN arithmetic text NOT NULL DEFAULT 'standard' CHECK (arithmetic IN ('standard','lr_exact'));
