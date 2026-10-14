-- The owner's approval of an invited address, carried from the invitation to
-- the membership it becomes.
--
-- A keyed BLAKE2b tag made in the owner's browser under a key derived from the
-- form private key, over the form id and the invited address. The server
-- cannot compute or check it; it only stores it and hands it back to the
-- owner's browser, which refuses to seal form keys to a member waiting for
-- them unless the tag verifies. Without it the server's list of members
-- waiting for keys was trusted as served, so anyone able to write this table
-- could add a member and receive the keys on the owner's next visit.
--
-- Nullable because invitations and memberships made before this column have
-- no tag, and because the server never needs one to authorise anything. A
-- 32-byte tag in unpadded base64 is 43 characters.
ALTER TABLE form_invitations
    ADD COLUMN approval_tag TEXT
    CHECK (approval_tag IS NULL OR char_length(approval_tag) BETWEEN 1 AND 64);

ALTER TABLE form_members
    ADD COLUMN approval_tag TEXT
    CHECK (approval_tag IS NULL OR char_length(approval_tag) BETWEEN 1 AND 64);
