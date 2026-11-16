import { randomUUID } from 'node:crypto';
import type {
  AgentRuntimeAdapter,
  RuntimeHandle,
  RuntimeStart,
  LeasedRun,
  RunService,
  StopReason,
  ModelSlotLease,
  ModelSlotService,
} from '@caixiaozhi/agent-runtime';
import { AppError } from '@caixiaozhi/platform/errors';

export type WorkerRunnerOptions = {
  runs: RunService;
  runtime: AgentRuntimeAdapter;
  buildInput?: (leased: LeasedRun) => Promise<RuntimeStart>;
  freshActor: (actor: LeasedRun['actor']) => Promise<LeasedRun['actor']>;
  claimScope?: () => Promise<{ tenant_id?: string }>;
  workerId?: string;
  concurrency?: number;
  pollMs?: number;
  log?: (event: { event: string; run_id?: string; code?: string }) => void;
  onSuspended?: (
    leased: LeasedRun,
    checkpointId: string,
    checkpoint: import('@caixiaozhi/contracts/runs').RunCheckpoint,
  ) => Promise<void>;
  modelSlots?: ModelSlotService;
};
export function createWorkerRunner(options: WorkerRunnerOptions) {
  const workerId = options.workerId ?? `worker-${randomUUID()}`;
  const active = new Map<
    string,
    {
      promise: Promise<void>;
      handle?: RuntimeHandle;
      epoch: number;
      settleElapsed?: () => Promise<unknown>;
    }
  >();
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopping = false;
  let ticking = false;
  let ticks = 0;
  const log = options.log ?? (() => {});
  async function execute(leased: LeasedRun) {
    const { run, lease_epoch: epoch } = leased;
    let handle: RuntimeHandle | undefined;
    const modelSlots = options.modelSlots ?? options.runs.modelSlots;
    let slot: ModelSlotLease | null = null;
    let control: ReturnType<typeof setInterval> | undefined;
    let controlBusy = false;
    let stopped: StopReason | null = null;
    const started = Date.now();
    // 同一epoch的挂起、终态、异常和停机共享结算，重入只等待原事务，不能重复加账。
    let elapsedSettlement: Promise<unknown> | undefined;
    const settleElapsed = () => {
      elapsedSettlement ??= options.runs.recordUsage(run.id, epoch, {
        elapsed_ms: Math.max(0, Date.now() - started),
      });
      return elapsedSettlement;
    };
    const activeEntry = active.get(run.id);
    if (activeEntry) activeEntry.settleElapsed = settleElapsed;
    let lastHeartbeat = Date.now();
    try {
      leased.actor = await options.freshActor(leased.actor);
      await options.runs.assertLease(run.id, epoch);
      slot = await modelSlots.acquire({
        tenant_id: run.tenant_id,
        owner_id: run.owner_id,
        kind: 'agent_run',
        reference_id: run.id,
        owner_epoch: epoch,
        lease_owner: workerId,
      });
      if (!slot) {
        await options.runs.requeueRun(run.id, epoch, 1000);
        return;
      }
      const input: RuntimeStart = (await options.buildInput?.(leased)) ?? {
        run_id: run.id,
        thread_id: run.thread_id,
        lease_epoch: epoch,
        origin: run.origin,
        occurrence_id: run.occurrence_id,
        context_bundle_ref: run.id,
        profile_version: 'finance-sdk-v1',
        tool_catalog_ref: run.id,
        session_store_ref: run.id,
        budgets: run.budgets,
      };
      const ownedSlot = slot;
      input.budgets = {
        model_calls: run.budgets.model_calls - run.usage.model_calls,
        tool_calls: Math.max(0, run.budgets.tool_calls - run.usage.tool_calls),
        output_tokens: run.budgets.output_tokens - run.usage.output_tokens,
        active_ms: run.budgets.active_ms - run.usage.elapsed_ms,
      };
      if (
        input.budgets.model_calls <= 0 ||
        input.budgets.output_tokens <= 0 ||
        input.budgets.active_ms <= 0
      )
        throw new AppError('RATE_LIMITED', '任务已达到可用运行预算。', {
          details: { reason: 'RUN_BUDGET_EXCEEDED' },
        });
      input.assert_model_slot = () => modelSlots.assert(ownedSlot);
      handle = run.checkpoint_id
        ? await options.runtime.continue({
            ...input,
            checkpoint_id: run.checkpoint_id,
          })
        : await options.runtime.start(input);
      const entry = active.get(run.id);
      if (entry) entry.handle = handle;
      const currentHandle = handle;
      control = setInterval(() => {
        if (controlBusy || stopped) return;
        controlBusy = true;
        void (async () => {
          if (Date.now() - started >= input.budgets.active_ms) {
            stopped = 'budget_limit';
            await options.runtime.stop(currentHandle, 'budget_limit');
            return;
          }
          if (await options.runs.isCancelRequested(run.id, epoch)) {
            stopped = 'user_cancel';
            await options.runtime.stop(currentHandle, 'user_cancel');
            return;
          }
          if (Date.now() - lastHeartbeat >= 10000) {
            await options.runs.heartbeat(run.id, epoch, workerId);
            await modelSlots.heartbeat(ownedSlot);
            lastHeartbeat = Date.now();
          }
        })()
          .catch(async () => {
            stopped = 'lease_lost';
            await options.runtime.stop(currentHandle, 'lease_lost');
          })
          .finally(() => {
            controlBusy = false;
          });
      }, 500);
      let completed = false;
      let suspended = false;
      let savedCheckpoint: {
        id: string;
        checkpoint: import('@caixiaozhi/contracts/runs').RunCheckpoint;
      } | null = null;
      let failed: string | null = null;
      for await (const event of handle.events) {
        if (stopped) break;
        switch (event.type) {
          case 'response_delta':
            await options.runs.appendEvent(run.id, epoch, 'assistant.delta', {
              text: event.text,
            });
            break;
          case 'response_complete':
            await options.runs.appendEvent(run.id, epoch, 'assistant.message', {
              id: event.message_id,
              text: event.text,
            });
            break;
          case 'usage':
            await options.runs.recordUsage(run.id, epoch, {
              input_tokens: event.input_tokens,
              output_tokens: event.output_tokens,
              cached_tokens: event.cached_tokens,
              model_calls: event.model_calls,
            });
            break;
          case 'checkpoint':
            const checkpoint = {
              ...event.checkpoint,
              runtime_session_id: handle.runtime_session_id,
            };
            // saveCheckpoint会释放租约；必须先在当前有效所有权内记入真实活动时间。
            await settleElapsed();
            const id = await options.runs.saveCheckpoint(
              run.id,
              epoch,
              checkpoint,
            );
            savedCheckpoint = { id, checkpoint };
            suspended = true;
            break;
          case 'idle':
            completed = true;
            break;
          case 'error':
            failed = event.code;
            break;
          case 'tool_call':
            break; // M13 dispatch 本身记录 started/completed，避免重复事件。
        }
        if (suspended || failed) break;
      }
      clearInterval(control);
      control = undefined;
      await options.runtime.dispose(handle);
      handle = undefined;
      if (savedCheckpoint)
        await options.onSuspended?.(
          leased,
          savedCheckpoint.id,
          savedCheckpoint.checkpoint,
        );
      if (!suspended && stopped !== 'lease_lost') {
        await settleElapsed();
        await options.runs.finishRun(
          run.id,
          epoch,
          stopped === 'user_cancel'
            ? 'cancelled'
            : failed || stopped === 'budget_limit'
              ? 'failed'
              : completed
                ? 'succeeded'
                : 'interrupted',
          failed ?? (stopped === 'budget_limit' ? 'RUN_BUDGET_EXCEEDED' : null),
        );
      }
    } catch (error) {
      let code =
        error instanceof AppError ? error.code : 'DEPENDENCY_UNAVAILABLE';
      try {
        await settleElapsed();
      } catch (accountingError) {
        if (
          accountingError instanceof AppError &&
          accountingError.code === 'RATE_LIMITED'
        )
          code = 'RATE_LIMITED';
      }
      log({ event: 'run.failed', run_id: run.id, code });
      if (handle)
        await options.runtime.stop(handle, 'shutdown').catch(() => {});
      await options.runs
        .finishRun(run.id, epoch, 'failed', code)
        .catch(() => {});
    } finally {
      clearInterval(control);
      if (handle) await options.runtime.dispose(handle).catch(() => {});
      if (slot) await modelSlots.release(slot).catch(() => {});
      active.delete(run.id);
    }
  }
  async function tick() {
    if (ticking || stopping) return;
    ticking = true;
    try {
      const scope = await options.claimScope?.();
      if (ticks++ % 10 === 0) await options.runs.recoverExpired(scope);
      while (!stopping && active.size < (options.concurrency ?? 2)) {
        const leased = await options.runs.claimRun(workerId, scope);
        if (!leased) break;
        // execute 首次 await 前记录，防止极短任务结束后留下悬挂 active。
        const placeholder = {
          promise: Promise.resolve(),
          epoch: leased.lease_epoch,
        };
        active.set(leased.run.id, placeholder);
        placeholder.promise = execute(leased);
      }
    } catch {
      log({ event: 'worker.poll_failed', code: 'DEPENDENCY_UNAVAILABLE' });
    } finally {
      ticking = false;
    }
  }
  return {
    workerId,
    tick,
    start() {
      if (timer) return;
      stopping = false;
      timer = setInterval(() => {
        void tick();
      }, options.pollMs ?? 500);
      void tick();
    },
    async stop() {
      stopping = true;
      clearInterval(timer);
      timer = undefined;
      for (const [id, entry] of active) {
        if (entry.handle) {
          let budgetExceeded = false;
          try {
            await entry.settleElapsed?.();
          } catch (error) {
            budgetExceeded =
              error instanceof AppError && error.code === 'RATE_LIMITED';
          }
          await options.runtime.stop(entry.handle, 'shutdown');
          await options.runs
            .finishRun(
              id,
              entry.epoch,
              budgetExceeded ? 'failed' : 'interrupted',
              budgetExceeded ? 'RATE_LIMITED' : 'WORKER_SHUTDOWN',
            )
            .catch(() => {});
        }
      }
      await Promise.allSettled(
        [...active.values()].map((entry) => entry.promise),
      );
    },
    async waitForIdle() {
      await Promise.allSettled(
        [...active.values()].map((entry) => entry.promise),
      );
    },
    get activeCount() {
      return active.size;
    },
  };
}
