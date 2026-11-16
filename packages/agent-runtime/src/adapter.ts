import type { RunBudgets, RunCheckpoint } from '@caixiaozhi/contracts/runs';
import type { ToolResult } from '@caixiaozhi/contracts';

export type StopReason =
  'user_cancel' | 'lease_lost' | 'budget_limit' | 'shutdown';
export type RuntimeTool = {
  name: string;
  version: string;
  description: string;
  input_schema: Record<string, unknown>;
  effect: 'read' | 'propose';
};
export type NormalizedRuntimeEvent =
  | { type: 'response_delta'; text: string }
  | { type: 'response_complete'; text: string; message_id: string }
  | { type: 'tool_call'; call_id: string; name: string }
  | {
      type: 'usage';
      input_tokens: number;
      output_tokens: number;
      cached_tokens: number;
      model_calls: number;
    }
  | { type: 'checkpoint'; checkpoint: RunCheckpoint }
  | { type: 'idle' }
  | { type: 'error'; code: string; message: string };
export type RuntimeStart = {
  run_id: string;
  thread_id: string | null;
  lease_epoch: number;
  origin: 'conversation' | 'subscription';
  occurrence_id: string | null;
  context_bundle_ref: string;
  profile_version: string;
  tool_catalog_ref: string;
  session_store_ref: string;
  budgets: RunBudgets;
  /** 仅可信 Worker 注入，不进入模型、事件或持久化 payload。 */
  assert_model_slot?: () => Promise<void>;
};
export type RuntimeContinue = RuntimeStart & { checkpoint_id: string };
export type RuntimeHandle = {
  runtime_instance_id: string;
  runtime_session_id: string;
  events: AsyncIterable<NormalizedRuntimeEvent>;
};
export type StopResult = {
  process_stopped: boolean;
  pending_call_ids: string[];
  persistence_state: 'flushed' | 'uncertain';
};
export interface AgentRuntimeAdapter {
  start(input: RuntimeStart): Promise<RuntimeHandle>;
  continue(input: RuntimeContinue): Promise<RuntimeHandle>;
  stop(handle: RuntimeHandle, reason: StopReason): Promise<StopResult>;
  dispose(handle: RuntimeHandle): Promise<void>;
}
export type RuntimeCapabilities = {
  native_prompt_cancel: false;
  process_per_run: true;
  session_persistence: 'jsonl';
  semantic_resume: 'application_checkpoint';
  profile_version: string;
  sdk_version: string;
};
/** 仅由 Worker 的可信数据库/服务组装，禁止从 HTTP/model 参数转发 cwd/env。 */
export type RuntimeMaterial = {
  tenant_id: string;
  owner_id: string;
  prompt: string;
  tools: RuntimeTool[];
  checkpoint?: RunCheckpoint | null;
  resume_input?: unknown;
  completed_tools?: Array<{
    call_id: string;
    name: string;
    result: ToolResult;
  }>;
  dispatch: (input: {
    call_id: string;
    name: string;
    version: string;
    arguments: unknown;
  }) => Promise<ToolResult>;
  beforeModelCall?: () => Promise<void>;
  validateContext?: () => Promise<void>;
  afterToolResult?: (
    call: {
      call_id: string;
      name: string;
      version: string;
      arguments: unknown;
    },
    result: ToolResult,
  ) => Promise<RunCheckpoint | null>;
};
