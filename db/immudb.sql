CREATE TABLE IF NOT EXISTS lattis_audit_receipt (
  namespace VARCHAR[64] NOT NULL,
  audit_id INTEGER NOT NULL,
  digest VARCHAR[64] NOT NULL,
  PRIMARY KEY (namespace,audit_id)
);
