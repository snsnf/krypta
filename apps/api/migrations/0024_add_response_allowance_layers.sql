-- apps/api/migrations/0024_add_response_allowance_layers.sql
--
-- Gives the response allowance the same three resolution layers the form and
-- attachment limits already had: an admin override per account, then the
-- plan, then the instance default.
--
-- Migration 0022 left the response allowance reading `plans` alone, which had
-- two consequences. An instance admin had no way to raise it for one account,
-- and a self-hosted instance with no Stripe configuration inherited the free
-- plan's 250 a month even though it had never had a response cap at all.
--
-- Both new columns are nullable, and NULL means "no cap". That is what
-- restores the pre-billing behaviour: an instance that never sets
-- `default_max_responses_per_period` never caps responses, and the plan layer
-- is skipped entirely when Stripe is not configured.
ALTER TABLE account_quotas ADD COLUMN max_responses INTEGER CHECK (
    max_responses IS NULL OR max_responses BETWEEN 0 AND 100000000
);

ALTER TABLE instance_settings ADD COLUMN default_max_responses_per_period INTEGER CHECK (
    default_max_responses_per_period IS NULL
    OR default_max_responses_per_period BETWEEN 0 AND 100000000
);
