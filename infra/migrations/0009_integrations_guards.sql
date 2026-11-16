CREATE TABLE integration_command_ledger (
 tenant_id text NOT NULL,actor_id text NOT NULL,operation text NOT NULL,idempotency_key text NOT NULL,
 payload_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 retain_until timestamptz NOT NULL DEFAULT (now()+interval '180 days'),
 PRIMARY KEY(tenant_id,actor_id,operation,idempotency_key)
);
CREATE FUNCTION protect_published_capability_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.published_at IS NOT NULL AND (
  NEW.definition IS DISTINCT FROM OLD.definition OR NEW.checksum IS DISTINCT FROM OLD.checksum OR
  NEW.semver IS DISTINCT FROM OLD.semver OR NEW.capability_id IS DISTINCT FROM OLD.capability_id OR
  NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id
 ) THEN RAISE EXCEPTION 'published capability version is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER integration_published_version_immutable BEFORE UPDATE ON integration_capability_versions
 FOR EACH ROW EXECUTE FUNCTION protect_published_capability_version();
