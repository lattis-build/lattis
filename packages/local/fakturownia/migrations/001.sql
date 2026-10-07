CREATE TABLE IF NOT EXISTS lattis_fakturownia_invoice (
  external_id uuid PRIMARY KEY,
  gross_minor bigint NOT NULL CHECK (gross_minor > 0),
  currency char(3) NOT NULL CHECK (currency = 'PLN'),
  payload_sealed text NOT NULL,
  payload_digest char(64) NOT NULL,
  created_by text NOT NULL,
  status varchar(20) NOT NULL CHECK (status IN ('QUEUED','IN_FLIGHT','NEEDS_REVIEW','BLOCKED','ISSUED')),
  fakturownia_id bigint UNIQUE,
  invoice_number varchar(100),
  last_error varchar(100),
  attempt_count integer NOT NULL DEFAULT 0,
  attempted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lattis_fakturownia_invoice_status ON lattis_fakturownia_invoice(status,created_at);
