-- Apply once, offline, with migration credentials after backing up the database.
-- MariaDB DDL commits implicitly; take a backup before starting this upgrade.
ALTER TABLE lattis_import_user ADD COLUMN IF NOT EXISTS source_system varchar(80) NULL;
UPDATE lattis_import_user SET source_system='wordpress' WHERE source_system IS NULL;
ALTER TABLE lattis_import_user MODIFY source_system varchar(80) NOT NULL;
ALTER TABLE lattis_import_user DROP INDEX IF EXISTS lattis_import_user_source;
ALTER TABLE lattis_import_user ADD UNIQUE KEY lattis_import_user_source (source_system,source_site,external_id);
UPDATE lattis_import_user SET auth_mode='verified-email' WHERE claimed_user_id IS NULL AND legacy_password_ciphertext LIKE 'v1:%';
