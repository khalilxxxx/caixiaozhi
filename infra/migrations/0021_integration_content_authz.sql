-- 历史调用没有可信权限快照时禁止把旧正文重新注入模型，不能从当前 run 补写自证。
ALTER TABLE integration_invocations ADD COLUMN authz_version integer CHECK (authz_version > 0);
CREATE FUNCTION protect_invocation_content_authz() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.authz_version IS DISTINCT FROM OLD.authz_version THEN
  RAISE EXCEPTION 'invocation content authz version is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invocation_content_authz_immutable BEFORE UPDATE ON integration_invocations
 FOR EACH ROW EXECUTE FUNCTION protect_invocation_content_authz();
