-- Account deletion is two transactions with object-store work between them.
-- The first commits an irreversible barrier (the account is marked, its
-- sessions revoked, its forms closed) and the destruction of form ciphertext
-- follows. The only audit row used to be written by the second, so a deletion
-- that failed in between left a destroyed account with nothing in the
-- append-only log to say an admin had started it.
--
-- 'account_deletion_started' is written in the same transaction as the
-- barrier, so the two become durable together; the second transaction still
-- records the terminal 'account_deleted' row.
ALTER TABLE admin_audit_events
    DROP CONSTRAINT admin_audit_events_action_check;

ALTER TABLE admin_audit_events
    ADD CONSTRAINT admin_audit_events_action_check CHECK (
        action IN (
            'settings_updated',
            'account_suspended',
            'account_reactivated',
            'form_transferred',
            'account_deletion_started',
            'account_deleted'
        )
    );
