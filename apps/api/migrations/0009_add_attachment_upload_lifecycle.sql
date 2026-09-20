ALTER TABLE forms
  ADD COLUMN deletion_started_at TIMESTAMPTZ;

ALTER TABLE attachments
  ADD COLUMN upload_state TEXT NOT NULL DEFAULT 'ready',
  ADD COLUMN upload_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN upload_completed_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN lifecycle_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD CONSTRAINT attachments_upload_state_check CHECK (
    (upload_state = 'uploading' AND upload_completed_at IS NULL)
    OR (upload_state = 'ready' AND upload_completed_at IS NOT NULL)
    OR upload_state = 'cleanup_pending'
  );

UPDATE attachments
SET upload_started_at = created_at,
    upload_completed_at = created_at,
    lifecycle_updated_at = created_at;

CREATE INDEX attachments_form_upload_state_idx
  ON attachments(form_id, upload_state);

CREATE INDEX attachments_cleanup_lifecycle_idx
  ON attachments(upload_state, lifecycle_updated_at)
  WHERE upload_state IN ('uploading', 'cleanup_pending');
