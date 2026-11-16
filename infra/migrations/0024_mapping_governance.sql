CREATE TABLE field_mapping_definitions (
 tenant_id text NOT NULL REFERENCES identity_environments(tenant_id) ON DELETE CASCADE,
 id text NOT NULL,owner_id text NOT NULL,name text NOT NULL,department_ids jsonb NOT NULL,
 provider text NOT NULL,source_schema_version text NOT NULL,module text NOT NULL CHECK(module IN('expense_claim','travel','oa_request')),
 current_version_id text,draft_version_id text,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,provider,source_schema_version,module),
 CHECK(jsonb_typeof(department_ids)='array' AND jsonb_array_length(department_ids)>0)
);
CREATE TABLE field_mapping_drafts (
 tenant_id text NOT NULL,id text NOT NULL,mapping_id text NOT NULL,version_number integer NOT NULL,
 name text NOT NULL,department_ids jsonb NOT NULL,mapping_json jsonb NOT NULL,content_hash text NOT NULL,
 created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,mapping_id,version_number),
 FOREIGN KEY(tenant_id,mapping_id) REFERENCES field_mapping_definitions(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE field_mapping_sample_runs (
 tenant_id text NOT NULL,id text NOT NULL,mapping_id text NOT NULL,owner_id text NOT NULL,authz_version integer NOT NULL,
 definition_version integer NOT NULL,draft_id text NOT NULL,draft_hash text NOT NULL,base_current_version_id text,
 mapping_revision integer NOT NULL,mapping_snapshot_hash text NOT NULL,cases_json jsonb NOT NULL,
 test_set_hash text NOT NULL,results jsonb NOT NULL,passed boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,mapping_id) REFERENCES field_mapping_definitions(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,draft_id) REFERENCES field_mapping_drafts(tenant_id,id) ON DELETE CASCADE
);
CREATE FUNCTION protect_mapping_governance_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'mapping version and sample proof are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mapping_draft_immutable BEFORE UPDATE ON field_mapping_drafts FOR EACH ROW EXECUTE FUNCTION protect_mapping_governance_snapshot();
CREATE TRIGGER mapping_sample_immutable BEFORE UPDATE ON field_mapping_sample_runs FOR EACH ROW EXECUTE FUNCTION protect_mapping_governance_snapshot();
CREATE TRIGGER mapping_published_immutable BEFORE UPDATE ON field_mapping_versions FOR EACH ROW EXECUTE FUNCTION protect_mapping_governance_snapshot();
CREATE TRIGGER demo_generation_write_fence BEFORE INSERT OR UPDATE OR DELETE ON field_mapping_definitions FOR EACH ROW EXECUTE FUNCTION assert_demo_tenant_write();
CREATE TRIGGER demo_generation_write_fence BEFORE INSERT OR UPDATE OR DELETE ON field_mapping_drafts FOR EACH ROW EXECUTE FUNCTION assert_demo_tenant_write();
CREATE TRIGGER demo_generation_write_fence BEFORE INSERT OR UPDATE OR DELETE ON field_mapping_sample_runs FOR EACH ROW EXECUTE FUNCTION assert_demo_tenant_write();
