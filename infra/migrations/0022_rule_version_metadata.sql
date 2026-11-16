-- 规则名称和分类属于具体版本，不能用当前草稿覆盖已发布历史。
ALTER TABLE rule_versions
 ADD COLUMN display_name text,
 ADD COLUMN category text,
 ADD CONSTRAINT rule_version_metadata_pair CHECK (
  (display_name IS NULL AND category IS NULL) OR
  (display_name IS NOT NULL AND length(btrim(display_name)) BETWEEN 1 AND 200
   AND category IS NOT NULL AND category IN ('invoice','transport','lodging','meals','itinerary','general'))
 );

-- 只回填与定义当前指针一致的最新版本。旧发布版存在新草稿时不能证明其历史名称/分类。
UPDATE rule_versions v SET display_name=d.name,category=d.category
 FROM rule_definitions d
 WHERE v.tenant_id=d.tenant_id AND v.rule_id=d.id
 AND NOT EXISTS (SELECT 1 FROM demo_environments env
  WHERE (env.active_tenant_id=v.tenant_id OR EXISTS (
   SELECT 1 FROM demo_generation_manifests generation
   WHERE generation.env_id=env.id AND generation.namespace_ref=v.tenant_id))
  AND (env.active_tenant_id<>v.tenant_id OR env.lifecycle<>'ready'))
 AND v.id=coalesce(d.draft_version_id,d.active_version_id)
 AND v.version_number=(SELECT max(last.version_number) FROM rule_versions last
  WHERE last.tenant_id=v.tenant_id AND last.rule_id=v.rule_id);

CREATE FUNCTION protect_rule_version_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.display_name IS NULL OR NEW.category IS NULL THEN
   RAISE EXCEPTION 'new rule version requires trusted display metadata';
  END IF;
 ELSIF NEW.display_name IS DISTINCT FROM OLD.display_name OR NEW.category IS DISTINCT FROM OLD.category THEN
  RAISE EXCEPTION 'rule version display metadata is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rule_version_metadata_immutable BEFORE INSERT OR UPDATE ON rule_versions
 FOR EACH ROW EXECUTE FUNCTION protect_rule_version_metadata();
