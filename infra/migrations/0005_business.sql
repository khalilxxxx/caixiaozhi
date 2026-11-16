CREATE TABLE business_command_ledger (
 tenant_id text NOT NULL, actor_id text NOT NULL, operation text NOT NULL, idempotency_key text NOT NULL,
 payload_hash text NOT NULL, result jsonb, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '180 days',
 PRIMARY KEY(tenant_id,actor_id,operation,idempotency_key)
);
CREATE TABLE travel_requests (
 tenant_id text NOT NULL,id text NOT NULL,owner_id text NOT NULL,department_id text NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 state text NOT NULL CHECK(state IN('draft','pending_manager','approved','returned','withdrawn')),
 title text NOT NULL,purpose text NOT NULL DEFAULT '',cost_center_id text,project_id text,material_refs jsonb NOT NULL DEFAULT '[]',
 total_minor bigint NOT NULL DEFAULT 0 CHECK(total_minor BETWEEN 0 AND 100000000),submitted_snapshot_id text,submission_id text,
 submitted_at timestamptz,approved_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,owner_id) REFERENCES identities(tenant_id,id),FOREIGN KEY(tenant_id,department_id) REFERENCES organizations(tenant_id,id)
);
CREATE INDEX travel_owner_idx ON travel_requests(tenant_id,owner_id,updated_at,id);
CREATE TABLE travel_legs (
 tenant_id text NOT NULL,travel_id text NOT NULL,id text NOT NULL,ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 20),data jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,travel_id,id),UNIQUE(tenant_id,travel_id,ordinal),FOREIGN KEY(tenant_id,travel_id) REFERENCES travel_requests(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE travel_proposals (
 tenant_id text NOT NULL,id text NOT NULL,travel_id text NOT NULL,owner_id text NOT NULL,base_version integer NOT NULL,
 state text NOT NULL CHECK(state IN('proposed','applied','stale','rejected')),operations jsonb NOT NULL,clarifications jsonb NOT NULL,selected_material_refs jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,travel_id) REFERENCES travel_requests(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE entertainment_requests (
 tenant_id text NOT NULL,id text NOT NULL,owner_id text NOT NULL,department_id text NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 state text NOT NULL CHECK(state IN('draft','pending_manager','approved','returned','withdrawn')),title text NOT NULL,
 entertainment_date date,entertained_party text NOT NULL DEFAULT '',purpose text NOT NULL DEFAULT '',budget_minor bigint CHECK(budget_minor BETWEEN 0 AND 100000000),
 consumed_minor bigint NOT NULL DEFAULT 0 CHECK(consumed_minor>=0),reserved_minor bigint NOT NULL DEFAULT 0 CHECK(reserved_minor>=0),
 submitted_snapshot_id text,submission_id text,submitted_at timestamptz,approved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES identities(tenant_id,id),CHECK(budget_minor IS NULL OR consumed_minor+reserved_minor<=budget_minor)
);
CREATE INDEX oa_owner_idx ON entertainment_requests(tenant_id,owner_id,updated_at,id);
CREATE TABLE invoices (
 tenant_id text NOT NULL,id text NOT NULL,owner_id text NOT NULL,file_id text NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),fields jsonb NOT NULL,
 confirmation_state text NOT NULL CHECK(confirmation_state IN('recognized','needs_confirmation','confirmed')),
 verification_state text NOT NULL CHECK(verification_state IN('pending','verified','rejected','unavailable')),verification_evidence jsonb,
 fingerprint text,gross_minor bigint CHECK(gross_minor BETWEEN 0 AND 100000000),corrections jsonb NOT NULL DEFAULT '[]',source_fields jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,file_id) REFERENCES uploaded_files(tenant_id,id),FOREIGN KEY(tenant_id,owner_id) REFERENCES identities(tenant_id,id)
);
CREATE INDEX invoices_owner_idx ON invoices(tenant_id,owner_id,created_at,id);
CREATE INDEX invoices_fingerprint_idx ON invoices(tenant_id,fingerprint) WHERE fingerprint IS NOT NULL;
CREATE TABLE expense_claims (
 tenant_id text NOT NULL,id text NOT NULL,owner_id text NOT NULL,department_id text NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 state text NOT NULL CHECK(state IN('draft','pending_manager','pending_finance','completed','returned','withdrawn')),title text NOT NULL,purpose text NOT NULL DEFAULT '',
 cost_center_id text,material_refs jsonb NOT NULL DEFAULT '[]',total_minor bigint NOT NULL DEFAULT 0 CHECK(total_minor BETWEEN 0 AND 100000000),
 submitted_snapshot_id text,submission_id text,submitted_at timestamptz,completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES identities(tenant_id,id),FOREIGN KEY(tenant_id,department_id) REFERENCES organizations(tenant_id,id)
);
CREATE INDEX expense_scope_idx ON expense_claims(tenant_id,department_id,state,updated_at,id);
CREATE INDEX expense_completed_idx ON expense_claims(tenant_id,completed_at,id) WHERE state='completed';
CREATE TABLE expense_items (
 tenant_id text NOT NULL,claim_id text NOT NULL,id text NOT NULL,invoice_id text NOT NULL,data jsonb NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor BETWEEN 1 AND 100000000),expense_type text NOT NULL CHECK(expense_type IN('transport','lodging','meals','office','other')),
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,claim_id,id),UNIQUE(tenant_id,claim_id,invoice_id),FOREIGN KEY(tenant_id,claim_id) REFERENCES expense_claims(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,invoice_id) REFERENCES invoices(tenant_id,id)
);
CREATE TABLE invoice_reservations (
 tenant_id text NOT NULL,invoice_id text NOT NULL,claim_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,invoice_id),FOREIGN KEY(tenant_id,invoice_id) REFERENCES invoices(tenant_id,id),FOREIGN KEY(tenant_id,claim_id) REFERENCES expense_claims(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE oa_budget_reservations (
 tenant_id text NOT NULL,id text NOT NULL,oa_id text NOT NULL,claim_id text NOT NULL,submission_id text NOT NULL,reservation_key text NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),state text NOT NULL CHECK(state IN('reserved','consumed','released')),
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,oa_id,claim_id,submission_id),UNIQUE(tenant_id,reservation_key),
 FOREIGN KEY(tenant_id,oa_id) REFERENCES entertainment_requests(tenant_id,id),FOREIGN KEY(tenant_id,claim_id) REFERENCES expense_claims(tenant_id,id)
);
CREATE TABLE business_snapshots (
 tenant_id text NOT NULL,id text NOT NULL,resource_type text NOT NULL,resource_id text NOT NULL,resource_version integer NOT NULL,body jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id)
);
CREATE TABLE approval_tasks (
 tenant_id text NOT NULL,id text NOT NULL,resource_type text NOT NULL CHECK(resource_type IN('travel','expense_claim','oa_request')),resource_id text NOT NULL,resource_version integer NOT NULL,
 owner_id text NOT NULL,department_id text NOT NULL,assigned_to text NOT NULL,node text NOT NULL CHECK(node IN('manager','finance')),
 state text NOT NULL CHECK(state IN('pending','approved','returned','cancelled')),submission_id text NOT NULL,version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,assigned_to) REFERENCES identities(tenant_id,id)
);
CREATE UNIQUE INDEX approval_one_pending_idx ON approval_tasks(tenant_id,resource_type,resource_id) WHERE state='pending';
CREATE INDEX approval_assignee_idx ON approval_tasks(tenant_id,assigned_to,state,created_at,id);
CREATE TABLE approval_decisions (
 tenant_id text NOT NULL,id text NOT NULL,task_id text NOT NULL,actor_id text NOT NULL,action_id text NOT NULL,item_id text NOT NULL,
 decision text NOT NULL CHECK(decision IN('approved','returned','cancelled')),reason text NOT NULL,resource_before_version integer NOT NULL,resource_after_version integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,action_id,item_id),FOREIGN KEY(tenant_id,task_id) REFERENCES approval_tasks(tenant_id,id)
);
CREATE TABLE business_receipts (
 tenant_id text NOT NULL,id text NOT NULL,action_id text NOT NULL,item_id text NOT NULL,receipt jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,action_id,item_id)
);
CREATE TABLE ocr_tasks (
 tenant_id text NOT NULL,id text NOT NULL,owner_id text NOT NULL,file_id text NOT NULL,file_version integer NOT NULL,sha256 text NOT NULL,provider_version text NOT NULL,
 state text NOT NULL CHECK(state IN('queued','running','completed','failed','cancelled')),attempt integer NOT NULL DEFAULT 0,lease_owner text,lease_until timestamptz,lease_epoch integer NOT NULL DEFAULT 0,
 invoice_ids jsonb NOT NULL DEFAULT '[]',error_code text,generation integer NOT NULL,version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,owner_id,file_id,file_version,provider_version),FOREIGN KEY(tenant_id,file_id) REFERENCES uploaded_files(tenant_id,id)
);
CREATE TABLE demo_messages (
 tenant_id text NOT NULL,id text NOT NULL,owner_id text NOT NULL,sender_id text NOT NULL,message_kind text NOT NULL CHECK(message_kind IN('supplement','result','reminder')),
 subject text NOT NULL,body text NOT NULL,recipient_ids jsonb NOT NULL,resource_ref jsonb NOT NULL,state text NOT NULL CHECK(state IN('draft','sent')),
 version integer NOT NULL DEFAULT 1,sent_at timestamptz,action_id text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id)
);
CREATE TABLE message_deliveries (
 tenant_id text NOT NULL,message_id text NOT NULL,recipient_id text NOT NULL,read_at timestamptz,version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,message_id,recipient_id),FOREIGN KEY(tenant_id,message_id) REFERENCES demo_messages(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE demo_ocr_fixtures (
 tenant_id text NOT NULL,sha256 text NOT NULL,candidates jsonb NOT NULL,synthetic boolean NOT NULL CHECK(synthetic),provider_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,sha256,provider_version)
);
