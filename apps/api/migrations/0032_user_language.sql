-- The language a user's mail is written in.
--
-- Plaintext, like the address it is sent to: the server has to choose a
-- template before it sends, and the language says nothing about any form or
-- answer. It is set at signup from the language the browser was showing, and
-- changes when the user picks another one while signed in.
ALTER TABLE users
    ADD COLUMN language TEXT NOT NULL DEFAULT 'en'
    CHECK (language IN ('en', 'ar'));
