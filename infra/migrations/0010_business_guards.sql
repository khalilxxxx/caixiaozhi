ALTER TABLE approval_decisions ADD COLUMN review_ack jsonb;
ALTER TABLE approval_decisions DROP CONSTRAINT approval_decisions_decision_check;
UPDATE approval_decisions SET decision=CASE WHEN decision='approved' THEN 'approve' WHEN decision='returned' THEN 'return' ELSE decision END;
ALTER TABLE approval_decisions ADD CONSTRAINT approval_decisions_decision_check CHECK(decision IN('approve','return'));
CREATE TABLE travel_proposal_tasks (
 tenant_id text NOT NULL,id text NOT NULL,owner_id text NOT NULL,travel_id text NOT NULL,base_version integer NOT NULL,prompt text NOT NULL,selected_material_refs jsonb NOT NULL,
 state text NOT NULL CHECK(state IN('queued','running','completed','failed')),error_code text,job_id text,version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,travel_id) REFERENCES travel_requests(tenant_id,id) ON DELETE CASCADE
);
ALTER TABLE ocr_tasks ADD COLUMN actor_context jsonb;
CREATE TABLE demo_verification_fixtures (
 tenant_id text NOT NULL,sha256 text NOT NULL,verified boolean,provider_version text NOT NULL,synthetic boolean NOT NULL CHECK(synthetic),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,sha256,provider_version)
);
ALTER TABLE travel_proposal_tasks ADD COLUMN actor_context jsonb;
