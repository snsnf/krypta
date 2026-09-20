-- 0002_create_forms.sql
CREATE TABLE forms (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title_ciphertext TEXT NOT NULL,
    schema_ciphertext TEXT NOT NULL,
    form_public_key TEXT NOT NULL,
    wrapped_form_private_key TEXT NOT NULL,
    wrapped_form_data_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX forms_owner_id_idx ON forms(owner_id);
