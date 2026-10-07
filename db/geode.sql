CREATE TABLE IF NOT EXISTS geode_publisher (
  slug text PRIMARY KEY,
  display_name text NOT NULL,
  public_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS geode_token (
  id uuid PRIMARY KEY,
  publisher_slug text REFERENCES geode_publisher(slug),
  subject text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  audience text NOT NULL CHECK (audience = 'geode-api'),
  scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS geode_mcp_identity (
  issuer text NOT NULL,
  subject text NOT NULL,
  publisher_slug text NOT NULL REFERENCES geode_publisher(slug),
  PRIMARY KEY (issuer, subject)
);
CREATE TABLE IF NOT EXISTS geode_package (
  name text PRIMARY KEY,
  publisher_slug text NOT NULL REFERENCES geode_publisher(slug),
  kind text NOT NULL CHECK (kind IN ('node', 'shard')),
  description text NOT NULL DEFAULT '',
  visibility text NOT NULL CHECK (visibility IN ('public', 'private')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS geode_version (
  package_name text NOT NULL REFERENCES geode_package(name),
  version text NOT NULL,
  digest text NOT NULL,
  manifest jsonb NOT NULL,
  publisher_public_key text NOT NULL,
  signature text NOT NULL,
  byte_count integer NOT NULL,
  state text NOT NULL CHECK (state IN ('quarantined', 'admitted', 'deprecated', 'revoked')),
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (package_name, version)
);
CREATE TABLE IF NOT EXISTS geode_offer (
  id uuid PRIMARY KEY,
  package_name text NOT NULL REFERENCES geode_package(name),
  model text NOT NULL CHECK (model IN ('free', 'one-time', 'subscription')),
  amount_minor integer,
  currency char(3),
  terms text NOT NULL DEFAULT '',
  CHECK ((model = 'free' AND amount_minor IS NULL AND currency IS NULL) OR
         (model <> 'free' AND amount_minor >= 0 AND currency IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS geode_entitlement (
  id uuid PRIMARY KEY,
  package_name text NOT NULL REFERENCES geode_package(name),
  subject text NOT NULL,
  source text NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS geode_audit (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  action text NOT NULL,
  resource text NOT NULL,
  result text NOT NULL,
  correlation_id text NOT NULL
);
CREATE TABLE IF NOT EXISTS geode_idempotency (
  actor text NOT NULL,
  operation text NOT NULL,
  key text NOT NULL,
  request_digest text NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (actor, operation, key)
);

-- Upgrade existing registries fail-closed: legacy publication is not admission.
ALTER TABLE geode_version DROP CONSTRAINT IF EXISTS geode_version_state_check;
UPDATE geode_version SET state='quarantined' WHERE state='published';
ALTER TABLE geode_version ADD CONSTRAINT geode_version_state_check CHECK (state IN ('quarantined','admitted','deprecated','revoked'));
CREATE TABLE IF NOT EXISTS geode_admission (
  package_name text NOT NULL, version text NOT NULL, artifact_digest text NOT NULL,
  admission_digest text NOT NULL, catalog_digest text NOT NULL, evidence jsonb NOT NULL,
  admitted_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  PRIMARY KEY (package_name,version),
  FOREIGN KEY (package_name,version) REFERENCES geode_version(package_name,version)
);
