-- Seed the notification watermark for memberships that existed before response
-- notifications shipped.
--
-- 0016 turned notifications on for every owner but left last_notified_at NULL.
-- The sweep's watermark is COALESCE(last_notified_at, form_members.created_at),
-- so without this every pre-existing owner would be counted from the day they
-- joined and the first sweep after deploy would mail them their form's entire
-- response history. Stamping now() means an existing owner hears only about
-- responses that arrive after the upgrade.
UPDATE form_members
SET last_notified_at = now()
WHERE notify_on_response AND last_notified_at IS NULL;
