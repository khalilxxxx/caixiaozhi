CREATE TABLE uploaded_files (
  id text PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) > 0),
  owner_id text NOT NULL CHECK (length(owner_id) > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'uploaded', 'validated', 'rejected')),
  object_key text NOT NULL UNIQUE CHECK (length(object_key) > 0),
  original_filename text NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 120),
  mime_type text NOT NULL CHECK (length(mime_type) > 0),
  expected_size_bytes bigint NOT NULL CHECK (expected_size_bytes BETWEEN 1 AND 9007199254740991),
  size_bytes bigint CHECK (size_bytes BETWEEN 1 AND 9007199254740991),
  sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  upload_expires_at timestamptz NOT NULL,
  rejection_reason text,
  UNIQUE (tenant_id, id),
  CHECK (status = 'registered' OR (size_bytes IS NOT NULL AND sha256 IS NOT NULL)),
  CHECK ((status = 'rejected') = (rejection_reason IS NOT NULL)),
  CHECK (updated_at >= created_at)
);
CREATE INDEX uploaded_files_tenant_owner_idx ON uploaded_files (tenant_id, owner_id, id);
CREATE INDEX uploaded_files_expiry_idx ON uploaded_files (upload_expires_at) WHERE status = 'registered';

CREATE TABLE outbox_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  event_type text NOT NULL CHECK (length(event_type) > 0),
  schema_version integer NOT NULL CHECK (schema_version >= 1),
  resource_type text NOT NULL CHECK (length(resource_type) > 0),
  resource_id text NOT NULL CHECK (length(resource_id) > 0),
  resource_version integer NOT NULL CHECK (resource_version >= 1),
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  published_at timestamptz,
  CHECK (updated_at >= created_at)
);
CREATE INDEX outbox_events_pending_idx ON outbox_events (created_at, id) WHERE published_at IS NULL;
CREATE INDEX outbox_events_resource_idx ON outbox_events (tenant_id, resource_type, resource_id, resource_version);
