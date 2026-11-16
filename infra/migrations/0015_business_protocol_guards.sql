ALTER TABLE model_generation_tasks DROP CONSTRAINT model_generation_tasks_operation_check;
ALTER TABLE model_generation_tasks ADD CONSTRAINT model_generation_tasks_operation_check CHECK(operation IN('travel.proposal','expense.proposal','rule.proposal','knowledge.answer'));
-- 0011之后新增的领域表同样必须受最终事务代际屏障保护。
DO $$
DECLARE item record;
BEGIN
 FOR item IN SELECT c.table_schema,c.table_name FROM information_schema.columns c
   JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
   WHERE c.table_schema=current_schema() AND c.column_name='tenant_id' AND t.table_type='BASE TABLE' AND c.table_name NOT LIKE 'demo_%'
   AND NOT EXISTS(SELECT 1 FROM pg_trigger g JOIN pg_class cl ON cl.oid=g.tgrelid JOIN pg_namespace ns ON ns.oid=cl.relnamespace WHERE ns.nspname=c.table_schema AND cl.relname=c.table_name AND g.tgname='demo_generation_write_fence')
 LOOP
   EXECUTE format('CREATE TRIGGER demo_generation_write_fence BEFORE INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION assert_demo_tenant_write()',item.table_schema,item.table_name);
 END LOOP;
END;
$$;
