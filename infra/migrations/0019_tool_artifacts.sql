CREATE TABLE tool_artifacts (
 tenant_id text NOT NULL,id text NOT NULL,owner_id text NOT NULL,run_id text NOT NULL,lease_epoch bigint NOT NULL,
 authz_version bigint NOT NULL,object_key text NOT NULL UNIQUE,sha256 text NOT NULL,size_bytes integer NOT NULL CHECK(size_bytes>0 AND size_bytes<=20971520),
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT(now()+interval '90 days'),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(run_id) REFERENCES agent_runs(id)
);
CREATE TRIGGER demo_generation_write_fence BEFORE INSERT OR UPDATE OR DELETE ON tool_artifacts FOR EACH ROW EXECUTE FUNCTION assert_demo_tenant_write();
