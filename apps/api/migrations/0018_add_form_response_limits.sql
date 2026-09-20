-- Server-enforced response limits.
--
-- These are deliberately plaintext rather than part of the encrypted schema:
-- a limit the server cannot read is a limit the server cannot enforce, and an
-- unenforceable cap is not a cap. What this exposes is metadata of the same
-- kind as accepting_responses -- the server already knows the response count,
-- because responses are rows it stores.
--
-- NULL means "no limit" for both columns. Existing forms get NULL and behave
-- exactly as they did before.
ALTER TABLE forms
  ADD COLUMN closes_at TIMESTAMPTZ,
  ADD COLUMN max_responses INTEGER
    CHECK (max_responses IS NULL OR max_responses > 0);
