CREATE TABLE IF NOT EXISTS lattis_commerce_sale (
  sale_id uuid PRIMARY KEY,
  currency char(3) NOT NULL,
  scale smallint NOT NULL CHECK (scale BETWEEN 0 AND 3),
  total_minor bigint NOT NULL CHECK (total_minor > 0),
  snapshot_sealed text NOT NULL,
  snapshot_digest char(64) NOT NULL,
  status varchar(20) NOT NULL CHECK (status IN ('OPEN','CANCELLED','CLOSED')),
  fulfillment_status varchar(20) NOT NULL CHECK (fulfillment_status IN ('UNFULFILLED','PARTIAL','FULFILLED')),
  version integer NOT NULL CHECK (version > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lattis_commerce_link (
  sale_id uuid NOT NULL REFERENCES lattis_commerce_sale(sale_id),
  kind varchar(20) NOT NULL CHECK (kind IN ('payment','invoice','fulfillment','other')),
  provider varchar(64) NOT NULL,
  reference varchar(191) NOT NULL,
  provider_id varchar(191),
  status varchar(32) NOT NULL,
  amount_minor bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind,provider,reference)
);
CREATE INDEX IF NOT EXISTS lattis_commerce_link_sale ON lattis_commerce_link(sale_id,kind);
CREATE UNIQUE INDEX IF NOT EXISTS lattis_commerce_link_provider_id ON lattis_commerce_link(kind,provider,provider_id);
