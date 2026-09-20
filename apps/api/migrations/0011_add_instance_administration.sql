ALTER TABLE users
    ADD COLUMN instance_admin BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN suspended_at TIMESTAMPTZ;

CREATE TABLE instance_bootstrap (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    claimed_user_id UUID UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
    claimed_at TIMESTAMPTZ,
    CONSTRAINT instance_bootstrap_claim_consistency CHECK (
        (claimed_user_id IS NULL AND claimed_at IS NULL)
        OR (claimed_user_id IS NOT NULL AND claimed_at IS NOT NULL)
    )
);

INSERT INTO instance_bootstrap (id) VALUES (TRUE);

CREATE TABLE instance_settings (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    registration_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    register_rate_limit_per_hour INTEGER NOT NULL
        CHECK (register_rate_limit_per_hour BETWEEN 1 AND 1000),
    login_rate_limit_per_minute INTEGER NOT NULL
        CHECK (login_rate_limit_per_minute BETWEEN 1 AND 1000),
    default_max_forms INTEGER NOT NULL
        CHECK (default_max_forms BETWEEN 1 AND 100000),
    default_max_attachment_bytes BIGINT NOT NULL
        CHECK (default_max_attachment_bytes BETWEEN 0 AND 1099511627776),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO instance_settings (
    id,
    register_rate_limit_per_hour,
    login_rate_limit_per_minute,
    default_max_forms,
    default_max_attachment_bytes
) VALUES (
    TRUE,
    5,
    5,
    100,
    1073741824
);

CREATE TABLE account_quotas (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    max_forms INTEGER CHECK (
        max_forms IS NULL OR max_forms BETWEEN 1 AND 100000
    ),
    max_attachment_bytes BIGINT CHECK (
        max_attachment_bytes IS NULL
        OR max_attachment_bytes BETWEEN 0 AND 1099511627776
    ),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE account_usage (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    forms_used INTEGER NOT NULL DEFAULT 0 CHECK (forms_used >= 0),
    attachment_bytes_used BIGINT NOT NULL DEFAULT 0 CHECK (attachment_bytes_used >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_audit_events (
    id UUID PRIMARY KEY,
    actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    target_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    action TEXT NOT NULL CHECK (
        action IN (
            'settings_updated',
            'account_suspended',
            'account_reactivated',
            'form_transferred',
            'account_deleted'
        )
    ),
    result TEXT NOT NULL CHECK (
        result IN ('succeeded', 'rejected', 'failed')
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX admin_audit_events_created_at_id_idx
    ON admin_audit_events (created_at DESC, id DESC);
