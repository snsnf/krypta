-- Which response a claimed upload belongs to.
--
-- A claim used to be a timestamp and nothing else, so once a file was claimed
-- the server could not say whose it was. A respondent who replaced a file
-- while editing left the old one claimed, and only the ids a member's browser
-- sent when deleting the response could release anything. Each case held one
-- of the form's attachment slots and the owner's storage quota until the
-- response or the form was deleted.
--
-- submit_response and update_response now record the response here when they
-- claim an upload, so an edit releases the files it dropped and deleting a
-- response releases its files from this column rather than from a list the
-- client supplies. A header image is claimed with no response.
--
-- Nullable, and left null for every existing row: which response an earlier
-- claim belongs to is inside the ciphertext, so it cannot be backfilled. Those
-- rows keep the old behaviour and are released when a member deletes the
-- response that names them. ON DELETE SET NULL rather than CASCADE: deleting
-- a response releases its files explicitly first, through the path that
-- returns the form's counters, and a cascade would drop the rows without it.
ALTER TABLE attachments
    ADD COLUMN response_id UUID REFERENCES responses(id) ON DELETE SET NULL;

CREATE INDEX attachments_response_id_idx
    ON attachments(response_id)
    WHERE response_id IS NOT NULL;
