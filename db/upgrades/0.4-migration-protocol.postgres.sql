-- Apply once, offline, with migration credentials after backing up the database.
-- Existing source identities belong to the previous WordPress-only importer.
BEGIN;
ALTER TABLE lattis_import_user ADD COLUMN IF NOT EXISTS source_system text;
UPDATE lattis_import_user SET source_system='wordpress' WHERE source_system IS NULL;
ALTER TABLE lattis_import_user ALTER COLUMN source_system SET NOT NULL;
ALTER TABLE lattis_import_user DROP CONSTRAINT IF EXISTS lattis_import_user_source_site_external_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS lattis_import_user_source ON lattis_import_user(source_system,source_site,external_id);
-- v1 credentials require reimport through a separately deployed verifier adapter.
-- Keep the old encrypted values for operator recovery; do not authenticate with them.
UPDATE lattis_import_user SET auth_mode='verified-email' WHERE claimed_user_id IS NULL AND legacy_password_ciphertext LIKE 'v1:%';
COMMIT;
