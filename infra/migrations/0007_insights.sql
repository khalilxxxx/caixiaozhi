CREATE TABLE insights_commands (
 tenant_id text NOT NULL,actor_id text NOT NULL,operation text NOT NULL,idempotency_key text NOT NULL,payload_hash text NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),retain_until timestamptz NOT NULL DEFAULT(now()+interval '180 days'),PRIMARY KEY(tenant_id,actor_id,operation,idempotency_key)
);
CREATE TABLE skills (
 tenant_id text NOT NULL,id text NOT NULL,owner_id text NOT NULL,slug text NOT NULL,title text NOT NULL,summary text NOT NULL,
 scope text NOT NULL DEFAULT 'personal' CHECK(scope IN('personal','group','tenant')),scope_snapshot jsonb NOT NULL DEFAULT '{}',state text NOT NULL DEFAULT 'enabled' CHECK(state IN('enabled','disabled','archived')),
 published_version_id text,revocation_epoch integer NOT NULL DEFAULT 1,version integer NOT NULL DEFAULT 1,archived_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,owner_id,slug)
);
CREATE TABLE skill_versions (
 tenant_id text NOT NULL,id text NOT NULL,skill_id text NOT NULL,version_number integer NOT NULL,manifest_json jsonb NOT NULL,markdown text NOT NULL,content_hash text NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','validating','validated','review_pending','approved','rejected','published')),validation_id text,base_version_id text,version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,skill_id,version_number),FOREIGN KEY(tenant_id,skill_id) REFERENCES skills(tenant_id,id)
);
CREATE FUNCTION protect_skill_content() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.manifest_json IS DISTINCT FROM OLD.manifest_json OR NEW.markdown IS DISTINCT FROM OLD.markdown OR NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.skill_id IS DISTINCT FROM OLD.skill_id OR NEW.version_number IS DISTINCT FROM OLD.version_number OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'skill content is immutable'; END IF;RETURN NEW;END $$;
CREATE TRIGGER skill_versions_immutable BEFORE UPDATE ON skill_versions FOR EACH ROW EXECUTE FUNCTION protect_skill_content();
CREATE TABLE skill_validation_runs (
 tenant_id text NOT NULL,id text NOT NULL,skill_version_id text NOT NULL,content_hash text NOT NULL,validator_version text NOT NULL,profile_version text NOT NULL,capability_snapshot jsonb NOT NULL,
 status text NOT NULL CHECK(status IN('queued','running','passed','failed','blocked','cancelled')),checks jsonb NOT NULL DEFAULT '[]',test_run_ids jsonb NOT NULL DEFAULT '[]',error_code text,job_id text,
 synthetic boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,skill_version_id) REFERENCES skill_versions(tenant_id,id)
);
CREATE UNIQUE INDEX skill_validation_active ON skill_validation_runs(tenant_id,skill_version_id,content_hash,validator_version,profile_version) WHERE status IN('queued','running');
CREATE TABLE skill_reviews (
 tenant_id text NOT NULL,id text NOT NULL,skill_version_id text NOT NULL,author_id text NOT NULL,requested_scope jsonb NOT NULL,requested_grants jsonb NOT NULL,reviewer_id text NOT NULL,
 status text NOT NULL DEFAULT 'review_pending' CHECK(status IN('review_pending','approved','rejected','withdrawn')),decision_reason text,decided_at timestamptz,reviewed_hash text NOT NULL,
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,skill_version_id) REFERENCES skill_versions(tenant_id,id)
);
CREATE TABLE skill_grants (
 tenant_id text NOT NULL,id text NOT NULL,skill_id text NOT NULL,subject_type text NOT NULL CHECK(subject_type IN('user','group','tenant')),subject_id text NOT NULL,
 action text NOT NULL CHECK(action IN('use','source_read','maintain','review','publish')),expires_at timestamptz,revoked_at timestamptz,
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,skill_id) REFERENCES skills(tenant_id,id)
);
CREATE UNIQUE INDEX skill_grants_active ON skill_grants(tenant_id,skill_id,subject_type,subject_id,action) WHERE revoked_at IS NULL;
CREATE TABLE skill_activations (
 tenant_id text NOT NULL,user_id text NOT NULL,skill_id text NOT NULL,active_version_id text NOT NULL,selection_policy text NOT NULL CHECK(selection_policy IN('pin','follow_published')),
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,user_id,skill_id),FOREIGN KEY(tenant_id,skill_id) REFERENCES skills(tenant_id,id),FOREIGN KEY(tenant_id,active_version_id) REFERENCES skill_versions(tenant_id,id)
);
CREATE TABLE skill_publications (
 tenant_id text NOT NULL,id text NOT NULL,skill_id text NOT NULL,skill_version_id text NOT NULL,previous_version_id text,scope_snapshot jsonb NOT NULL,confirmation_id text NOT NULL,action_id text NOT NULL UNIQUE,published_by text NOT NULL,
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,skill_id) REFERENCES skills(tenant_id,id),FOREIGN KEY(tenant_id,skill_version_id) REFERENCES skill_versions(tenant_id,id)
);
CREATE TABLE skill_invocations (
 tenant_id text NOT NULL,run_id text NOT NULL,actor_id text NOT NULL,skill_version_id text NOT NULL,content_hash text NOT NULL,selected_by text NOT NULL,selection_reason text NOT NULL,scope_snapshot jsonb NOT NULL,revocation_epoch integer NOT NULL,status text NOT NULL,
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,run_id),FOREIGN KEY(tenant_id,skill_version_id) REFERENCES skill_versions(tenant_id,id)
);
CREATE TABLE skill_audit_events (
 tenant_id text NOT NULL,id text NOT NULL,skill_id text NOT NULL,skill_version_id text,actor_id text NOT NULL,operation text NOT NULL,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id)
);
CREATE TABLE analysis_requests (
 tenant_id text NOT NULL,id text NOT NULL,owner_id text NOT NULL,actor_context jsonb NOT NULL,query_plan jsonb NOT NULL,plan_hash text NOT NULL,scope_snapshot jsonb NOT NULL,authz_version integer NOT NULL,
 job_id text NOT NULL,origin_run_id text,state text NOT NULL CHECK(state IN('queued','running','ready','empty','degraded','failed','cancelled')),snapshot_id text,error_code text,
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id)
);
CREATE TABLE analysis_snapshots (
 tenant_id text NOT NULL,id text NOT NULL,request_id text NOT NULL,owner_id text NOT NULL,query_plan jsonb NOT NULL,scope_snapshot jsonb NOT NULL,scope_hash text NOT NULL,
 snapshot_at timestamptz NOT NULL,business_date date NOT NULL,source_watermark text NOT NULL,catalog_version text NOT NULL,quality text NOT NULL,body jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id),FOREIGN KEY(tenant_id,request_id) REFERENCES analysis_requests(tenant_id,id)
);
CREATE TABLE analysis_facts (
 tenant_id text NOT NULL,snapshot_id text NOT NULL,id text NOT NULL,fact_kind text NOT NULL,source_id text NOT NULL,claim_id text NOT NULL,body jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,snapshot_id,id),UNIQUE(tenant_id,snapshot_id,fact_kind,source_id),FOREIGN KEY(tenant_id,snapshot_id) REFERENCES analysis_snapshots(tenant_id,id)
);
CREATE TABLE analysis_reports (
 tenant_id text NOT NULL,id text NOT NULL,owner_id text NOT NULL,analysis_snapshot_id text NOT NULL,template_id text NOT NULL,template_version text NOT NULL DEFAULT '1',state text NOT NULL CHECK(state IN('draft','ready','archived')),
 current_draft_version integer NOT NULL DEFAULT 1,job_id text,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,analysis_snapshot_id) REFERENCES analysis_snapshots(tenant_id,id)
);
CREATE TABLE analysis_report_versions (
 tenant_id text NOT NULL,report_id text NOT NULL,version_no integer NOT NULL,editable_blocks jsonb NOT NULL,locked_fact_hash text NOT NULL,created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,report_id,version_no),FOREIGN KEY(tenant_id,report_id) REFERENCES analysis_reports(tenant_id,id)
);
CREATE TABLE analysis_artifacts (
 tenant_id text NOT NULL,id text NOT NULL,owner_id text NOT NULL,report_id text NOT NULL,report_version integer NOT NULL,snapshot_id text NOT NULL,format text NOT NULL CHECK(format IN('csv','html')),
 state text NOT NULL CHECK(state IN('queued','running','ready','failed')),file_id text,object_key text NOT NULL,sha256 text,size_bytes integer,expires_at timestamptz NOT NULL,export_scope_hash text NOT NULL,
 freshness_choice text NOT NULL,job_id text NOT NULL,actor_context jsonb NOT NULL,error_code text,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,owner_id,report_id,report_version,snapshot_id,format),FOREIGN KEY(tenant_id,report_id) REFERENCES analysis_reports(tenant_id,id)
);
