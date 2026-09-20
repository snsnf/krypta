-- TOTP second factor.
--
-- The secret must be readable by the server to verify codes, so unlike user
-- content it is not encrypted client-side. It is an authentication factor, not
-- form data, so this does not widen what the server can learn about responses.
ALTER TABLE users
    ADD COLUMN totp_secret BYTEA,
    ADD COLUMN totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Single-use recovery codes, stored as Argon2 hashes so a database read does
-- not yield usable codes. `used_at` is set rather than the row deleted, so a
-- replay is distinguishable from an unknown code.
CREATE TABLE totp_recovery_codes (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX totp_recovery_codes_user_id_idx ON totp_recovery_codes (user_id);
