-- A collaborator's pin of the key a shared form seals to.
--
-- A keyed BLAKE2b tag made in the member's browser under a key derived from
-- their account key, over the form id and the key fingerprint from their
-- invitation email. The member's browser refuses a sealed grant whose private
-- key does not match it, so a party able to write this table cannot hand a
-- member a private key of their own: a sealed grant authenticates no sender,
-- and without the pin nothing tied the key in it to the form's real one.
--
-- The server cannot compute or check it; it stores it with the acceptance and
-- returns it with the grant. Nullable because an owner's grant is wrapped
-- under their own account key and needs no pin, and because memberships
-- accepted before this column have none: those are refused until the owner
-- removes and re-invites the member. A 32-byte tag in unpadded base64 is 43
-- characters.
ALTER TABLE form_members
    ADD COLUMN key_pin TEXT
    CHECK (key_pin IS NULL OR char_length(key_pin) BETWEEN 1 AND 64);
