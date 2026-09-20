-- apps/api/migrations/0023_add_allowance_warning.sql
--
-- Marks when an account was warned that it is approaching its monthly
-- response allowance, so the warning fires exactly once per period rather
-- than once per response past the threshold.

ALTER TABLE response_usage ADD COLUMN warned_at TIMESTAMPTZ;
