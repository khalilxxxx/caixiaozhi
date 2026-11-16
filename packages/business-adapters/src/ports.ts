import type {
  ActorContext,
  ActionReceipt,
  ResourceRef,
} from '@caixiaozhi/contracts';
import type {
  ActionName,
  DependencyRef,
  TaskRef,
} from '@caixiaozhi/contracts/actions';
import type { DatabaseExecutor } from '@caixiaozhi/platform/database';
export type UnitOfWork = DatabaseExecutor;
export type PreparedActionItem = {
  resource_ref: ResourceRef | null;
  task_ref?: TaskRef | null;
  args?: unknown;
  guards?: Record<string, unknown>;
};
export type PreparedDomainAction = {
  summary: unknown;
  args?: unknown;
  dependency_refs?: DependencyRef[];
  extra_guards?: Record<string, unknown>;
  items?: PreparedActionItem[];
};
export type ActionContext = {
  actor: ActorContext;
  action_id: string;
  item_id: string;
  idempotency_key: string;
  external_request_id: string;
  run_id: string | null;
  trace_id: string | null;
  generation: number;
};
export type ConfirmedAction<A = unknown> = {
  id: string;
  operation: ActionName;
  args: A;
  resource_refs: ResourceRef[];
  item: PreparedActionItem & { id: string; ordinal: number };
  confirmation: {
    id: string;
    args_hash: string;
    summary_hash: string;
    dependency_refs: DependencyRef[];
    extra_guards: Record<string, unknown>;
  };
};
export interface ActionHandler<A = unknown> {
  mode?: 'local' | 'remote';
  validate(
    actor: ActorContext,
    args: A,
    refs: ResourceRef[],
    tx?: UnitOfWork,
  ): Promise<PreparedDomainAction>;
  execute(
    ctx: ActionContext,
    tx: UnitOfWork | null,
    action: ConfirmedAction<A>,
  ): Promise<ActionReceipt>;
  queryOutcome(
    ctx: ActionContext,
    action: ConfirmedAction<A>,
  ): Promise<ActionReceipt>;
}
export type AdapterContext = {
  actor: ActorContext;
  run_id: string | null;
  trace_id: string;
  deadline_at: string;
  credential_handle?: unknown;
};
export type DocumentSnapshot = {
  resource_ref: ResourceRef;
  data: unknown;
  data_mode: 'demo' | 'production';
};
export interface BusinessAdapter {
  readDocument(
    ctx: AdapterContext,
    ref: ResourceRef,
  ): Promise<DocumentSnapshot>;
  execute(ctx: AdapterContext, action: ConfirmedAction): Promise<ActionReceipt>;
  getReceipt(
    ctx: AdapterContext,
    actionId: string,
    idempotencyKey: string,
  ): Promise<ActionReceipt>;
}
export type WorkflowRunRef = {
  external_run_id: string;
  connector_id: string;
  data_mode: 'demo' | 'production';
};
export type WorkflowResult = {
  status: 'running' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';
  output: unknown;
  data_mode: 'demo' | 'production';
};
export interface WorkflowAdapter {
  start(
    ctx: AdapterContext,
    operation: string,
    input: unknown,
  ): Promise<WorkflowRunRef>;
  get(ctx: AdapterContext, ref: WorkflowRunRef): Promise<WorkflowResult>;
  cancel?(
    ctx: AdapterContext,
    ref: WorkflowRunRef,
  ): Promise<{ accepted: boolean }>;
}
