CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DO $$
BEGIN
  CREATE TYPE user_role AS ENUM ('USER', 'ADMIN');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_token text,
  password_hash text,
  email varchar(255) UNIQUE,
  name varchar(255),
  avatar text,
  role user_role DEFAULT 'USER',
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(255) NOT NULL,
  is_public boolean DEFAULT false,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS favorites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_full_name varchar(255) NOT NULL,
  repo_meta jsonb,
  note text,
  collection_id uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS search_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query text NOT NULL,
  filters jsonb,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collections_user_id_idx ON collections(user_id);
CREATE INDEX IF NOT EXISTS favorites_user_id_idx ON favorites(user_id);
CREATE INDEX IF NOT EXISTS favorites_collection_id_idx ON favorites(collection_id);
CREATE INDEX IF NOT EXISTS search_history_user_id_idx ON search_history(user_id);

CREATE TABLE IF NOT EXISTS github_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label varchar(255),
  source varchar(64),
  github_user_id varchar(128),
  github_login varchar(255),
  avatar_url text,
  encrypted_token text NOT NULL,
  fingerprint varchar(64),
  enabled boolean DEFAULT true,
  status varchar(32) DEFAULT 'active',
  scopes text,
  core_limit integer,
  core_limit_remaining integer,
  core_limit_reset_at timestamp with time zone,
  search_limit integer,
  search_limit_remaining integer,
  search_limit_reset_at timestamp with time zone,
  cooldown_until timestamp with time zone,
  last_error text,
  last_used_at timestamp with time zone,
  last_checked_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT github_tokens_fingerprint_unique UNIQUE (fingerprint),
  CONSTRAINT github_tokens_github_user_id_unique UNIQUE (github_user_id)
);

CREATE INDEX IF NOT EXISTS github_tokens_enabled_idx ON github_tokens(enabled);
CREATE INDEX IF NOT EXISTS github_tokens_status_idx ON github_tokens(status);
CREATE INDEX IF NOT EXISTS github_tokens_github_user_id_idx ON github_tokens(github_user_id);

CREATE TABLE IF NOT EXISTS github_pool_config (
  id integer PRIMARY KEY DEFAULT 1,
  max_concurrency integer DEFAULT 4,
  parallel_search_pages integer DEFAULT 1,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT github_pool_config_single_row_check CHECK (id = 1)
);