import type { Grant } from '@caixiaozhi/contracts/identity';
import type { Role } from '@caixiaozhi/contracts/common';

export const DEMO_SEED_VERSION = 'finance-agent-v1.0';
export const DEMO_IDENTITIES: ReadonlyArray<{
  id: string;
  name: string;
  departmentId: string;
  position: string;
  roles: Role[];
}> = [
  {
    id: 'u-li',
    name: '李娜',
    departmentId: 'dept-sales',
    position: '销售专员',
    roles: ['employee'],
  },
  {
    id: 'u-wang',
    name: '王强',
    departmentId: 'dept-sales',
    position: '销售专员',
    roles: ['employee'],
  },
  {
    id: 'u-zhang',
    name: '张伟',
    departmentId: 'dept-sales',
    position: '销售主管',
    roles: ['employee', 'manager'],
  },
  {
    id: 'u-liu',
    name: '刘敏',
    departmentId: 'dept-finance',
    position: '财务审核',
    roles: ['employee', 'finance'],
  },
  {
    id: 'u-zhao',
    name: '赵磊',
    departmentId: 'dept-it',
    position: '平台管理员',
    roles: ['platform_admin'],
  },
  {
    id: 'u-chen',
    name: '陈杰',
    departmentId: 'dept-tech',
    position: '技术工程师',
    roles: ['employee'],
  },
  {
    id: 'u-sun',
    name: '孙静',
    departmentId: 'dept-tech',
    position: '技术主管',
    roles: ['employee', 'manager'],
  },
];
export const DEMO_DEPARTMENTS = [
  { id: 'dept-sales', name: '销售部', manager: 'u-zhang' },
  { id: 'dept-tech', name: '技术部', manager: 'u-sun' },
  { id: 'dept-finance', name: '财务部', manager: 'u-liu' },
  { id: 'dept-it', name: '信息技术部', manager: 'u-zhao' },
] as const;
export const DEMO_GROUPS = [
  { id: 'g-finance-demo', name: '演示财务组', members: ['u-liu'] },
  { id: 'g-sales-managers', name: '销售主管组', members: ['u-zhang'] },
  { id: 'g-tech-managers', name: '技术主管组', members: ['u-sun'] },
] as const;

const ownCapabilities = [
  'travel.read.own',
  'travel.write.own',
  'expense.read.own',
  'expense.write.own',
  'oa.read.own',
  'oa.write.own',
  'rule.manage.personal',
  'skill.manage',
] as const;
const sharedSkills = [
  'skill-preaudit',
  'skill-rules',
  'skill-travel',
  'skill-analytics',
  'skill-knowledge',
];
export function createDemoGrantManifest(
  environmentId = 'demo-default',
): Record<string, Grant[]> {
  const manifest: Record<string, Grant[]> = {};
  for (const person of DEMO_IDENTITIES) {
    const grants: Grant[] = [];
    if (person.roles.includes('employee')) {
      for (const capability of ownCapabilities)
        grants.push({
          capability,
          scope_type: 'self',
          scope_ids: [person.id],
          effect: 'allow',
        });
      grants.push({
        capability: 'skill.use',
        scope_type: 'named_resource',
        scope_ids: [...sharedSkills],
        effect: 'allow',
      });
    }
    const departments =
      person.id === 'u-liu'
        ? ['dept-sales', 'dept-tech']
        : person.id === 'u-zhang'
          ? ['dept-sales']
          : person.id === 'u-sun'
            ? ['dept-tech']
            : [];
    if (departments.length) {
      for (const capability of [
        'travel.read.department',
        'expense.read.department',
        'oa.read.department',
        'analytics.query',
      ] as const)
        grants.push({
          capability,
          scope_type: 'department',
          scope_ids: [...departments],
          effect: 'allow',
        });
      grants.push({
        capability: 'approval.decide',
        scope_type: 'assigned_task',
        scope_ids: [...departments],
        effect: 'allow',
      });
    }
    if (person.id === 'u-zhang' || person.id === 'u-liu')
      grants.push({
        capability: 'analytics.export',
        scope_type: 'department',
        scope_ids: [...departments],
        effect: 'allow',
      });
    if (person.id === 'u-liu') {
      grants.push(
        {
          capability: 'skill.manage',
          scope_type: 'operations',
          scope_ids: ['skill-share:tenant'],
          effect: 'allow',
        },
        {
          capability: 'skill.manage',
          scope_type: 'named_resource',
          scope_ids: ['g-finance-demo'],
          effect: 'allow',
        },
      );
      grants.push({
        capability: 'rule.manage.company',
        scope_type: 'department',
        scope_ids: ['dept-sales', 'dept-tech'],
        effect: 'allow',
      });
      grants.push({
        capability: 'knowledge.manage',
        scope_type: 'named_resource',
        scope_ids: ['pol-expense'],
        effect: 'allow',
      });
    }
    if (person.id === 'u-zhao')
      for (const capability of [
        'integration.manage',
        'operations.read',
        'operations.manage',
        'demo.control',
      ] as const)
        grants.push({
          capability,
          scope_type: 'operations',
          scope_ids: [environmentId],
          effect: 'allow',
        });
    manifest[person.id] = grants;
  }
  return manifest;
}
