ALTER TABLE users
    ADD COLUMN session_generation BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN deletion_started_at TIMESTAMPTZ;

ALTER TABLE admin_audit_events
    DROP CONSTRAINT IF EXISTS admin_audit_events_actor_user_id_fkey,
    DROP CONSTRAINT IF EXISTS admin_audit_events_target_user_id_fkey;
