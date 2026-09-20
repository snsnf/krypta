-- Per-member response notification preference and delivery watermark.
--
-- This lives on form_members rather than in the encrypted form schema because
-- it is a fact about one person and one form, and because a background task
-- has to read it. FormSettings is inside schema_ciphertext and the API cannot
-- read it at all.
ALTER TABLE form_members
  ADD COLUMN notify_on_response BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN last_notified_at TIMESTAMPTZ;

-- Owners opt in by default; collaborators stay at the column default so that
-- accepting an invitation never silently signs someone up for mail.
UPDATE form_members SET notify_on_response = true WHERE role = 'owner';

-- Covers the sweeper's predicate. Rows with notifications off are not indexed.
CREATE INDEX form_members_notify_idx ON form_members (last_notified_at)
  WHERE notify_on_response;
