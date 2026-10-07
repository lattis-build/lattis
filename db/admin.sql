CREATE TABLE IF NOT EXISTS lattis_admin_secret (
  name text PRIMARY KEY,
  ciphertext text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lattis_admin_setting (
  setting_key text PRIMARY KEY,
  setting_value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
