-- The one Stripe Checkout Session an account may have open.
--
-- checkout refused a second subscription by reading subscriptions, a row only
-- the checkout.session.completed webhook writes, so every session created
-- before the first webhook landed passed the check. Two clicks, two tabs or a
-- replayed request could each open a live session, and completing both
-- charged twice while the upsert kept only one subscription id, leaving the
-- other billing and invisible to the app.
--
-- checkout now locks this row, expires the session it names if it is still
-- open, refuses if it has already been paid, and records the session it
-- creates. The webhook removes the row once that session completes. The lock
-- is on this row rather than on users on purpose: every submission to the
-- account's forms locks the users row, and those must not wait on a call to
-- Stripe.
CREATE TABLE pending_checkouts (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    stripe_session_id TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
