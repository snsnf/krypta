ALTER TABLE forms
    ADD COLUMN attachment_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN attachment_bytes BIGINT NOT NULL DEFAULT 0;

CREATE TABLE attachments (
    id UUID PRIMARY KEY,
    form_id UUID NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_at TIMESTAMPTZ
);

CREATE INDEX attachments_form_id_idx ON attachments(form_id);
CREATE INDEX attachments_unclaimed_created_at_idx ON attachments(created_at) WHERE claimed_at IS NULL;
