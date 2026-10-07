CREATE TABLE IF NOT EXISTS lattis_paynow_payment (
  external_id uuid PRIMARY KEY,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 100 AND 100000000),
  currency char(3) NOT NULL CHECK (currency = 'PLN'),
  description varchar(255) NOT NULL,
  buyer_email_sealed varchar(256) NOT NULL,
  created_by text NOT NULL,
  paynow_payment_id varchar(16),
  redirect_url text,
  status varchar(20) NOT NULL CHECK (status IN ('QUEUED','UNKNOWN','BLOCKED','NEW','PENDING','CONFIRMED','REJECTED','ERROR','EXPIRED','ABANDONED')),
  provider_modified_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS lattis_paynow_payment_provider_id ON lattis_paynow_payment(paynow_payment_id);
CREATE INDEX IF NOT EXISTS lattis_paynow_payment_due ON lattis_paynow_payment(next_attempt_at,status);
