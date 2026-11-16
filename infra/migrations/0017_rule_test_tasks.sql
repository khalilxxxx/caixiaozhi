CREATE TABLE rule_test_tasks (
 tenant_id text NOT NULL REFERENCES identity_environments(tenant_id) ON DELETE CASCADE,
 id text NOT NULL,owner_id text NOT NULL,actor_context jsonb NOT NULL,authz_version integer NOT NULL,
 rule_id text NOT NULL,rule_version integer NOT NULL,draft_version_id text NOT NULL,draft_version integer NOT NULL,
 draft_hash text NOT NULL,compiled_hash text NOT NULL,mapping_hash text NOT NULL,mapping_snapshot_hash text NOT NULL,
 mapping_snapshot jsonb NOT NULL,test_set_id text NOT NULL CHECK(test_set_id='boundary-v1'),test_set_hash text NOT NULL,
 cases_json jsonb NOT NULL CHECK(jsonb_array_length(cases_json)=4),dedupe_key text NOT NULL,
 status text NOT NULL CHECK(status IN('queued','running','completed','failed','stale','cancelled')),
 total_cases integer NOT NULL DEFAULT 4 CHECK(total_cases=4),completed_cases integer NOT NULL DEFAULT 0 CHECK(completed_cases BETWEEN 0 AND 4),
 job_id text NOT NULL,origin_run_id text,proof_id text,error_code text,finished_at timestamptz,
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,rule_id) REFERENCES rule_definitions(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,draft_version_id) REFERENCES rule_versions(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,proof_id) REFERENCES rule_test_runs(tenant_id,id) ON DELETE CASCADE,
 CHECK((status='completed')=(proof_id IS NOT NULL)),CHECK(proof_id IS NULL OR proof_id=id)
);
CREATE UNIQUE INDEX rule_test_tasks_current ON rule_test_tasks(tenant_id,owner_id,dedupe_key) WHERE status IN('queued','running','completed');
CREATE INDEX rule_test_tasks_rule_idx ON rule_test_tasks(tenant_id,owner_id,rule_id,created_at,id);
CREATE FUNCTION protect_rule_test_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.actor_context<>OLD.actor_context OR
 NEW.authz_version<>OLD.authz_version OR NEW.rule_id<>OLD.rule_id OR NEW.rule_version<>OLD.rule_version OR
 NEW.draft_version_id<>OLD.draft_version_id OR NEW.draft_version<>OLD.draft_version OR NEW.draft_hash<>OLD.draft_hash OR
 NEW.compiled_hash<>OLD.compiled_hash OR NEW.mapping_hash<>OLD.mapping_hash OR NEW.mapping_snapshot_hash<>OLD.mapping_snapshot_hash OR
 NEW.mapping_snapshot<>OLD.mapping_snapshot OR NEW.test_set_id<>OLD.test_set_id OR NEW.test_set_hash<>OLD.test_set_hash OR
 NEW.cases_json<>OLD.cases_json OR NEW.dedupe_key<>OLD.dedupe_key OR NEW.job_id<>OLD.job_id OR
 NEW.origin_run_id IS DISTINCT FROM OLD.origin_run_id THEN RAISE EXCEPTION 'rule test snapshot is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rule_test_tasks_immutable BEFORE UPDATE ON rule_test_tasks FOR EACH ROW EXECUTE FUNCTION protect_rule_test_snapshot();
CREATE TRIGGER demo_generation_write_fence BEFORE INSERT OR UPDATE OR DELETE ON rule_test_tasks FOR EACH ROW EXECUTE FUNCTION assert_demo_tenant_write();
