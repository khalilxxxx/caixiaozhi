SELECT set_config('caixiaozhi.demo_control','on',true);
ALTER TABLE run_events ADD COLUMN authz_version integer NOT NULL DEFAULT 1 CHECK(authz_version>0);
ALTER TABLE messages ADD COLUMN authz_version integer NOT NULL DEFAULT 1 CHECK(authz_version>0);
ALTER TABLE cards ADD COLUMN authz_version integer NOT NULL DEFAULT 1 CHECK(authz_version>0);
UPDATE run_events e SET authz_version=r.authz_version FROM agent_runs r WHERE e.run_id=r.id;
UPDATE messages m SET authz_version=r.authz_version FROM agent_runs r WHERE m.run_id=r.id;
UPDATE cards c SET authz_version=r.authz_version FROM agent_runs r WHERE c.run_id=r.id;
