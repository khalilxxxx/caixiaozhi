CREATE TABLE agent_runs (
  id text PRIMARY KEY, tenant_id text NOT NULL, owner_id text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  origin text NOT NULL CHECK (origin IN ('conversation','subscription')),
  thread_id text, input_message_id text, occurrence_id text,
  status text NOT NULL CHECK (status IN ('queued','running','waiting_user','waiting_confirmation','reconciling','succeeded','failed','cancelled','interrupted')),
  phase text, runtime_active boolean NOT NULL DEFAULT false,
  checkpoint_id text, selected_skill_version_id text, authz_version integer NOT NULL,
  actor_context jsonb NOT NULL, trace_id text NOT NULL, parent_run_id text REFERENCES agent_runs(id),
  requested_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
  cancel_requested_at timestamptz, attempt integer NOT NULL DEFAULT 0, recovery_count integer NOT NULL DEFAULT 0,
  runtime_config_version text NOT NULL DEFAULT 'finance-sdk-v1', error_code text,
  budgets jsonb NOT NULL, usage jsonb NOT NULL DEFAULT '{"model_calls":0,"tool_calls":0,"input_tokens":0,"output_tokens":0,"cached_tokens":0,"elapsed_ms":0,"cost_amount":null}',
  last_seq bigint NOT NULL DEFAULT 0, event_floor bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id,id),
  CHECK ((origin='conversation' AND thread_id IS NOT NULL AND input_message_id IS NOT NULL AND occurrence_id IS NULL)
    OR (origin='subscription' AND thread_id IS NULL AND input_message_id IS NULL AND occurrence_id IS NOT NULL)),
  CHECK (NOT runtime_active OR status='running')
);
CREATE UNIQUE INDEX agent_runs_thread_active ON agent_runs(tenant_id,thread_id)
  WHERE thread_id IS NOT NULL AND status NOT IN ('succeeded','failed','cancelled');
CREATE UNIQUE INDEX agent_runs_occurrence_active ON agent_runs(tenant_id,occurrence_id)
  WHERE occurrence_id IS NOT NULL AND status NOT IN ('succeeded','failed','cancelled');
CREATE UNIQUE INDEX agent_runs_message_unique ON agent_runs(tenant_id,input_message_id) WHERE input_message_id IS NOT NULL;
CREATE INDEX agent_runs_owner_status ON agent_runs(tenant_id,owner_id,status);
CREATE TABLE run_commands (
  tenant_id text NOT NULL, actor_id text NOT NULL, operation text NOT NULL, idempotency_key text NOT NULL,
  payload_hash text NOT NULL, run_id text NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '180 days',
  PRIMARY KEY (tenant_id,actor_id,operation,idempotency_key)
);
CREATE TABLE run_jobs (
  run_id text PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  ready_at timestamptz NOT NULL DEFAULT now(), priority integer NOT NULL DEFAULT 0,
  attempt integer NOT NULL DEFAULT 0, claimed_epoch bigint
);
CREATE INDEX run_jobs_ready ON run_jobs(ready_at,priority DESC,run_id);
CREATE TABLE run_leases (
  run_id text PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  worker_id text NOT NULL, lease_epoch bigint NOT NULL CHECK (lease_epoch>0),
  lease_until timestamptz NOT NULL, heartbeat_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE runtime_fairness (
  tenant_id text NOT NULL, owner_id text NOT NULL, last_claimed_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,owner_id)
);
CREATE TABLE run_events (
  run_id text NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, seq bigint NOT NULL,
  type text NOT NULL CHECK (type IN ('run.status','assistant.delta','assistant.message','tool.started','tool.completed','card.upsert','confirmation.required','usage.updated','run.error')),
  payload jsonb NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(run_id,seq)
);
CREATE INDEX run_events_retention ON run_events(occurred_at);
CREATE TABLE run_checkpoints (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  tenant_id text NOT NULL, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), lease_epoch bigint NOT NULL, checkpoint jsonb NOT NULL,
  resume_input jsonb, resumed_at timestamptz, completion_key text UNIQUE
);
CREATE TABLE runtime_tool_calls (
  call_id text PRIMARY KEY, run_id text NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  tool_name text NOT NULL, tool_version text NOT NULL, input_hash text NOT NULL,
  effect text NOT NULL CHECK (effect IN ('read','propose','write')),
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  status text NOT NULL CHECK(status IN ('running','completed','failed','unknown')),
  result jsonb, action_id text, error_code text, lease_epoch bigint NOT NULL
);
CREATE TABLE run_audit (
  id text PRIMARY KEY, tenant_id text NOT NULL, run_id text NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  actor_id text NOT NULL, operation text NOT NULL, reason text, trace_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE durable_jobs (
  id text PRIMARY KEY, tenant_id text NOT NULL, owner_module text NOT NULL, kind text NOT NULL,
  payload_ref text NOT NULL, dedupe_key text NOT NULL,
  status text NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','running','succeeded','failed','cancelled')),
  ready_at timestamptz NOT NULL DEFAULT now(), attempt integer NOT NULL DEFAULT 0,
  lease_owner text, lease_epoch bigint NOT NULL DEFAULT 0, lease_until timestamptz,
  generation integer NOT NULL DEFAULT 0, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  error_code text, UNIQUE(tenant_id,kind,dedupe_key)
);
CREATE INDEX durable_jobs_ready ON durable_jobs(ready_at,id) WHERE status IN ('ready','running');
