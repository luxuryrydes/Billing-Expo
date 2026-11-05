-- Payment tracking: Draft -> Approved -> Sent (submitted) -> Paid. Paying a bill changes nothing about its amounts, so the
-- protection of approved bills is untouched; paid_at is set when the money arrives and can be cleared if it was marked by mistake.
ALTER TABLE bills ADD COLUMN paid_at date;
ALTER TABLE bills ADD COLUMN paid_by uuid REFERENCES app_users(id);
ALTER TABLE bills ADD COLUMN payment_ref text;
