CREATE TABLE model_generation_tasks (
 tenant_id text NOT NULL,id text NOT NULL,owner_id text NOT NULL,operation text NOT NULL CHECK(operation IN('travel.proposal','rule.proposal','knowledge.answer')),
 actor_context jsonb NOT NULL,idempotency_key text NOT NULL,payload_hash text NOT NULL,prompt text NOT NULL,output_schema jsonb NOT NULL,
 resource_refs jsonb NOT NULL DEFAULT '[]',dependency_refs jsonb NOT NULL DEFAULT '[]',state text NOT NULL CHECK(state IN('queued','running','succeeded','failed','blocked')),
 job_id text NOT NULL,result jsonb,runtime_instance_id text,runtime_session_id text,error_code text,
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT(now()+interval '90 days'),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,owner_id,operation,idempotency_key)
);
CREATE TABLE model_generation_events (
 tenant_id text NOT NULL,id text NOT NULL,task_id text NOT NULL,event_type text NOT NULL,lease_epoch integer NOT NULL,details jsonb NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,task_id) REFERENCES model_generation_tasks(tenant_id,id)
);
