CREATE TABLE threads (
 id text PRIMARY KEY, tenant_id text NOT NULL, owner_id text NOT NULL,version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 80),active_run_id text REFERENCES agent_runs(id),
 last_message_seq integer NOT NULL DEFAULT 0,deleted_at timestamptz,UNIQUE(tenant_id,id),UNIQUE(tenant_id,owner_id,id)
);
CREATE INDEX threads_owner ON threads(tenant_id,owner_id,updated_at DESC,id) WHERE deleted_at IS NULL;
CREATE TABLE messages (
 id text PRIMARY KEY,tenant_id text NOT NULL,owner_id text NOT NULL,version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 thread_id text NOT NULL,seq integer NOT NULL,role text NOT NULL CHECK(role IN('user','assistant','system_notice')),
 content text NOT NULL,client_message_id text,run_id text REFERENCES agent_runs(id),
 status text NOT NULL CHECK(status IN('accepted','pending_consumption','final','failed')),
 resource_refs jsonb NOT NULL DEFAULT '[]',attachment_ids jsonb NOT NULL DEFAULT '[]',
 FOREIGN KEY(tenant_id,owner_id,thread_id) REFERENCES threads(tenant_id,owner_id,id),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,thread_id,seq),UNIQUE(tenant_id,owner_id,client_message_id)
);
CREATE TABLE cards (
 id text PRIMARY KEY,tenant_id text NOT NULL,owner_id text NOT NULL,version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),thread_id text NOT NULL,
 message_id text NOT NULL,run_id text REFERENCES agent_runs(id),type text NOT NULL,schema_version integer NOT NULL DEFAULT 1,
 card jsonb NOT NULL,revision integer NOT NULL,snapshot_at timestamptz NOT NULL,finalized_at timestamptz,
 FOREIGN KEY(tenant_id,owner_id,thread_id) REFERENCES threads(tenant_id,owner_id,id),
 FOREIGN KEY(tenant_id,message_id) REFERENCES messages(tenant_id,id),UNIQUE(tenant_id,id)
);
CREATE TABLE thread_entry_bindings (
 tenant_id text NOT NULL,owner_id text NOT NULL,entry_key text NOT NULL,thread_id text NOT NULL,version integer NOT NULL DEFAULT 1,
 last_opened_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,owner_id,entry_key),
 FOREIGN KEY(tenant_id,owner_id,thread_id) REFERENCES threads(tenant_id,owner_id,id)
);
CREATE TABLE assistant_commands (
 tenant_id text NOT NULL,owner_id text NOT NULL,operation text NOT NULL,key text NOT NULL,payload_hash text NOT NULL,
 result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '180 days',
 PRIMARY KEY(tenant_id,owner_id,operation,key)
);
CREATE TABLE memory_profiles (
 tenant_id text NOT NULL,owner_id text NOT NULL,memory_epoch integer NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,owner_id)
);
CREATE TABLE memories (
 id text PRIMARY KEY,tenant_id text NOT NULL,owner_id text NOT NULL,version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 kind text NOT NULL CHECK(kind IN('response_preference','input_preference','personal_context')),key text NOT NULL,
 content text, value_json jsonb,status text NOT NULL CHECK(status IN('active','expired','source_unavailable','deleted')),
 source_kind text NOT NULL CHECK(source_kind IN('manual','explicit_message')),source_message_id text,expires_at timestamptz,deleted_at timestamptz,
 FOREIGN KEY(tenant_id,source_message_id) REFERENCES messages(tenant_id,id),UNIQUE(tenant_id,id)
);
CREATE UNIQUE INDEX memories_active_key ON memories(tenant_id,owner_id,kind,key) WHERE status='active';
CREATE TABLE memory_revisions (
 tenant_id text NOT NULL,memory_id text NOT NULL,revision integer NOT NULL,content text,value_json jsonb,
 change_reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,memory_id) REFERENCES memories(tenant_id,id),PRIMARY KEY(tenant_id,memory_id,revision)
);
CREATE TABLE memory_source_tombstones (
 tenant_id text NOT NULL,owner_id text NOT NULL,source_key text NOT NULL,invalidated_at timestamptz NOT NULL DEFAULT now(),reason text NOT NULL,
 PRIMARY KEY(tenant_id,owner_id,source_key)
);
CREATE TABLE subscriptions (
 id text PRIMARY KEY,tenant_id text NOT NULL,owner_id text NOT NULL,version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 type text NOT NULL,title text NOT NULL,query_spec jsonb NOT NULL,schedule_json jsonb NOT NULL,schedule_version integer NOT NULL DEFAULT 1,
 status text NOT NULL CHECK(status IN('active','paused','blocked','deleted')),next_run_at timestamptz NOT NULL,skill_version_id text,
 delegation_id text NOT NULL,scope_authz_version integer NOT NULL,generation integer NOT NULL DEFAULT 0,error_code text,UNIQUE(tenant_id,id)
);
CREATE INDEX subscriptions_due ON subscriptions(next_run_at,id) WHERE status='active';
CREATE TABLE subscription_occurrences (
 id text PRIMARY KEY,tenant_id text NOT NULL,owner_id text NOT NULL,version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),subscription_id text NOT NULL,
 schedule_version integer NOT NULL,local_date date NOT NULL,local_time text NOT NULL,scheduled_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN('scheduled','generating','generated','delivered','failed','skipped_coalesced','skipped_late','superseded','cancelled','delivery_expired')),
 origin_run_id text REFERENCES agent_runs(id),summary_id text,error_code text,dst_adjusted boolean NOT NULL DEFAULT false,
 FOREIGN KEY(tenant_id,subscription_id) REFERENCES subscriptions(tenant_id,id),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,subscription_id,schedule_version,local_date,local_time)
);
CREATE TABLE digest_snapshots (
 id text PRIMARY KEY,tenant_id text NOT NULL,owner_id text NOT NULL,version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),occurrence_id text NOT NULL,
 query_spec jsonb NOT NULL,source_refs jsonb NOT NULL,coverage text NOT NULL,generated_at timestamptz NOT NULL,
 content_json jsonb NOT NULL,status text NOT NULL,authz_version integer NOT NULL,
 FOREIGN KEY(tenant_id,occurrence_id) REFERENCES subscription_occurrences(tenant_id,id),UNIQUE(tenant_id,id),UNIQUE(tenant_id,occurrence_id)
);
CREATE TABLE inbox_items (
 id text PRIMARY KEY,tenant_id text NOT NULL,owner_id text NOT NULL,version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),occurrence_id text NOT NULL,
 channel text NOT NULL DEFAULT 'in_app' CHECK(channel='in_app'),title text NOT NULL,preview text NOT NULL,summary_id text NOT NULL,
 revision integer NOT NULL DEFAULT 1,thread_id text,card_id text,deleted_at timestamptz,
 FOREIGN KEY(tenant_id,occurrence_id) REFERENCES subscription_occurrences(tenant_id,id),
 FOREIGN KEY(tenant_id,summary_id) REFERENCES digest_snapshots(tenant_id,id),FOREIGN KEY(tenant_id,thread_id) REFERENCES threads(tenant_id,id),
 FOREIGN KEY(tenant_id,card_id) REFERENCES cards(tenant_id,id),UNIQUE(tenant_id,id),UNIQUE(tenant_id,occurrence_id,channel)
);
CREATE TABLE inbox_reads (
 tenant_id text NOT NULL,owner_id text NOT NULL,item_id text NOT NULL,read_revision integer NOT NULL,read_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,item_id) REFERENCES inbox_items(tenant_id,id),PRIMARY KEY(tenant_id,owner_id,item_id)
);
