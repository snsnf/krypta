-- Earlier development API processes could create a legacy form after the
-- additive sharing migration had already run. Its owner/key material is still
-- present in the legacy columns, so restore the canonical Owner membership
-- before assessing whether retirement is safe. A contradictory membership is
-- deliberately left for the guard below rather than silently rewritten.
INSERT INTO form_members (
  id, form_id, user_id, role, state, key_scheme,
  encrypted_form_data_key, encrypted_form_private_key, created_at, updated_at
)
SELECT
  f.id, f.id, f.owner_id, 'owner', 'active', 'master_wrap_v1',
  f.wrapped_form_data_key, f.wrapped_form_private_key, f.created_at, f.created_at
FROM forms f
JOIN users u ON u.id = f.owner_id
WHERE NOT EXISTS (
  SELECT 1
  FROM form_members m
  WHERE m.form_id = f.id AND m.role = 'owner'
)
ON CONFLICT (form_id, user_id) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM forms f
    LEFT JOIN form_members m ON m.form_id = f.id AND m.role = 'owner'
    GROUP BY f.id
    HAVING count(m.id) <> 1
  ) THEN
    RAISE EXCEPTION
      'cannot retire legacy form ownership: every form must have exactly one Owner membership'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

ALTER TABLE form_members
  DROP CONSTRAINT form_members_user_id_fkey,
  ADD CONSTRAINT form_members_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;

DROP INDEX IF EXISTS forms_owner_id_idx;

ALTER TABLE forms
  DROP CONSTRAINT IF EXISTS forms_owner_id_fkey,
  DROP COLUMN owner_id,
  DROP COLUMN wrapped_form_private_key,
  DROP COLUMN wrapped_form_data_key;
