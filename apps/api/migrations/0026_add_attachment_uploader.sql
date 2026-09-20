-- Which editor uploaded an attachment, when one did.
--
-- Uploads are anonymous by design: a respondent has no session. But the form
-- header image is uploaded by an owner or editor from the dashboard, and the
-- public header route serves whatever forms.header_attachment_id names. With
-- nothing distinguishing the two kinds of upload, an editor could point that
-- column at a respondent's sealed attachment and have the public route serve
-- its ciphertext to anyone holding the form link. Ciphertext only, but a
-- route that exists to serve one image should not be turnable into a reader
-- for every response attachment on the form.
--
-- This column is stamped only when the upload carried a session belonging to
-- a member with edit rights on that form. update_form accepts a header
-- pointer only when it is set. Null means "uploaded anonymously", which is
-- what every respondent's attachment is. ON DELETE SET NULL: the row is a
-- record of who uploaded, not a dependency on them.
ALTER TABLE attachments
    ADD COLUMN uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL;
