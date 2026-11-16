import { z } from 'zod';
import type { ActorContext, ToolResult } from './common.js';
export const CapabilityEffectSchema = z.enum(['read', 'propose', 'write']);
export const CapabilityStatusSchema = z.enum([
  'draft',
  'testing',
  'published',
  'disabled',
]);
export type CapabilityEffect = z.infer<typeof CapabilityEffectSchema>;
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;
export type ExecutionContext = {
  /** 由网关从真实tool request注入，不接收模型上下文覆盖。 */
  call_id?: string;
  actor: ActorContext;
  run_id: string;
  lease_epoch: number;
  selected_skill_version_id: string | null;
  allowed_capability_versions: string[];
  deadline_at: string;
};
export type ToolDescriptor = {
  name: string;
  version: string;
  description: string;
  input_schema: Record<string, unknown>;
  effect: 'read' | 'propose';
};
export type CapabilityDefinition = {
  id: string;
  name: string;
  version: string;
  title: string;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  effect: CapabilityEffect;
  required_permissions: string[];
  connector_id: string;
  timeout_ms: number;
  supports_idempotency: boolean;
  supports_receipt_lookup: boolean;
  sensitive_fields?: string[];
};
export type ToolExecutionResult = ToolResult;
export type ConnectorView = {
  id: string;
  name: string;
  system_type: string;
  adapter_kind: 'demo' | 'production';
  environment: 'demo' | 'production';
  status: 'draft' | 'enabled' | 'disabled';
  config_version: number;
  timeout_ms: number;
  max_concurrency: number;
  secret_configured: boolean;
  base_url_configured: boolean;
};
