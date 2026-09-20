-- Quiz mode.
--
-- Both columns hold ciphertext under a quiz key the browser derives from the
-- form private key. Respondents never hold that key, and neither does the
-- server, so it stores these as opaque bytes like every other ciphertext.
--
-- The answer key lives on the form row because it describes the questions:
-- update_form writes it in the same statement and under the same version as
-- schema_ciphertext, so the two can never be saved apart. Null means the form
-- has never been a quiz. get_form_public must never select it.
ALTER TABLE forms ADD COLUMN answer_key_ciphertext TEXT;

-- Manual grades, one blob per form rather than one per response, so the
-- server learns only that grades changed, never which response was graded or
-- how many were. Versioned on its own: grading happens on the Responses tab,
-- often while someone edits the form, and sharing the form's version would
-- turn every grade into a conflict for the editor.
CREATE TABLE form_grades (
    form_id UUID PRIMARY KEY REFERENCES forms(id) ON DELETE CASCADE,
    ciphertext TEXT NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
