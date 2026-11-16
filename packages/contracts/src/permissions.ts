import { z } from 'zod';

export const PermissionSchema = z.enum([
  'travel.read.own',
  'travel.write.own',
  'expense.read.own',
  'expense.write.own',
  'oa.read.own',
  'oa.write.own',
  'travel.read.department',
  'expense.read.department',
  'oa.read.department',
  'approval.decide',
  'rule.manage.personal',
  'rule.manage.company',
  'skill.use',
  'skill.manage',
  'knowledge.manage',
  'analytics.query',
  'analytics.export',
  'integration.manage',
  'operations.read',
  'operations.manage',
  'identity.grant.manage',
  'demo.control',
]);

export type Permission = z.infer<typeof PermissionSchema>;
export const PERMISSIONS = PermissionSchema.options;
