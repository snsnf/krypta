-- apps/api/migrations/0020_add_passkeys.sql
--
-- A passkey is the third way to open the vault. Its PRF output derives an
-- unlock key in the browser, which wraps the same account key the password and
-- the vault recovery code already wrap. Nothing below the account key is
-- re-encrypted, so every form key, grant and sharing key stays valid.
--
-- Two tables rather than one. Migration 0014 predicted a single table, before
-- it was clear that a credential carries authentication data (public key,
-- signature counter, backup state, transports) with nothing to do with key
-- wrapping. Splitting keeps `account_key_wrappers` a table about wrapping, and
-- the cascade below makes an orphan structurally impossible.
CREATE TABLE passkey_credentials (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Base64url, as the authenticator reports it. Globally unique, and the
    -- lookup key when an assertion names one of a user's credentials.
    credential_id TEXT NOT NULL,
    -- `webauthn_rs::prelude::Passkey` serialized whole, not decomposed into
    -- columns. This is forced rather than chosen: `Passkey`'s fields are
    -- pub(crate) and the crate exposes no constructor from parts, so a
    -- decomposed row could never be reassembled into the value
    -- `finish_discoverable_authentication` requires. A crate upgrade that adds
    -- a field to `Passkey` therefore needs no migration here.
    credential JSONB NOT NULL,
    nickname TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX passkey_credentials_credential_id_idx
    ON passkey_credentials (credential_id);

CREATE INDEX passkey_credentials_user_id_idx ON passkey_credentials (user_id);

-- Admit the third method.
ALTER TABLE account_key_wrappers
    DROP CONSTRAINT account_key_wrappers_method_check;
ALTER TABLE account_key_wrappers
    ADD CONSTRAINT account_key_wrappers_method_check
    CHECK (method IN ('password', 'recovery_code', 'passkey'));

-- Deleting a passkey removes the wrapper with it, so no wrapper can survive
-- the credential that opens it.
ALTER TABLE account_key_wrappers
    ADD COLUMN credential_id UUID
    REFERENCES passkey_credentials(id) ON DELETE CASCADE;

-- A passkey wrapper has a credential; the other two never do.
ALTER TABLE account_key_wrappers
    ADD CONSTRAINT account_key_wrappers_passkey_shape
    CHECK ((method = 'passkey') = (credential_id IS NOT NULL));

-- The old index was UNIQUE (user_id, method), which a passkey user would
-- violate on their second credential. It cannot simply gain credential_id as a
-- third column: PostgreSQL treats NULLs as distinct, so
-- UNIQUE (user_id, method, credential_id) would permit TWO password wrappers
-- for one user and silently break the "exactly two wrappers" invariant that
-- `ensure_verified_user` relies on. Two partial indexes instead.
DROP INDEX account_key_wrappers_user_method_idx;

CREATE UNIQUE INDEX account_key_wrappers_user_method_idx
    ON account_key_wrappers (user_id, method) WHERE credential_id IS NULL;

CREATE UNIQUE INDEX account_key_wrappers_credential_idx
    ON account_key_wrappers (credential_id) WHERE credential_id IS NOT NULL;
