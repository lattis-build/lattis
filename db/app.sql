CREATE TABLE IF NOT EXISTS lattis_role (
  id text PRIMARY KEY,
  description text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS lattis_role_grant (
  role_id text NOT NULL REFERENCES lattis_role(id) ON DELETE CASCADE,
  action text NOT NULL,
  resource_type text NOT NULL,
  PRIMARY KEY (role_id, action, resource_type)
);
CREATE TABLE IF NOT EXISTS lattis_user_role (
  user_id text NOT NULL,
  role_id text NOT NULL REFERENCES lattis_role(id) ON DELETE CASCADE,
  resource_id text NOT NULL DEFAULT '*',
  PRIMARY KEY (user_id, role_id, resource_id)
);
CREATE TABLE IF NOT EXISTS lattis_secret_ref (
  name text PRIMARY KEY,
  provider text NOT NULL,
  locator text NOT NULL,
  allowed_package text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lattis_service_token (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS lattis_audit (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  action text NOT NULL,
  resource text NOT NULL,
  result text NOT NULL,
  correlation_id text NOT NULL
);
CREATE TABLE IF NOT EXISTS lattis_immudb_outbox (
  audit_id bigint PRIMARY KEY REFERENCES lattis_audit(id),
  exported_at timestamptz,
  digest text
);
CREATE INDEX IF NOT EXISTS lattis_immudb_outbox_pending ON lattis_immudb_outbox(audit_id) WHERE exported_at IS NULL;
CREATE OR REPLACE FUNCTION lattis_audit_outbox_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO lattis_immudb_outbox(audit_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'lattis_audit_immudb_outbox' AND tgrelid = 'lattis_audit'::regclass) THEN
    CREATE TRIGGER lattis_audit_immudb_outbox AFTER INSERT ON lattis_audit FOR EACH ROW EXECUTE FUNCTION lattis_audit_outbox_insert();
  END IF;
END;
$$;
INSERT INTO lattis_immudb_outbox(audit_id) SELECT id FROM lattis_audit ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS lattis_module (
  name text PRIMARY KEY,
  version text NOT NULL,
  digest text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('node', 'shard')),
  installed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lattis_node_receipt (
  node_name text NOT NULL,
  principal_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  response jsonb NOT NULL,
  PRIMARY KEY (node_name, principal_id, idempotency_key)
);
INSERT INTO lattis_role (id, description) VALUES ('owner', 'Instance owner') ON CONFLICT DO NOTHING;
INSERT INTO lattis_role_grant (role_id, action, resource_type) VALUES
  ('owner', '*', '*') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS lattis_content_type (
  type_key text PRIMARY KEY,
  label text NOT NULL,
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lattis_content (
  id uuid PRIMARY KEY,
  type_key text NOT NULL REFERENCES lattis_content_type(type_key),
  slug text NOT NULL,
  title text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  excerpt text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('draft','published','archived')),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision integer NOT NULL DEFAULT 1,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (type_key, slug)
);
CREATE TABLE IF NOT EXISTS lattis_content_link (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES lattis_content(id) ON DELETE CASCADE,
  relation text NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('content','node','shard','media','external')),
  target_ref text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  UNIQUE (source_id, relation, target_kind, target_ref)
);
CREATE INDEX IF NOT EXISTS lattis_content_link_target ON lattis_content_link(target_kind, target_ref);
CREATE TABLE IF NOT EXISTS lattis_taxonomy_term (
  id uuid PRIMARY KEY,
  taxonomy text NOT NULL,
  slug text NOT NULL,
  label text NOT NULL,
  parent_id uuid REFERENCES lattis_taxonomy_term(id),
  source_system text,
  source_site text,
  external_id text,
  UNIQUE (taxonomy, slug)
);
CREATE UNIQUE INDEX IF NOT EXISTS lattis_term_source ON lattis_taxonomy_term(source_system,source_site,taxonomy,external_id);
CREATE TABLE IF NOT EXISTS lattis_content_term (
  content_id uuid NOT NULL REFERENCES lattis_content(id) ON DELETE CASCADE,
  term_id uuid NOT NULL REFERENCES lattis_taxonomy_term(id) ON DELETE CASCADE,
  PRIMARY KEY (content_id, term_id)
);
CREATE TABLE IF NOT EXISTS lattis_media (
  id uuid PRIMARY KEY,
  storage_ref text NOT NULL,
  mime_type text NOT NULL,
  alt_text text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_sha256 text,
  byte_count bigint,
  source_system text,
  source_site text,
  external_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE lattis_media ADD COLUMN IF NOT EXISTS content_sha256 text;
ALTER TABLE lattis_media ADD COLUMN IF NOT EXISTS byte_count bigint;
CREATE UNIQUE INDEX IF NOT EXISTS lattis_media_source ON lattis_media(source_system,source_site,external_id);
CREATE TABLE IF NOT EXISTS lattis_content_source (
  source_system text NOT NULL,
  source_site text NOT NULL,
  source_kind text NOT NULL,
  external_id text NOT NULL,
  content_id uuid NOT NULL REFERENCES lattis_content(id) ON DELETE CASCADE,
  source_digest text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_system, source_site, source_kind, external_id)
);
CREATE TABLE IF NOT EXISTS lattis_import_cursor (
  source_system text NOT NULL,
  source_site text NOT NULL,
  import_key text NOT NULL,
  cursor_value text,
  batch_digest text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_system, source_site, import_key)
);
CREATE TABLE IF NOT EXISTS lattis_import_user (
  id uuid PRIMARY KEY,
  source_site text NOT NULL,
  external_id text NOT NULL,
  email text NOT NULL,
  display_name text NOT NULL,
  source_roles jsonb NOT NULL DEFAULT '[]'::jsonb,
  claimed_user_id text,
  auth_mode text NOT NULL DEFAULT 'verified-email' CHECK (auth_mode IN ('verified-email','password')),
  legacy_password_ciphertext text,
  password_claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_site, external_id)
);
ALTER TABLE lattis_import_user ADD COLUMN IF NOT EXISTS legacy_password_ciphertext text;
ALTER TABLE lattis_import_user ADD COLUMN IF NOT EXISTS password_claimed_at timestamptz;
ALTER TABLE lattis_import_user ADD COLUMN IF NOT EXISTS auth_mode text NOT NULL DEFAULT 'verified-email';
CREATE INDEX IF NOT EXISTS lattis_import_user_email ON lattis_import_user(email);
CREATE INDEX IF NOT EXISTS lattis_import_user_claimed ON lattis_import_user(claimed_user_id);
CREATE TABLE IF NOT EXISTS lattis_video (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type = 'video/mp4'),
  byte_count bigint NOT NULL CHECK (byte_count > 0),
  content_sha256 text NOT NULL,
  storage_ref text,
  state text NOT NULL CHECK (state IN ('pending','ready')),
  download_ui text NOT NULL CHECK (download_ui IN ('show','hide')),
  protection_mode text NOT NULL CHECK (protection_mode IN ('access-controlled','drm-required')),
  watermark_mode text NOT NULL CHECK (watermark_mode IN ('off','forensic-required')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lattis_video_playback (
  id uuid PRIMARY KEY,
  video_id uuid NOT NULL REFERENCES lattis_video(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  viewer_ciphertext text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS lattis_video_playback_user ON lattis_video_playback(user_id,expires_at);
CREATE INDEX IF NOT EXISTS lattis_video_playback_expiry ON lattis_video_playback(expires_at);
CREATE TABLE IF NOT EXISTS lattis_video_package (
  id uuid PRIMARY KEY,
  video_id uuid NOT NULL REFERENCES lattis_video(id) ON DELETE CASCADE,
  container_format text NOT NULL CHECK (container_format = 'cmaf'),
  protection text NOT NULL CHECK (protection IN ('clear','drm')),
  encryption_scheme text CHECK (encryption_scheme IN ('cenc','cbcs')),
  watermark text NOT NULL CHECK (watermark IN ('off','forensic')),
  drm_provider_ref text,
  watermark_provider_ref text,
  storage_ref text NOT NULL,
  state text NOT NULL CHECK (state IN ('ready','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((protection = 'clear' AND encryption_scheme IS NULL AND drm_provider_ref IS NULL) OR (protection = 'drm' AND encryption_scheme IS NOT NULL AND drm_provider_ref IS NOT NULL)),
  CHECK ((watermark = 'off' AND watermark_provider_ref IS NULL) OR (watermark = 'forensic' AND watermark_provider_ref IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS lattis_video_package_video ON lattis_video_package(video_id,state,created_at);
CREATE TABLE IF NOT EXISTS lattis_content_author (
  content_id uuid PRIMARY KEY REFERENCES lattis_content(id) ON DELETE CASCADE,
  import_user_id uuid NOT NULL REFERENCES lattis_import_user(id)
);
