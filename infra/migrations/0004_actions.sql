CREATE TABLE confirmations (
 id text PRIMARY KEY, tenant_id text NOT NULL, actor_id text NOT NULL, session_id text NOT NULL,
 authz_version integer NOT NULL CHECK(authz_version>0), version integer NOT NULL DEFAULT 1,
 action_id text NOT NULL UNIQUE, operation text NOT NULL, args_hash text NOT NULL, summary_hash text NOT NULL,
 resource_refs jsonb NOT NULL, dependency_refs jsonb NOT NULL DEFAULT '[]', extra_guards jsonb NOT NULL DEFAULT '{}',
 summary jsonb NOT NULL, generation integer NOT NULL DEFAULT 1, expires_at timestamptz NOT NULL,
 confirmed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id)
);
CREATE TABLE actions (
 id text PRIMARY KEY, tenant_id text NOT NULL, actor_id text NOT NULL, actor_context jsonb NOT NULL,
 confirmation_id text NOT NULL REFERENCES confirmations(id), operation text NOT NULL,
 state text NOT NULL CHECK(state IN('prepared','confirmed','executing','succeeded','rejected','failed','unknown','cancelled','expired')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), idempotency_key text NOT NULL, payload_hash text NOT NULL,
 args jsonb NOT NULL, resource_refs jsonb NOT NULL, prepared_domain jsonb NOT NULL,
 run_id text, trace_id text, generation integer NOT NULL DEFAULT 1, cancel_requested boolean NOT NULL DEFAULT false,
 retain_until timestamptz NOT NULL DEFAULT (now()+interval '180 days'),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,actor_id,operation,idempotency_key), UNIQUE(tenant_id,id)
);
ALTER TABLE confirmations ADD CONSTRAINT confirmations_action_fk FOREIGN KEY(action_id) REFERENCES actions(id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE action_items (
 id text PRIMARY KEY, tenant_id text NOT NULL, action_id text NOT NULL REFERENCES actions(id),
 ordinal integer NOT NULL CHECK(ordinal>=0), resource_ref jsonb, task_ref jsonb, args jsonb NOT NULL, guards jsonb NOT NULL DEFAULT '{}',
 state text NOT NULL CHECK(state IN('prepared','confirmed','executing','succeeded','rejected','failed','unknown','cancelled','expired')),
 external_request_id text NOT NULL UNIQUE, idempotency_key text NOT NULL, receipt_id text,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(action_id,ordinal), UNIQUE(tenant_id,id)
);
CREATE INDEX action_items_reconcile_idx ON action_items(state,updated_at) WHERE state IN('unknown','executing');
CREATE TABLE action_receipts (
 id text PRIMARY KEY, tenant_id text NOT NULL, action_id text NOT NULL REFERENCES actions(id),
 item_id text NOT NULL UNIQUE REFERENCES action_items(id), idempotency_key text NOT NULL,
 outcome text NOT NULL CHECK(outcome IN('succeeded','rejected','failed','unknown')),
 resource jsonb, external_receipt_id text, occurred_at timestamptz NOT NULL,
 data_mode text NOT NULL CHECK(data_mode IN('demo','production')), error_code text,
 retain_until timestamptz NOT NULL DEFAULT (now()+interval '180 days'),
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE action_attempts (
 id text PRIMARY KEY, tenant_id text NOT NULL, item_id text NOT NULL REFERENCES action_items(id),
 attempt integer NOT NULL, kind text NOT NULL CHECK(kind IN('execute','reconcile')),
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, transport_result text, reconcile_after timestamptz,
 UNIQUE(item_id,attempt)
);
CREATE TABLE action_audit (
 id text PRIMARY KEY, tenant_id text NOT NULL, actor_id text NOT NULL, action_id text NOT NULL REFERENCES actions(id),
 item_id text, event_type text NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX action_audit_action_idx ON action_audit(tenant_id,action_id,created_at,id);

CREATE TABLE integration_connectors (
 id text PRIMARY KEY, tenant_id text NOT NULL, name text NOT NULL, system_type text NOT NULL,
 adapter_kind text NOT NULL CHECK(adapter_kind IN('demo','production')), environment text NOT NULL CHECK(environment IN('demo','production')),
 status text NOT NULL CHECK(status IN('draft','enabled','disabled')), config_version integer NOT NULL DEFAULT 1,
 base_url_ref text, secret_ref text, owner_id text NOT NULL, timeout_ms integer NOT NULL CHECK(timeout_ms BETWEEN 1 AND 120000),
 max_concurrency integer NOT NULL DEFAULT 5 CHECK(max_concurrency BETWEEN 1 AND 100),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id)
);
CREATE TABLE integration_capabilities (
 id text PRIMARY KEY, tenant_id text NOT NULL, name text NOT NULL, current_version_id text,
 status text NOT NULL CHECK(status IN('draft','testing','published','disabled')), version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,name),UNIQUE(tenant_id,id)
);
CREATE TABLE integration_capability_versions (
 id text PRIMARY KEY, tenant_id text NOT NULL, capability_id text NOT NULL REFERENCES integration_capabilities(id),
 semver text NOT NULL, definition jsonb NOT NULL, checksum text NOT NULL,
 tested boolean NOT NULL DEFAULT false, published_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(capability_id,semver), UNIQUE(tenant_id,id)
);
CREATE TABLE integration_capability_tests (
 id text PRIMARY KEY, tenant_id text NOT NULL, version_id text NOT NULL REFERENCES integration_capability_versions(id),
 case_kind text NOT NULL CHECK(case_kind IN('success','invalid_input','unauthorized','dependency_failure','stale_version','duplicate_key','lost_receipt','partial_success')),
 result text NOT NULL CHECK(result IN('passed','failed')), tested_at timestamptz NOT NULL DEFAULT now(), UNIQUE(version_id,case_kind)
);
CREATE TABLE integration_tool_bindings (
 tenant_id text NOT NULL, skill_version_id text NOT NULL, capability_version_id text NOT NULL REFERENCES integration_capability_versions(id),
 enabled boolean NOT NULL DEFAULT true, created_by text NOT NULL, PRIMARY KEY(tenant_id,skill_version_id,capability_version_id)
);
CREATE TABLE integration_invocations (
 call_id text NOT NULL, tenant_id text NOT NULL, run_id text NOT NULL, actor_id text NOT NULL,
 capability_version_id text NOT NULL REFERENCES integration_capability_versions(id), connector_config_version integer NOT NULL,
 lease_epoch integer NOT NULL, args_hash text NOT NULL, redacted_args jsonb NOT NULL,
 effect text NOT NULL, status text NOT NULL, action_id text, duration_ms integer, evidence_refs jsonb NOT NULL DEFAULT '[]',
 error_code text, result jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,run_id,call_id)
);
CREATE TABLE integration_workflow_runs (
 id text PRIMARY KEY, tenant_id text NOT NULL, actor_id text NOT NULL, connector_id text NOT NULL,
 external_run_id text NOT NULL, operation text NOT NULL, state text NOT NULL, output jsonb,
 data_mode text NOT NULL CHECK(data_mode IN('demo','production')), version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(connector_id,external_run_id)
);
CREATE TABLE integration_workflow_callbacks (
 connector_id text NOT NULL, external_run_id text NOT NULL, event_id text NOT NULL,
 body_hash text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(connector_id,external_run_id,event_id)
);
