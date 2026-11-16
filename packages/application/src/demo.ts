import { createApplicationFaults, type ApplicationFaults } from './faults.js';
import { createDemoService } from '@caixiaozhi/demo';
import { seedBusiness, seedInvoiceSamples } from '@caixiaozhi/fixtures';
import {
  installBuiltinCapabilities,
  BUILTIN_CAPABILITIES,
} from '@caixiaozhi/integrations';
import { createApplication, type ApplicationOptions } from './index.js';
import { createDemoScenarioController } from '@caixiaozhi/demo/scenarios';
import { createDemoJourneyRunner } from '@caixiaozhi/demo/journeys';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WORKSPACE_ROOT } from '@caixiaozhi/platform/paths';

/** CLI 显式 initialize；普通 API/Worker 启动只装配，不重置业务。 */
export function createConfiguredApplication(
  options: ApplicationOptions & {
    demoEnvironmentId?: string;
    demoTenantId?: string;
  },
) {
  let demo: ReturnType<typeof createDemoService>;
  let faults: ApplicationFaults | undefined;
  const application = createApplication({
    ...options,
    faults: () => faults,
    businessNow: async () =>
      options.config.appMode === 'demo'
        ? new Date((await demo.businessClock()).business_now)
        : (options.businessNow?.() ?? new Date()),
    generation: async () =>
      options.config.appMode === 'production'
        ? ((await options.generation?.()) ?? 1)
        : (
            await demo.gate.currentTenant(
              options.demoEnvironmentId ?? options.config.demoEnvironmentId,
            )
          ).generation,
    assertCurrentActor: (actor) => demo.gate.assertCurrentActor(actor),
    businessDate: async () =>
      options.config.appMode === 'demo'
        ? new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Shanghai',
          }).format(new Date((await demo.businessClock()).business_now))
        : (options.businessDate?.() ??
          new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Shanghai',
          }).format(new Date())),
  });
  demo = createDemoService(options.database, {
    appMode: options.config.appMode,
    environmentId:
      options.demoEnvironmentId ?? options.config.demoEnvironmentId,
    logicalTenantId: options.demoTenantId ?? options.config.demoTenantId,
    identity: application.identity,
    triggerSubscriptions: (tenantId, at, subscriptionId) =>
      application.memory.scheduleDueSubscriptions(at, 30, {
        tenantId,
        subscriptionId,
      }),
    seedEnvironment: async (input) => {
      await application.identity.seedDemoIdentity({
        tenantId: input.tenantId,
        environmentId: input.environmentId,
        generation: input.generation,
      });
      await seedBusiness({
        database: options.database,
        storage: options.storage,
        tenantId: input.tenantId,
      });
      const session = await application.identity.loginDemo('u-liu', undefined, {
        tenantId: input.tenantId,
        environmentId: input.environmentId,
        generation: input.generation,
      });
      const actor = await application.identity.getActor(session.session_token);
      await application.finance.seedDemo(actor);
      await installBuiltinCapabilities(
        options.database.db,
        input.tenantId,
        BUILTIN_CAPABILITIES,
      );
      await application.skills.seedBuiltinSkills(input.tenantId, {
        owner_id: 'u-liu',
        reviewer_id: 'u-zhang',
        private_owner_id: 'u-liu',
        finance_group_id: 'g-finance-demo',
      });
      const samples = await seedInvoiceSamples(
        options.database,
        input.tenantId,
      );
      await application.identity.logout(session.session_token);
      return { alias_map: { ...samples, 'demo-business': 'demo-business' } };
    },
  });
  if (options.config.appMode === 'demo') {
    faults = createApplicationFaults(options.database, demo, {
      enabledKinds: [
        'ocr.timeout',
        'ocr.low_confidence',
        'preaudit.check_unavailable',
        'action.response_lost_after_commit',
        'adapter.write_outcome_unknown',
        'maas.read_unavailable',
        'sse.disconnect_once',
        'worker.interrupt_once',
      ],
    });
    for (const name of [
      'travel.submit',
      'travel.resubmit',
      'travel.withdraw',
      'expense.submit',
      'expense.resubmit',
      'expense.withdraw',
      'oa.submit',
      'oa.resubmit',
      'oa.withdraw',
      'approval.approve',
      'approval.return',
    ] as const)
      application.actions.registerHandler(
        name,
        faults.wrapCommittedResponseLoss(application.approvals.handler(name)),
      );
    application.actions.registerHandler(
      'approval.batch_approve',
      faults.wrapCommittedResponseLoss(application.approvals.batchHandler()),
    );
    application.actions.registerHandler(
      'oa.message.send',
      faults.wrapCommittedResponseLoss(application.messages.handler()),
    );
  }
  const demoEnvironmentId =
    options.demoEnvironmentId ?? options.config.demoEnvironmentId;
  const scenarios = createDemoScenarioController(options.database, {
    appMode: options.config.appMode,
    environmentId: demoEnvironmentId,
    freshActor: (actor) => application.identity.requireCurrentActor(actor),
    run: (scenarioId, hooks) =>
      createDemoJourneyRunner({
        baseUrl: `http://127.0.0.1:${options.config.apiPort}`,
        origin: options.config.appOrigin,
        loadInvoiceFixture: (name) =>
          readFile(resolve(WORKSPACE_ROOT, 'docs/demo-invoices', name)),
        ...hooks,
      }).run({ scenarioId }),
  });
  return { ...application, demo, faults, scenarios, demoEnvironmentId };
}
export type ConfiguredApplication = ReturnType<
  typeof createConfiguredApplication
>;
