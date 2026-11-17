import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const outputDirectory = 'artifacts/semantic-rules-20261117';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript(() => sessionStorage.removeItem('cx.agent.local.panel'));
const page = await context.newPage();
const errors = [];
const writes = [];
const baseline = await (await context.request.get('http://127.0.0.1:5190/api/local/workspace')).json();
let payload;
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
await page.route('**/api/local/**', async route => {
  const request = route.request();
  if (!['GET', 'HEAD'].includes(request.method())) {
    writes.push({ method: request.method(), url: request.url(), body: request.postDataJSON() });
    if (!request.url().endsWith('/rules/test')) {
      await route.abort();
      return;
    }
  }
  if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/local/workspace') {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.state.data.srsRuleCenterV1.editingId = null;
    await route.fulfill({ response, json: snapshot });
    return;
  }
  await route.continue();
});
try {
  await page.goto('http://127.0.0.1:5190/agent.html?semantic_hit_final=1#rules');
  await page.locator('.rc-table tbody tr').last().waitFor();
  await page.getByRole('button', { name: '业务招待高档消费风险', exact: true }).click();
  await page.locator('.rc-sample-test summary').click();
  const selector = page.locator('.rc-sample-test select');
  await selector.locator('option').first().waitFor({ state: 'attached' });
  await selector.selectOption('SEM-EXPENSE-001-hit');
  const resultResponse = page.waitForResponse(response => response.url().endsWith('/api/local/rules/test') && response.request().method() === 'POST', { timeout: 180000 });
  await page.getByRole('button', { name: '运行测试', exact: true }).click();
  const response = await resultResponse;
  assert.equal(response.status(), 200);
  payload = await response.json();
  const evaluation = payload.review.evaluations.find(item => item.ruleId === 'SEM-EXPENSE-001');
  assert.equal(evaluation.state, 'MATCHED');
  assert.match(evaluation.reason, /计划|拟安排/);
  assert.doesNotMatch(evaluation.reason, /已消费|实际购买|已发生|已购买并消费/);
  assert.ok(evaluation.evidence.length);
  for (const evidence of evaluation.evidence) {
    assert.equal(evidence.path, '$.purpose');
    assert.ok(payload.case.document.purpose.includes(evidence.quote));
  }
  assert.ok(payload.model);
  await page.locator('.rc-sample-result').waitFor();
  const displayedText = await page.locator('.rc-sample-result').innerText();
  assert.ok(displayedText.includes(evaluation.reason));
  assert.ok(displayedText.includes(payload.model));
  await page.locator('.rc-sample-result').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${outputDirectory}/browser-hit-final-1280x800.png`, fullPage: false });
  await page.locator('.rc-sample-result').screenshot({ path: `${outputDirectory}/browser-hit-final-result.png` });
  const finalSnapshot = await (await context.request.get('http://127.0.0.1:5190/api/local/workspace')).json();
  assert.deepEqual(finalSnapshot.state, baseline.state);
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0].body).sort(), ['caseId', 'rule']);
  assert.equal(errors.length, 0);
  await fs.writeFile(`${outputDirectory}/browser-hit-final.json`, JSON.stringify({ success: true, viewport: { width: 1280, height: 800 }, workspaceUnchanged: true, baselineRevision: baseline.revision, finalRevision: finalSnapshot.revision, isolatedEditingId: baseline.state.data.srsRuleCenterV1.editingId, errors, writes, payload, displayedText }, null, 2));
  console.log(JSON.stringify({ success: true, evaluation, model: payload.model, workspaceUnchanged: true, errors }));
} catch (error) {
  errors.push(String(error));
  await page.screenshot({ path: `${outputDirectory}/browser-hit-final-failure.png`, fullPage: false }).catch(() => {});
  await fs.writeFile(`${outputDirectory}/browser-hit-final.json`, JSON.stringify({ success: false, errors, writes, payload, body: await page.locator('body').innerText() }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
