ALTER TABLE demo_scenario_runs ADD COLUMN lease_owner text;
ALTER TABLE demo_scenario_runs ADD COLUMN lease_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE demo_scenario_runs ADD COLUMN lease_until timestamptz;
ALTER TABLE demo_scenario_runs ADD COLUMN baseline_generation integer;
ALTER TABLE demo_scenario_runs ADD COLUMN error_code text;
ALTER TABLE demo_scenario_runs ADD COLUMN outcome text CHECK(outcome IN('succeeded','failed','blocked','cancelled'));
ALTER TABLE demo_scenario_runs ADD COLUMN finished_at timestamptz;
CREATE UNIQUE INDEX demo_one_open_journey ON demo_scenario_runs(env_id) WHERE state IN('queued','running') AND scenario_id LIKE 'E2E-%';
