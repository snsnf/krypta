DELETE FROM instance_settings
WHERE id = TRUE
  AND registration_enabled = TRUE
  AND register_rate_limit_per_hour = 5
  AND login_rate_limit_per_minute = 5
  AND default_max_forms = 100
  AND default_max_attachment_bytes = 1073741824;

CREATE FUNCTION forbid_admin_audit_events_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'admin_audit_events is append-only'
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER admin_audit_events_no_update
    BEFORE UPDATE ON admin_audit_events
    FOR EACH ROW
    EXECUTE FUNCTION forbid_admin_audit_events_mutation();

CREATE TRIGGER admin_audit_events_no_delete
    BEFORE DELETE ON admin_audit_events
    FOR EACH ROW
    EXECUTE FUNCTION forbid_admin_audit_events_mutation();

CREATE TRIGGER admin_audit_events_no_truncate
    BEFORE TRUNCATE ON admin_audit_events
    FOR EACH STATEMENT
    EXECUTE FUNCTION forbid_admin_audit_events_mutation();
