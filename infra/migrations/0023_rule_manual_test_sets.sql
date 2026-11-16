CREATE TABLE rule_test_sets (
 tenant_id text NOT NULL REFERENCES identity_environments(tenant_id) ON DELETE CASCADE,
 id text NOT NULL CHECK(id ~ '^rts-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
 owner_id text NOT NULL,rule_id text NOT NULL,rule_version integer NOT NULL CHECK(rule_version>0),
 draft_version_id text NOT NULL,draft_version integer NOT NULL CHECK(draft_version>0),draft_hash text NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 cases_json jsonb NOT NULL CHECK(jsonb_typeof(cases_json)='array' AND jsonb_array_length(cases_json) BETWEEN 4 AND 100),
 test_set_hash text NOT NULL CHECK(test_set_hash ~ '^[0-9a-f]{64}$'),
 content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,rule_id) REFERENCES rule_definitions(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,draft_version_id) REFERENCES rule_versions(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX rule_test_sets_owner_idx ON rule_test_sets(tenant_id,owner_id,rule_id,created_at,id);
CREATE FUNCTION protect_rule_test_set() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'rule test set is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rule_test_sets_immutable BEFORE UPDATE ON rule_test_sets FOR EACH ROW EXECUTE FUNCTION protect_rule_test_set();
CREATE TRIGGER demo_generation_write_fence BEFORE INSERT OR UPDATE OR DELETE ON rule_test_sets FOR EACH ROW EXECUTE FUNCTION assert_demo_tenant_write();

ALTER TABLE rule_test_tasks DROP CONSTRAINT rule_test_tasks_test_set_id_check;
ALTER TABLE rule_test_tasks DROP CONSTRAINT rule_test_tasks_cases_json_check;
ALTER TABLE rule_test_tasks DROP CONSTRAINT rule_test_tasks_total_cases_check;
ALTER TABLE rule_test_tasks DROP CONSTRAINT rule_test_tasks_completed_cases_check;
ALTER TABLE rule_test_tasks ADD CONSTRAINT rule_test_tasks_test_set_id_check CHECK(
 test_set_id='boundary-v1' OR test_set_id ~ '^rts-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
ALTER TABLE rule_test_tasks ADD CONSTRAINT rule_test_tasks_cases_json_check CHECK(
 jsonb_typeof(cases_json)='array' AND jsonb_array_length(cases_json)=total_cases);
ALTER TABLE rule_test_tasks ADD CONSTRAINT rule_test_tasks_total_cases_check CHECK(
 total_cases BETWEEN 4 AND 100 AND (test_set_id<>'boundary-v1' OR total_cases=4));
ALTER TABLE rule_test_tasks ADD CONSTRAINT rule_test_tasks_completed_cases_check CHECK(completed_cases BETWEEN 0 AND total_cases);
CREATE OR REPLACE FUNCTION protect_rule_test_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.actor_context<>OLD.actor_context OR
 NEW.authz_version<>OLD.authz_version OR NEW.rule_id<>OLD.rule_id OR NEW.rule_version<>OLD.rule_version OR
 NEW.draft_version_id<>OLD.draft_version_id OR NEW.draft_version<>OLD.draft_version OR NEW.draft_hash<>OLD.draft_hash OR
 NEW.compiled_hash<>OLD.compiled_hash OR NEW.mapping_hash<>OLD.mapping_hash OR NEW.mapping_snapshot_hash<>OLD.mapping_snapshot_hash OR
 NEW.mapping_snapshot<>OLD.mapping_snapshot OR NEW.test_set_id<>OLD.test_set_id OR NEW.test_set_hash<>OLD.test_set_hash OR
 NEW.cases_json<>OLD.cases_json OR NEW.total_cases<>OLD.total_cases OR NEW.dedupe_key<>OLD.dedupe_key OR NEW.job_id<>OLD.job_id OR
 NEW.origin_run_id IS DISTINCT FROM OLD.origin_run_id THEN RAISE EXCEPTION 'rule test snapshot is immutable'; END IF;
 RETURN NEW;
END $$;
