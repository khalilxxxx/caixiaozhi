import { describe, expect, it } from 'vitest';
import {
  availableTeamSkill,
  selectionForTeam,
  type ExpertTeam,
} from '../../apps/web/src/demos/agent-workspace/expert-team-catalog';

const base: ExpertTeam = {
  id: 'finance-review-team',
  name: '财务核验专家团',
  description: '',
  members: [],
  examples: [],
  connectors: [
    { id: 'bills', name: '单据', status: 'available', scope: '本工作区' },
    { id: 'rules', name: '制度', status: 'available', scope: '已发布' },
    { id: 'qcc', name: '企查查', status: 'unavailable', scope: '未接入' },
  ],
  skills: [
    { id: 'one', name: '材料', description: '', connectorIds: ['bills'] },
    {
      id: 'two',
      name: '预审',
      description: '',
      connectorIds: ['bills', 'rules'],
    },
    { id: 'three', name: '主体', description: '', connectorIds: ['qcc'] },
  ],
};

describe('个人专家团能力组合', () => {
  it('根据所选技能绑定真实依赖，合并共享数据源，忽略过期选项', () => {
    expect(selectionForTeam(base, ['one', 'two', 'removed'])).toEqual({
      skillIds: ['one', 'two'],
      connectorIds: ['bills', 'rules'],
    });
  });
  it('缺失或尚未接入的依赖无法加入个人专家团', () => {
    expect(availableTeamSkill(base.skills[2]!, base.connectors)).toBe(false);
    expect(availableTeamSkill(base.skills[0]!, [])).toBe(false);
    expect(selectionForTeam(base, ['one', 'three'])).toEqual({
      skillIds: ['one'],
      connectorIds: ['bills'],
    });
  });
});
