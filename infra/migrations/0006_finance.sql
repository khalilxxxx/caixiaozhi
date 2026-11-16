CREATE TABLE file_security (
  tenant_id text NOT NULL, file_id text NOT NULL,
  profile text NOT NULL CHECK(profile IN ('invoice-v1','policy-text-v1')),
  upload_token_hash text NOT NULL, parent_ref jsonb,
  PRIMARY KEY(tenant_id,file_id),
  FOREIGN KEY(tenant_id,file_id) REFERENCES uploaded_files(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE file_command_ledger (
  tenant_id text NOT NULL, actor_id text NOT NULL, operation text NOT NULL, idempotency_key text NOT NULL,
  payload_hash text NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '180 days',
  PRIMARY KEY(tenant_id,actor_id,operation,idempotency_key)
);
CREATE TABLE finance_commands (
  tenant_id text NOT NULL REFERENCES identity_environments(tenant_id) ON DELETE CASCADE,
  actor_id text NOT NULL, operation text NOT NULL, idempotency_key text NOT NULL, payload_hash text NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '180 days',
  PRIMARY KEY(tenant_id,actor_id,operation,idempotency_key)
);
CREATE TABLE finance_revision_guards (
  tenant_id text NOT NULL REFERENCES identity_environments(tenant_id) ON DELETE CASCADE,
  id text NOT NULL, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id)
);
CREATE TABLE policies (
  tenant_id text NOT NULL REFERENCES identity_environments(tenant_id) ON DELETE CASCADE,
  id text NOT NULL, policy_code text NOT NULL, title text NOT NULL, owner_id text NOT NULL,
  latest_published_ref jsonb, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,policy_code)
);
CREATE TABLE policy_versions (
  tenant_id text NOT NULL, id text NOT NULL,policy_id text NOT NULL,version_no integer NOT NULL CHECK(version_no>0),
  publication_state text NOT NULL CHECK(publication_state IN ('draft','published','withdrawn')),
  source_file_id text NOT NULL,content_hash text NOT NULL,parser_version text NOT NULL,normalization_version text NOT NULL,
  normalized_text text NOT NULL,offset_map jsonb NOT NULL,organization_ids jsonb NOT NULL,effective_from date NOT NULL,effective_to date,
  topic_tags jsonb NOT NULL,supersedes_version_id text,parse_complete boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,policy_id,version_no),
  FOREIGN KEY(tenant_id,policy_id) REFERENCES policies(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,source_file_id) REFERENCES uploaded_files(tenant_id,id),
  CHECK(effective_to IS NULL OR effective_to>effective_from)
);
CREATE TABLE policy_chunks (
  tenant_id text NOT NULL,id text NOT NULL,version_id text NOT NULL,ordinal integer NOT NULL,
  heading_path jsonb NOT NULL,text text NOT NULL,start_line integer NOT NULL,end_line integer NOT NULL,source_start_utf16 integer NOT NULL,
  content_hash text NOT NULL,search_vector tsvector NOT NULL,
  version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,version_id,ordinal),
  FOREIGN KEY(tenant_id,version_id) REFERENCES policy_versions(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX policy_chunks_search_idx ON policy_chunks USING gin(search_vector);
CREATE TABLE policy_citations (
  tenant_id text NOT NULL,id text NOT NULL,version_id text NOT NULL,chunk_id text NOT NULL,
  quote text NOT NULL,start_utf16 integer NOT NULL,end_utf16 integer NOT NULL,quote_hash text NOT NULL,locator jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,chunk_id) REFERENCES policy_chunks(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,version_id) REFERENCES policy_versions(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE policy_imports (
  tenant_id text NOT NULL,id text NOT NULL,owner_id text NOT NULL,version_id text NOT NULL,file_hash text NOT NULL,
  stage text NOT NULL CHECK(stage IN ('uploading','validating','parsing','indexing','ready','error')),
  job_id text,origin_run_id text,parser_version text NOT NULL,error_location jsonb,warnings jsonb NOT NULL DEFAULT '[]',
  version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,version_id,file_hash,parser_version),
  FOREIGN KEY(tenant_id,version_id) REFERENCES policy_versions(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE policy_assertions (
  tenant_id text NOT NULL,id text NOT NULL,version_id text NOT NULL,chunk_id text NOT NULL,topic_key text NOT NULL,
  unit text NOT NULL,normalized_value text NOT NULL,confirmed_by text NOT NULL,status text NOT NULL CHECK(status IN ('confirmed','suggested')),
  version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,version_id) REFERENCES policy_versions(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,chunk_id) REFERENCES policy_chunks(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE knowledge_retrieval_snapshots (
  tenant_id text NOT NULL REFERENCES identity_environments(tenant_id) ON DELETE CASCADE,
  id text NOT NULL,owner_id text NOT NULL,authz_version integer NOT NULL,query text NOT NULL,business_date date NOT NULL,
  context_json jsonb NOT NULL,scope_hash text NOT NULL,corpus_revision integer NOT NULL,hits jsonb NOT NULL,conflicts jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id)
);
CREATE TABLE knowledge_questions (
  tenant_id text NOT NULL REFERENCES identity_environments(tenant_id) ON DELETE CASCADE,
  id text NOT NULL,owner_id text NOT NULL,origin_run_id text NOT NULL,query text NOT NULL,business_date date NOT NULL,
  context_json jsonb NOT NULL,answer_state text NOT NULL,answer_blocks jsonb NOT NULL,citation_ids jsonb NOT NULL,snapshot_id text NOT NULL,
  model_version text,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id)
);
CREATE TABLE knowledge_feedback (
  tenant_id text NOT NULL REFERENCES identity_environments(tenant_id) ON DELETE CASCADE,
  id text NOT NULL,owner_id text NOT NULL,answer_id text NOT NULL,kind text NOT NULL,comment text,citation_id text,
  version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,answer_id) REFERENCES knowledge_questions(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE knowledge_clarifications (
  tenant_id text NOT NULL REFERENCES identity_environments(tenant_id) ON DELETE CASCADE,
  id text NOT NULL,owner_id text NOT NULL,question_id text NOT NULL,reason text NOT NULL,comment text,
  status text NOT NULL CHECK(status IN ('open','in_review','resolved','closed')),resolution text,
  version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,question_id) REFERENCES knowledge_questions(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE rule_definitions (
  tenant_id text NOT NULL REFERENCES identity_environments(tenant_id) ON DELETE CASCADE,
  id text NOT NULL,owner_id text NOT NULL,level text NOT NULL CHECK(level IN ('company','personal')),category text NOT NULL,name text NOT NULL,
  lifecycle text NOT NULL,active_version_id text,draft_version_id text,original_intent text,unresolved_questions jsonb NOT NULL DEFAULT '[]',
  version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id)
);
CREATE TABLE rule_versions (
  tenant_id text NOT NULL,id text NOT NULL,rule_id text NOT NULL,version_number integer NOT NULL,dsl_json jsonb NOT NULL,
  content_hash text NOT NULL,source_kind text NOT NULL,source_citation_ids jsonb NOT NULL,source_review_required boolean NOT NULL DEFAULT false,
  explanation text NOT NULL,publication_state text NOT NULL CHECK(publication_state IN ('draft','published')),
  version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,rule_id,version_number),FOREIGN KEY(tenant_id,rule_id) REFERENCES rule_definitions(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE rule_test_cases (
  tenant_id text NOT NULL,id text NOT NULL,rule_version_id text NOT NULL,name text NOT NULL,input_json jsonb NOT NULL,expected_truth text NOT NULL,
  version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,rule_version_id) REFERENCES rule_versions(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE rule_test_runs (
  tenant_id text NOT NULL,id text NOT NULL,rule_version_id text NOT NULL,owner_id text NOT NULL,compiled_hash text NOT NULL,
  test_set_hash text NOT NULL,mapping_hash text NOT NULL,results jsonb NOT NULL,passed boolean NOT NULL,finished_at timestamptz,job_id text,
  version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,rule_version_id) REFERENCES rule_versions(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE field_mapping_versions (
  tenant_id text NOT NULL REFERENCES identity_environments(tenant_id) ON DELETE CASCADE,
  id text NOT NULL,mapping_id text NOT NULL,version_number integer NOT NULL,mapping_json jsonb NOT NULL,content_hash text NOT NULL,confirmed_by text NOT NULL,
  version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,mapping_id,version_number)
);
CREATE TABLE rule_change_audit (
  tenant_id text NOT NULL REFERENCES identity_environments(tenant_id) ON DELETE CASCADE,
  id text NOT NULL,actor_id text NOT NULL,action text NOT NULL,before_ref jsonb,after_ref jsonb,confirmation_id text,receipt_id text,
  version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id)
);
CREATE TABLE preaudit_tasks (
  tenant_id text NOT NULL REFERENCES identity_environments(tenant_id) ON DELETE CASCADE,
  id text NOT NULL,owner_id text NOT NULL,purpose text NOT NULL,scope_hash text NOT NULL,selection_json jsonb NOT NULL,actor_reference jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','running','completed','partial_failed','failed','cancelled')),
  origin_run_id text,retry_of_task_id text,cancel_requested boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id)
);
CREATE TABLE preaudit_items (
  tenant_id text NOT NULL,id text NOT NULL,task_id text NOT NULL,document_type text NOT NULL,document_id text NOT NULL,requested_version integer NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','running','completed','failed','stale')),attempt integer NOT NULL DEFAULT 0,last_error jsonb,
  skipped_reason text,job_id text,result_id text,
  version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,task_id,document_type,document_id),FOREIGN KEY(tenant_id,task_id) REFERENCES preaudit_tasks(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE preaudit_results (
  tenant_id text NOT NULL,id text NOT NULL,item_id text NOT NULL,reviewer_id text NOT NULL,input_snapshot jsonb NOT NULL,
  locked_versions jsonb NOT NULL,lock_hash text NOT NULL,result_hash text NOT NULL,result_json jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,item_id),FOREIGN KEY(tenant_id,item_id) REFERENCES preaudit_items(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE preaudit_invalidations (
  tenant_id text NOT NULL,id text NOT NULL,result_id text NOT NULL,dimension text NOT NULL,old_version text,new_version text,
  version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,result_id,dimension,new_version),FOREIGN KEY(tenant_id,result_id) REFERENCES preaudit_results(tenant_id,id) ON DELETE CASCADE
);
