ALTER TABLE users
  ADD COLUMN sharing_public_key TEXT,
  ADD COLUMN wrapped_sharing_private_key TEXT,
  ADD COLUMN sharing_key_version SMALLINT,
  ADD COLUMN sharing_key_created_at TIMESTAMPTZ,
  ADD CONSTRAINT users_sharing_key_complete CHECK (
    (sharing_public_key IS NULL AND wrapped_sharing_private_key IS NULL
      AND sharing_key_version IS NULL AND sharing_key_created_at IS NULL)
    OR
    (sharing_public_key IS NOT NULL AND wrapped_sharing_private_key IS NOT NULL
      AND sharing_key_version = 1 AND sharing_key_created_at IS NOT NULL)
  );

ALTER TABLE forms
  ADD COLUMN version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN accepting_responses BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE form_members (
  id UUID PRIMARY KEY,
  form_id UUID NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  state TEXT NOT NULL CHECK (state IN ('active', 'awaiting_keys')),
  key_scheme TEXT CHECK (key_scheme IN ('master_wrap_v1', 'account_sealed_box_v1')),
  encrypted_form_data_key TEXT,
  encrypted_form_private_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (form_id, user_id),
  CHECK (role <> 'owner' OR state = 'active'),
  CHECK (
    (state = 'awaiting_keys' AND key_scheme IS NULL
      AND encrypted_form_data_key IS NULL AND encrypted_form_private_key IS NULL)
    OR
    (state = 'active' AND key_scheme IS NOT NULL
      AND encrypted_form_data_key IS NOT NULL AND encrypted_form_private_key IS NOT NULL)
  )
);

CREATE UNIQUE INDEX form_members_one_owner_idx
  ON form_members(form_id) WHERE role = 'owner';
CREATE INDEX form_members_user_idx ON form_members(user_id, created_at DESC);

INSERT INTO form_members (
  id, form_id, user_id, role, state, key_scheme,
  encrypted_form_data_key, encrypted_form_private_key, created_at, updated_at
)
SELECT id, id, owner_id, 'owner', 'active', 'master_wrap_v1',
       wrapped_form_data_key, wrapped_form_private_key, created_at, created_at
FROM forms;

CREATE TABLE form_invitations (
  id UUID PRIMARY KEY,
  form_id UUID NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  invited_email CITEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  status TEXT NOT NULL CHECK (
    status IN ('sending', 'pending', 'delivery_failed', 'accepted', 'revoked', 'expired')
  ),
  token_hash TEXT,
  recipient_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  recipient_sharing_public_key TEXT,
  encrypted_form_data_key TEXT,
  encrypted_form_private_key TEXT,
  expires_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (recipient_sharing_public_key IS NULL
      AND encrypted_form_data_key IS NULL AND encrypted_form_private_key IS NULL)
    OR
    (recipient_sharing_public_key IS NOT NULL
      AND encrypted_form_data_key IS NOT NULL AND encrypted_form_private_key IS NOT NULL)
  ),
  CHECK (
    (status IN ('sending', 'pending') AND token_hash IS NOT NULL AND expires_at IS NOT NULL)
    OR
    (status IN ('delivery_failed', 'accepted', 'revoked', 'expired') AND token_hash IS NULL)
  )
);

CREATE UNIQUE INDEX form_invitations_open_email_idx
  ON form_invitations(form_id, invited_email)
  WHERE status IN ('sending', 'pending', 'delivery_failed');
CREATE UNIQUE INDEX form_invitations_token_hash_idx
  ON form_invitations(token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX form_invitations_expiry_idx
  ON form_invitations(expires_at) WHERE status IN ('sending', 'pending');
