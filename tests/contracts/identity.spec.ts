import { describe, expect, it } from 'vitest';
import {
  GrantSchema,
  DemoLoginInputSchema,
  PlaceResolutionSchema,
} from '@caixiaozhi/contracts/identity';

describe('身份与主数据合同', () => {
  it('拒绝客户端自报角色和租户', () => {
    expect(
      DemoLoginInputSchema.safeParse({
        demo_environment_id: 'demo-default',
        generation: 1,
        selected_user_id: 'u-li',
        tenant_id: 'other',
        roles: ['finance'],
      }).success,
    ).toBe(false);
  });
  it('授权必须是固定能力和明确范围，拒绝通配符', () => {
    const grant = {
      capability: 'expense.read.department',
      scope_type: 'department',
      scope_ids: ['dept-sales'],
      effect: 'allow',
    };
    expect(GrantSchema.safeParse(grant).success).toBe(true);
    expect(GrantSchema.safeParse({ ...grant, scope_ids: ['*'] }).success).toBe(
      false,
    );
    expect(
      GrantSchema.safeParse({ ...grant, capability: 'analytics.read' }).success,
    ).toBe(false);
    expect(GrantSchema.safeParse({ ...grant, scope_ids: [] }).success).toBe(
      false,
    );
  });
  it('多候选城市不能标成已唯一确定', () => {
    const candidate = {
      place_id: 'city-beijing',
      name: '北京',
      level: 'city',
      standard_code: '110100',
      province_name: '北京市',
      parent_city: null,
      reason: '标准城市',
    };
    expect(
      PlaceResolutionSchema.safeParse({
        input: '朝阳',
        mapping_version: 'city-map-v1',
        requires_selection: false,
        candidates: [candidate, { ...candidate, place_id: 'city-chaoyang' }],
      }).success,
    ).toBe(false);
  });
});
