ALTER TABLE lattis_fakturownia_invoice ADD COLUMN IF NOT EXISTS sale_id char(36) NULL;
CREATE INDEX IF NOT EXISTS lattis_fakturownia_invoice_sale ON lattis_fakturownia_invoice(sale_id);
