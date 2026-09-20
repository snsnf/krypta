-- An upload that finishes but is never referenced by a submitted response.
--
-- Uploads are anonymous and happen before the respondent submits, so a file
-- can reach 'ready' and then be abandoned: the tab is closed, or someone
-- uploads files to a public form with no intention of answering it. Such a
-- row used to hold one of the form's attachment slots and the owner's storage
-- quota until the whole form was deleted, because nothing ever moved a ready
-- row to cleanup except an owner deleting the response that named it, and an
-- unsubmitted upload has no response.
--
-- claimed_at has existed since 0004 and was never written. It now means "a
-- submitted response, or the form's header image, references this upload",
-- stamped by submit_response, update_response and update_form. The reaper
-- moves a ready row that is still unclaimed long after it completed into
-- cleanup_pending, where the existing release path returns the form counters
-- and the owner's bytes.
--
-- Every ready row that exists now predates the stamp and may well be
-- referenced, so all of them are marked claimed. Reaping one of those would
-- delete a file a stored response points at.
UPDATE attachments
SET claimed_at = COALESCE(upload_completed_at, now())
WHERE upload_state = 'ready'
  AND claimed_at IS NULL;

DROP INDEX IF EXISTS attachments_unclaimed_created_at_idx;

CREATE INDEX attachments_unclaimed_ready_idx
  ON attachments(upload_completed_at)
  WHERE upload_state = 'ready' AND claimed_at IS NULL;
