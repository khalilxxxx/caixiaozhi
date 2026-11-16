ALTER TABLE travel_proposal_tasks ADD COLUMN source_snapshot jsonb NOT NULL DEFAULT '{}';
ALTER TABLE travel_proposal_tasks ADD COLUMN dependency_snapshot jsonb NOT NULL DEFAULT '{}';
ALTER TABLE travel_proposals ADD COLUMN source_snapshot jsonb NOT NULL DEFAULT '{}';
ALTER TABLE travel_proposals ADD COLUMN dependency_snapshot jsonb NOT NULL DEFAULT '{}';
ALTER TABLE travel_proposals ADD COLUMN applied_operation_ids jsonb NOT NULL DEFAULT '[]';
CREATE TABLE expense_proposal_tasks (
 tenant_id text NOT NULL,id text NOT NULL,owner_id text NOT NULL,claim_id text NOT NULL,base_version integer NOT NULL,
 prompt text NOT NULL,selected_material_refs jsonb NOT NULL,invoice_refs jsonb NOT NULL,actor_context jsonb NOT NULL,
 source_snapshot jsonb NOT NULL,dependency_snapshot jsonb NOT NULL,origin_run_id text,
 state text NOT NULL CHECK(state IN('queued','running','completed','failed')),error_code text,job_id text,
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,claim_id) REFERENCES expense_claims(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE expense_proposals (
 tenant_id text NOT NULL,id text NOT NULL,owner_id text NOT NULL,claim_id text NOT NULL,base_version integer NOT NULL,
 state text NOT NULL CHECK(state IN('proposed','applied','stale','rejected')),operations jsonb NOT NULL,clarifications jsonb NOT NULL,
 selected_material_refs jsonb NOT NULL,invoice_refs jsonb NOT NULL,source_snapshot jsonb NOT NULL,dependency_snapshot jsonb NOT NULL,
 applied_operation_ids jsonb NOT NULL DEFAULT '[]',
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,claim_id) REFERENCES expense_claims(tenant_id,id) ON DELETE CASCADE
);
