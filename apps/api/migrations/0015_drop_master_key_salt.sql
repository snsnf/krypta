-- Unlock-key salts are now derived in the browser from the email
-- (BLAKE2b-128("krypta-vault-salt-v1" || lowercase(email))), so the server no
-- longer stores or serves one. Dropping the column keeps the schema honest
-- about what the server holds.
ALTER TABLE users DROP COLUMN master_key_salt;
