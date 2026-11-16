CREATE TABLE identity_environments (
  tenant_id text PRIMARY KEY,
  id text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  seed_version text NOT NULL DEFAULT 'finance-agent-v1.0',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE TABLE organizations (
  tenant_id text NOT NULL REFERENCES identity_environments(tenant_id) ON DELETE CASCADE,
  id text NOT NULL, name text NOT NULL, parent_id text, manager_user_id text,
  state text NOT NULL CHECK (state IN ('active','inactive')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,parent_id) REFERENCES organizations(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE TABLE identities (
  tenant_id text NOT NULL REFERENCES identity_environments(tenant_id) ON DELETE CASCADE,
  id text NOT NULL, external_subject text NOT NULL, display_name text NOT NULL,
  department_id text NOT NULL, position text NOT NULL,
  state text NOT NULL CHECK (state IN ('active','disabled')),
  authz_version integer NOT NULL DEFAULT 1 CHECK (authz_version > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,external_subject),
  FOREIGN KEY (tenant_id,department_id) REFERENCES organizations(tenant_id,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE organizations ADD CONSTRAINT organizations_manager_fk FOREIGN KEY (tenant_id,manager_user_id) REFERENCES identities(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE authorization_groups (
  tenant_id text NOT NULL REFERENCES identity_environments(tenant_id) ON DELETE CASCADE,
  id text NOT NULL, name text NOT NULL, state text NOT NULL CHECK(state IN ('active','inactive')),
  source text NOT NULL, version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id)
);
CREATE TABLE group_membership (
  tenant_id text NOT NULL, group_id text NOT NULL, user_id text NOT NULL,
  valid_from timestamptz NOT NULL, valid_to timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,group_id,user_id),
  FOREIGN KEY(tenant_id,group_id) REFERENCES authorization_groups(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,user_id) REFERENCES identities(tenant_id,id) ON DELETE CASCADE,
  CHECK(valid_to IS NULL OR valid_to > valid_from)
);
CREATE TABLE role_assignments (
  tenant_id text NOT NULL, user_id text NOT NULL,
  role text NOT NULL CHECK(role IN ('employee','manager','finance','platform_admin')),
  valid_from timestamptz NOT NULL, valid_to timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,user_id,role),
  FOREIGN KEY(tenant_id,user_id) REFERENCES identities(tenant_id,id) ON DELETE CASCADE,
  CHECK(valid_to IS NULL OR valid_to > valid_from)
);
CREATE TABLE grants (
  tenant_id text NOT NULL, id text NOT NULL, subject_id text NOT NULL,
  capability text NOT NULL,
  scope_type text NOT NULL CHECK(scope_type IN ('self','department','assigned_task','named_resource','operations')),
  scope_ids jsonb NOT NULL CHECK(jsonb_typeof(scope_ids)='array' AND jsonb_array_length(scope_ids)>0 AND NOT scope_ids @> '["*"]'::jsonb),
  effect text NOT NULL CHECK(effect='allow'),
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,subject_id) REFERENCES identities(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX grants_subject_idx ON grants(tenant_id,subject_id,capability);
CREATE TABLE identity_sessions (
  tenant_id text NOT NULL, id text NOT NULL, actor_id text NOT NULL,
  authz_version integer NOT NULL CHECK(authz_version > 0), generation integer NOT NULL CHECK(generation > 0),
  token_hash text NOT NULL UNIQUE, csrf_hash text NOT NULL,
  expires_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
  signature_key_id text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,actor_id) REFERENCES identities(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX identity_sessions_actor_idx ON identity_sessions(tenant_id,actor_id) WHERE revoked_at IS NULL;
CREATE TABLE subscription_delegations (
  tenant_id text NOT NULL, id text NOT NULL, owner_id text NOT NULL, subscription_id text NOT NULL,
  allowed_capabilities jsonb NOT NULL CHECK(jsonb_typeof(allowed_capabilities)='array'),
  scope jsonb NOT NULL CHECK(jsonb_typeof(scope)='array'),
  state text NOT NULL CHECK(state IN ('active','revoked')), generation integer NOT NULL CHECK(generation > 0),
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,owner_id,subscription_id),
  FOREIGN KEY(tenant_id,owner_id) REFERENCES identities(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE cost_centers (
  tenant_id text NOT NULL, id text NOT NULL, name text NOT NULL, department_id text NOT NULL,
  valid_from date NOT NULL, valid_to date, state text NOT NULL CHECK(state IN ('active','inactive')),
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,department_id) REFERENCES organizations(tenant_id,id) ON DELETE CASCADE,
  CHECK(valid_to IS NULL OR valid_to >= valid_from)
);
CREATE TABLE projects (
  tenant_id text NOT NULL, id text NOT NULL, name text NOT NULL, department_id text NOT NULL,
  state text NOT NULL CHECK(state IN ('active','inactive')),
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,department_id) REFERENCES organizations(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE cities (
  tenant_id text NOT NULL REFERENCES identity_environments(tenant_id) ON DELETE CASCADE,
  id text NOT NULL, standard_code text NOT NULL, name text NOT NULL,
  level text NOT NULL CHECK(level IN ('city','district')), province_name text NOT NULL, parent_city_id text,
  state text NOT NULL CHECK(state IN ('active','inactive')),
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,parent_city_id) REFERENCES cities(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
  CHECK((level='district')=(parent_city_id IS NOT NULL))
);
CREATE TABLE place_aliases (
  tenant_id text NOT NULL REFERENCES identity_environments(tenant_id) ON DELETE CASCADE,
  id text NOT NULL, alias text NOT NULL, target_place_ids jsonb NOT NULL,
  source text NOT NULL, mapping_version text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,alias), CHECK(jsonb_typeof(target_place_ids)='array')
);
CREATE TABLE authz_audit (
  tenant_id text NOT NULL REFERENCES identity_environments(tenant_id) ON DELETE CASCADE,
  id text NOT NULL, actor_id text NOT NULL, target_user_id text NOT NULL,
  before_version integer NOT NULL, after_version integer NOT NULL,
  reason text NOT NULL, trace_id text NOT NULL,
  resource_type text, resource_id text, operation text, result text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id)
);
CREATE TABLE identity_command_ledger (
  tenant_id text NOT NULL REFERENCES identity_environments(tenant_id) ON DELETE CASCADE,
  actor_id text NOT NULL, operation text NOT NULL, idempotency_key text NOT NULL,
  payload_hash text NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '180 days',
  PRIMARY KEY(tenant_id,actor_id,operation,idempotency_key)
);
