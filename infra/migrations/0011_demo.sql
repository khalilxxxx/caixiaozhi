CREATE TABLE demo_environments (
 id text PRIMARY KEY,logical_tenant_id text NOT NULL UNIQUE,active_tenant_id text NOT NULL UNIQUE,
 active_generation integer NOT NULL DEFAULT 1,write_fence bigint NOT NULL DEFAULT 1,
 lifecycle text NOT NULL CHECK(lifecycle IN('ready','draining','resetting','verifying','failed','blocked')),
 version integer NOT NULL DEFAULT 1,seed_version text NOT NULL,manifest_hash text,
 business_now timestamptz NOT NULL DEFAULT '2026-11-05T03:00:00Z',timezone text NOT NULL DEFAULT 'Asia/Shanghai',clock_version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE demo_generation_manifests (
 env_id text NOT NULL REFERENCES demo_environments(id),generation integer NOT NULL,namespace_ref text NOT NULL UNIQUE,
 seed_version text NOT NULL,seed_hash text NOT NULL,manifest jsonb NOT NULL,
 state text NOT NULL CHECK(state IN('building','verified','active','archived','failed')),verified_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(env_id,generation)
);
CREATE TABLE demo_reset_jobs (
 id text PRIMARY KEY,env_id text NOT NULL REFERENCES demo_environments(id),old_generation integer NOT NULL,new_generation integer NOT NULL,
 old_tenant_id text NOT NULL,new_tenant_id text NOT NULL,scenario_id text NOT NULL,seed_version text NOT NULL,
 state text NOT NULL CHECK(state IN('queued','running','succeeded','failed','blocked')),phase text NOT NULL,
 requested_by text NOT NULL,error_code text,version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX demo_reset_one_active ON demo_reset_jobs(env_id) WHERE state IN('queued','running','blocked');
CREATE TABLE demo_control_commands (
 env_id text NOT NULL REFERENCES demo_environments(id),actor_id text NOT NULL,operation text NOT NULL,key text NOT NULL,payload_hash text NOT NULL,
 result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '180 days',
 PRIMARY KEY(env_id,actor_id,operation,key)
);
CREATE TABLE demo_fault_injections (
 id text PRIMARY KEY,env_id text NOT NULL REFERENCES demo_environments(id),generation integer NOT NULL,kind text NOT NULL,scope_alias text NOT NULL,
 remaining_hits integer NOT NULL CHECK(remaining_hits>=0),expires_at timestamptz NOT NULL,
 state text NOT NULL CHECK(state IN('armed','exhausted','expired','disabled')),version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE demo_scenario_runs (
 id text PRIMARY KEY,env_id text NOT NULL REFERENCES demo_environments(id),generation integer NOT NULL,scenario_id text NOT NULL,
 state text NOT NULL CHECK(state IN('queued','running','passed','failed','cancelled')),evidence jsonb NOT NULL DEFAULT '[]',
 requested_by text NOT NULL,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE demo_control_audit (
 id text PRIMARY KEY,env_id text NOT NULL REFERENCES demo_environments(id),actor_id text NOT NULL,operation text NOT NULL,
 before_generation integer,after_generation integer,job_id text,trace_id text NOT NULL,occurred_at timestamptz NOT NULL DEFAULT now()
);

-- 数据库最终写入屏障：raw pg 与 Drizzle 同样受保护。
-- 环境控制器的窄维护事务显式设置 caixiaozhi.demo_control=on；业务/API 不设置。
CREATE FUNCTION assert_demo_tenant_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_tenant text; target_env text; active_tenant text; env_lifecycle text; namespace_state text;
BEGIN
 IF current_setting('caixiaozhi.demo_control',true)='on' THEN
   IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 IF TG_OP='UPDATE' AND NEW.tenant_id<>OLD.tenant_id THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='DEMO_TENANT_IMMUTABLE';
 END IF;
 -- 维护时仍可读取控制进度、注销旧会话及核实已在途回执；不允许启动新动作。
 IF TG_TABLE_NAME='identity_sessions' AND TG_OP='UPDATE' THEN
   IF (to_jsonb(NEW)-ARRAY['last_seen_at','updated_at','revoked_at','version'])=(to_jsonb(OLD)-ARRAY['last_seen_at','updated_at','revoked_at','version'])
      AND (OLD.revoked_at IS NULL OR NEW.revoked_at IS NOT NULL) THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='actions' AND TG_OP='UPDATE' THEN
   IF OLD.state IN('unknown','executing') AND NEW.state IN('unknown','executing','succeeded','rejected','failed')
      AND NEW.args=OLD.args AND NEW.resource_refs=OLD.resource_refs AND NEW.operation=OLD.operation THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='action_items' AND TG_OP='UPDATE' THEN
   IF OLD.state IN('unknown','executing') AND NEW.state IN('unknown','executing','succeeded','rejected','failed')
      AND NEW.args=OLD.args AND NEW.resource_ref IS NOT DISTINCT FROM OLD.resource_ref THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME IN('action_receipts','action_audit','authz_audit') AND TG_OP<>'DELETE' THEN
   IF TG_OP='INSERT' THEN RETURN NEW; END IF;
   IF TG_TABLE_NAME='action_receipts' THEN
     IF NEW.action_id=OLD.action_id AND OLD.outcome='unknown' THEN RETURN NEW; END IF;
   END IF;
 END IF;
 IF TG_TABLE_NAME='outbox_events' AND TG_OP<>'DELETE' THEN
   IF NEW.event_type LIKE 'action.%' THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='durable_jobs' THEN
   IF TG_OP='DELETE' THEN
     IF OLD.owner_module='demo' AND OLD.kind='demo.reset' THEN RETURN OLD; END IF;
   ELSE
     IF NEW.owner_module='demo' AND NEW.kind='demo.reset' THEN RETURN NEW; END IF;
   END IF;
 END IF;
 IF TG_OP='DELETE' THEN target_tenant:=OLD.tenant_id; ELSE target_tenant:=NEW.tenant_id; END IF;
 SELECT e.id INTO target_env FROM demo_environments e
 WHERE e.active_tenant_id=target_tenant OR EXISTS(SELECT 1 FROM demo_generation_manifests g WHERE g.env_id=e.id AND g.namespace_ref=target_tenant) LIMIT 1;
 IF target_env IS NOT NULL THEN
   PERFORM pg_advisory_xact_lock_shared(hashtextextended('demo-write:'||target_env,0));
   SELECT e.active_tenant_id,e.lifecycle INTO active_tenant,env_lifecycle FROM demo_environments e WHERE e.id=target_env FOR SHARE;
   SELECT g.state INTO namespace_state FROM demo_generation_manifests g WHERE g.env_id=target_env AND g.namespace_ref=target_tenant;
   IF namespace_state='building' THEN
     -- 未激活命名空间只供私有初始化；服务身份门禁拒绝其普通会话。
     NULL;
   ELSIF active_tenant<>target_tenant OR env_lifecycle<>'ready' THEN
     RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='DEMO_GENERATION_FENCED';
   END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
DO $$
DECLARE item record;
BEGIN
 FOR item IN SELECT c.table_schema,c.table_name FROM information_schema.columns c
   JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
   WHERE c.table_schema=current_schema() AND c.column_name='tenant_id' AND t.table_type='BASE TABLE' AND c.table_name NOT LIKE 'demo_%'
 LOOP
   EXECUTE format('CREATE TRIGGER demo_generation_write_fence BEFORE INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION assert_demo_tenant_write()',item.table_schema,item.table_name);
 END LOOP;
END;
$$;
