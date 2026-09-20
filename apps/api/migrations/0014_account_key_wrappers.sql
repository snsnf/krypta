-- apps/api/migrations/0014_account_key_wrappers.sql
--
-- The account key is 32 random bytes generated in the browser. It wraps every
-- form key and the account sharing private key. Each row here is that same
-- account key sealed under one unlock key, so a user can open their vault with
-- any enrolled method.
--
-- A table rather than columns on `users` because passkeys are one-to-many
-- (a credential per device). Adding them later relaxes the unique index to
-- (user_id, method, credential_id) and needs no change to existing rows.
--
-- No salt column: unlock-key salts are derived from the email, because a
-- random salt would need a pre-authentication lookup endpoint and that endpoint
-- is an account-enumeration oracle.
CREATE TABLE account_key_wrappers (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    method TEXT NOT NULL CHECK (method IN ('password', 'recovery_code')),
    wrapped_account_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX account_key_wrappers_user_method_idx
    ON account_key_wrappers (user_id, method);

-- Distinct from `totp_recovery_codes`, and named differently on purpose. These
-- restore *decryption*; TOTP recovery codes restore *account access* and are
-- useless for decryption. Storing the Argon2 hash of the client-computed
-- verifier means a database read yields neither the code nor any unlock key.
--
-- `used_at` is set rather than the row deleted, so a replay is distinguishable
-- from an unknown code. The partial unique index keeps exactly one live code
-- per account while retaining spent rows.
CREATE TABLE vault_recovery_codes (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    verifier_hash TEXT NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX vault_recovery_codes_user_id_idx ON vault_recovery_codes (user_id);

CREATE UNIQUE INDEX vault_recovery_codes_active_idx
    ON vault_recovery_codes (user_id) WHERE used_at IS NULL;
