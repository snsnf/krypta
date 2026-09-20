-- A form's header image is an ordinary attachment, pointed at from the form.
--
-- The pointer lives here rather than only inside the encrypted schema because
-- the public download route has to authorise a request without decrypting
-- anything: it serves the bytes only when the id asked for is the one this
-- column names. Without that, a public route would have to serve any
-- attachment id belonging to the form, which would expose response
-- attachments to anyone holding a form link.
--
-- The bytes themselves stay opaque to the server, encrypted under the schema
-- key that only ever travels in the link fragment.
--
-- ON DELETE SET NULL rather than CASCADE: losing the image should clear the
-- reference, never take the form with it.
ALTER TABLE forms
    ADD COLUMN header_attachment_id UUID REFERENCES attachments(id) ON DELETE SET NULL;
