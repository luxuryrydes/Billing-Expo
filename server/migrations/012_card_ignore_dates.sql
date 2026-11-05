-- A person can choose to use a rate card for a slip even though the slip's date is outside the card's dates (for example a card that
-- starts on 1 April 2026 used for an older slip). It is explicit, recorded, and shown as a warning on the bill.
ALTER TABLE slip_readings ADD COLUMN card_ignore_dates boolean NOT NULL DEFAULT false;
ALTER TABLE duties ADD COLUMN card_ignore_dates boolean NOT NULL DEFAULT false;
