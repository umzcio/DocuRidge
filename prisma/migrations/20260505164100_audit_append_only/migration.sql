-- DocuRidge — append-only audit tables, enforced at the DB level.
-- See DECISIONS.md D-028 and SECURITY.md §3.6.
--
-- Approach: a BEFORE UPDATE/DELETE trigger that always raises. This is
-- strictly more portable than role-based REVOKEs (the migration role and
-- the app role are the same in v1), and equally tamper-proof from app code.
--
-- A future migration may relax these triggers under a documented retention
-- policy (e.g. permitting redaction tombstones for GDPR-style requests).

CREATE OR REPLACE FUNCTION docuridge_audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit table is append-only — % is not permitted', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_event_no_update ON audit_event;
DROP TRIGGER IF EXISTS audit_event_no_delete ON audit_event;
CREATE TRIGGER audit_event_no_update
  BEFORE UPDATE ON audit_event
  FOR EACH ROW
  EXECUTE FUNCTION docuridge_audit_immutable();
CREATE TRIGGER audit_event_no_delete
  BEFORE DELETE ON audit_event
  FOR EACH ROW
  EXECUTE FUNCTION docuridge_audit_immutable();

DROP TRIGGER IF EXISTS user_security_audit_event_no_update ON user_security_audit_event;
DROP TRIGGER IF EXISTS user_security_audit_event_no_delete ON user_security_audit_event;
CREATE TRIGGER user_security_audit_event_no_update
  BEFORE UPDATE ON user_security_audit_event
  FOR EACH ROW
  EXECUTE FUNCTION docuridge_audit_immutable();
CREATE TRIGGER user_security_audit_event_no_delete
  BEFORE DELETE ON user_security_audit_event
  FOR EACH ROW
  EXECUTE FUNCTION docuridge_audit_immutable();
