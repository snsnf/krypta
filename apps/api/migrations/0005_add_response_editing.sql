-- 0005_add_response_editing.sql
ALTER TABLE forms ADD COLUMN allow_response_editing BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE responses ADD COLUMN edit_token_hash TEXT NULL;
ALTER TABLE responses ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE UNIQUE INDEX responses_edit_token_hash_idx ON responses (edit_token_hash) WHERE edit_token_hash IS NOT NULL;
