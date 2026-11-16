CREATE TABLE model_slots (
 id text PRIMARY KEY,occupant_key text NOT NULL UNIQUE,tenant_id text NOT NULL,owner_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN('agent_run','generation','skill_validation')),reference_id text NOT NULL,
 owner_epoch bigint NOT NULL CHECK(owner_epoch>=0),lease_owner text NOT NULL,lease_epoch bigint NOT NULL CHECK(lease_epoch>0),
 lease_until timestamptz NOT NULL,acquired_at timestamptz NOT NULL DEFAULT now(),heartbeat_at timestamptz NOT NULL DEFAULT now(),released_at timestamptz
);
CREATE INDEX model_slots_capacity ON model_slots(tenant_id,owner_id,lease_until) WHERE released_at IS NULL;
CREATE TRIGGER demo_generation_write_fence BEFORE INSERT OR UPDATE OR DELETE ON model_slots FOR EACH ROW EXECUTE FUNCTION assert_demo_tenant_write();
