ALTER TABLE lattis_paynow_payment ADD COLUMN IF NOT EXISTS sale_id uuid;
CREATE INDEX IF NOT EXISTS lattis_paynow_payment_sale ON lattis_paynow_payment(sale_id);
