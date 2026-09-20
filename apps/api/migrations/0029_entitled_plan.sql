-- The plan an account's limits come from, given its subscription row.
--
-- Quota resolution used to take subscriptions.plan_id as it stood, so a
-- subscription that had never been paid for resolved to the paid plan. That
-- happens whenever Checkout completes with an asynchronous payment method
-- (a bank debit, say): Stripe finishes the session before the money arrives,
-- reporting payment_status 'unpaid', and the webhook recorded the plan
-- regardless.
--
-- An 'incomplete' subscription (nothing collected yet) and an
-- 'incomplete_expired' one (nothing ever collected) now resolve to free. Every
-- other status keeps the plan, 'past_due' and 'unpaid' included: those are
-- subscriptions that were paid for and are failing a renewal, and a card that
-- fails on Friday must not downgrade anyone before Monday's retry.
--
-- One definition, used by all three limit resolvers and by the plan the
-- billing panel reports, so the limits enforced and the plan shown cannot
-- disagree. A missing row (NULL plan and status) is free.
CREATE FUNCTION entitled_plan_id(status TEXT, plan_id TEXT) RETURNS TEXT
LANGUAGE SQL IMMUTABLE AS $$
    SELECT CASE
        WHEN status IN ('incomplete', 'incomplete_expired') THEN 'free'
        ELSE COALESCE(plan_id, 'free')
    END
$$;
