-- 0003_create_responses.sql
CREATE TABLE responses (
    id UUID PRIMARY KEY,
    form_id UUID NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    ciphertext TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX responses_form_id_idx ON responses(form_id);
