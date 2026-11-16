import { readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import {
  createDemoJourneyRunner,
  DEMO_JOURNEY_IDS,
  type DemoJourneyEvidence,
} from '../../packages/demo/src/journeys.js';

// 每条独立通过受控reset重建generation。缺少真实模型或真实业务失败均使该测试失败，禁止跳过或固定回复。
test.describe('02 E2E01至08正式API旅程', () => {
  for (const scenarioId of DEMO_JOURNEY_IDS) {
    test(`${scenarioId} 独立新generation、正式身份与真实回执`, async ({
      baseURL,
    }, testInfo) => {
      test.setTimeout(15 * 60_000);
      const entries: DemoJourneyEvidence[] = [];
      const runner = createDemoJourneyRunner({
        baseUrl:
          process.env.DEMO_JOURNEY_API_URL ??
          baseURL ??
          'http://127.0.0.1:5173',
        origin:
          process.env.DEMO_JOURNEY_ORIGIN ?? baseURL ?? 'http://127.0.0.1:5173',
        timeoutMs: 180_000,
        loadInvoiceFixture: (name) =>
          readFile(
            new URL(`../../docs/demo-invoices/${name}`, import.meta.url),
          ),
        onEvidence: async (entry) => {
          entries.push(entry);
        },
        saveReport: async (report) => {
          const path = testInfo.outputPath(`${scenarioId}-report.json`);
          await writeFile(path, JSON.stringify(report, null, 2));
          await testInfo.attach('正式API旅程证据', {
            path,
            contentType: 'application/json',
          });
        },
      });
      const report = await runner.run({ scenarioId });
      expect(report.status, JSON.stringify(report.error)).toBe('succeeded');
      expect(report.baseline).not.toBeNull();
      expect(report.baseline!.generation).toBeGreaterThan(
        report.baseline!.previous_generation,
      );
      expect(
        report.evidence.some(
          (entry) => entry.request?.path === '/api/v1/auth/demo/login',
        ),
      ).toBe(true);
      expect(
        report.evidence.some(
          (entry) => entry.request?.path === '/api/v1/demo/reset',
        ),
      ).toBe(true);
      expect(
        entries.some((entry) =>
          entry.resource_refs.some((ref) => ref.version > 0),
        ),
      ).toBe(true);
      expect(JSON.stringify(report)).not.toMatch(
        /confirmation_token|csrf_token|caixiaozhi_session=/,
      );
    });
  }
});
