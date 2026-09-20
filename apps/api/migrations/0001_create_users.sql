-- 0001_create_users.sql
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
    id UUID PRIMARY KEY,
    email CITEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    master_key_salt TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
