-- 0007_add_email_verified_at.sql
--
-- A users row exists only for a verified address, so this column is a record
-- of when, not a flag that gates access. Nothing queries it; keeping
-- verification out of the WHERE clauses is what stops a forgotten
-- "AND email_verified" from letting an unverified account through.
--
-- Rows created before verification existed are verified by definition, so they
-- backfill to their creation time rather than to now().
ALTER TABLE users
    ADD COLUMN email_verified_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE users SET email_verified_at = created_at;
