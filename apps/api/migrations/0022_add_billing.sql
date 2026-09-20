-- apps/api/migrations/0022_add_billing.sql
--
-- Billing state for the hosted instance. Inert on a self-hosted instance:
-- without Stripe configured, nothing writes these tables and quota resolution
-- falls straight through to instance defaults.

-- Limits per plan, so adding a tier later is an INSERT rather than a migration.
CREATE TABLE plans (
    id TEXT PRIMARY KEY,
    stripe_price_id_monthly TEXT,
    stripe_price_id_yearly TEXT,
    max_open_forms INTEGER NOT NULL,
    max_attachment_bytes BIGINT NOT NULL,
    max_responses_per_period INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Unlimited" on the paid tier is a ceiling high enough that no honest account
-- reaches it, not an absent limit. submit_response is rate limited at 100 per
-- form per minute, which is 144,000 a day, so an unbounded plan would let one
-- abusive form fill the disk. The free tier's cap is what stops anonymous
-- abuse; a paying abuser costs money and can be terminated.
INSERT INTO plans (
    id, max_open_forms, max_attachment_bytes, max_responses_per_period
) VALUES
    ('free', 10, 209715200, 250),
    ('pro', 1000, 5368709120, 100000);

-- One row per paying user. Mirrors Stripe rather than being authoritative:
-- Stripe is never consulted on a request path, so this is what enforcement
-- reads.
CREATE TABLE subscriptions (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL REFERENCES plans(id),
    stripe_customer_id TEXT NOT NULL,
    stripe_subscription_id TEXT,
    status TEXT NOT NULL,
    current_period_end TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A replayed webhook must not be able to attach one Stripe subscription to a
-- second krypta account.
CREATE UNIQUE INDEX subscriptions_stripe_subscription_idx
    ON subscriptions (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX subscriptions_stripe_customer_idx
    ON subscriptions (stripe_customer_id);

-- Responses counted per calendar month, UTC.
--
-- There is deliberately no reset job. A new month is a row that does not exist
-- yet, and a missing row counts as zero, so nothing has to run on a schedule
-- and nothing can fail to run.
--
-- The period is its own concept rather than Stripe's invoice period, because an
-- annual subscriber must still get a monthly allowance and a free account has
-- no Stripe subscription at all yet obeys the same rule.
CREATE TABLE response_usage (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period_start TIMESTAMPTZ NOT NULL,
    response_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, period_start)
);

-- Stripe retries, so every event id is recorded and a repeat is a no-op.
CREATE TABLE processed_stripe_events (
    id TEXT PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
