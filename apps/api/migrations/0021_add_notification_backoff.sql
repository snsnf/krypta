-- apps/api/migrations/0021_add_notification_backoff.sql
--
-- Stops one undeliverable address from starving everyone else's notifications.
--
-- The sweep selects due members ordered by last_notified_at ASC NULLS FIRST,
-- and the send lives inside a transaction so a failure rolls back and the next
-- sweep retries rather than silently dropping the notification. Those two facts
-- combine badly: a rollback never advances last_notified_at, so a permanently
-- failing address sorts to the head of the ordering again on every sweep,
-- forever. Once more than a batch of them accumulates they consume the whole
-- LIMIT and no healthy member is ever reached.
--
-- The fix is a backoff, not a drop. `notify_retry_after` takes the member out
-- of the candidate set until it elapses, which is what frees the batch, while
-- the retry itself is preserved because a dropped notification is the thing
-- this feature exists to prevent. A genuinely dead address settles at the cap
-- of one attempt per day rather than being abandoned.
ALTER TABLE form_members
    ADD COLUMN notify_failure_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN notify_retry_after TIMESTAMPTZ;

-- The candidate query now also filters on notify_retry_after, so the old index
-- over last_notified_at alone no longer covers it.
DROP INDEX form_members_notify_idx;

CREATE INDEX form_members_notify_idx
    ON form_members (notify_retry_after, last_notified_at)
    WHERE notify_on_response;
