-- 控制命令仅持久化请求；Worker 在控制事务结束后执行领域调度。
CREATE TABLE demo_summary_triggers (
 id text PRIMARY KEY,env_id text NOT NULL REFERENCES demo_environments(id),
 tenant_id text NOT NULL,generation integer NOT NULL,subscription_id text,
 scheduled_for timestamptz NOT NULL,requested_by text NOT NULL,job_id text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','running','scheduled','no_due_subscription','failed','cancelled')),
 result jsonb,error_code text,version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX demo_summary_triggers_pending ON demo_summary_triggers(env_id,created_at,id)
 WHERE status IN('queued','running');
