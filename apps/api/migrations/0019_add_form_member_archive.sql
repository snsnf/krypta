-- Per-member dashboard archiving.
--
-- Lives on form_members rather than forms because archiving is one person
-- clearing their own dashboard, not a statement about the form: an Owner
-- tidying up must not remove the form from an Editor's list. A timestamp
-- rather than a boolean so "archived when?" stays answerable.
--
-- Deliberately unrelated to accepting_responses / closes_at / max_responses:
-- an archived form's public link still works and still collects responses.
ALTER TABLE form_members ADD COLUMN archived_at TIMESTAMPTZ;
