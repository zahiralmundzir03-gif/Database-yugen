CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS yn_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(32) NOT NULL UNIQUE,
  email VARCHAR(254) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'basic' CHECK (role IN ('basic','vip','developers','owner')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login TIMESTAMPTZ,
  role_expires_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS yn_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by UUID REFERENCES yn_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS yn_reports (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES yn_users(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS yn_reports_user_idx ON yn_reports(user_id,created_at DESC);

ALTER TABLE yn_users ADD COLUMN IF NOT EXISTS role_expires_at TIMESTAMPTZ;
