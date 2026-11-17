import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const outputDirectory = 'artifacts/semantic-rules-20261117';
await fs.mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => sessionStorage.removeItem('cx.agent.local.panel'));
const page = await context.newPage();
const errors = [];
const consoleMessages = [];
const writeRequests = [];
const layouts = [];
const samples = [];
const priorHit = process.env.SEMANTIC_REVIEW_SKIP_HIT === '1' ? JSON.parse(await fs.readFile(`${outputDirectory}/browser-review-hit-observed.json`, 'utf8')) : null;
const isolatedNavigation = { originalEditingId: null };
const baseline = await (await context.request.get('http://127.0.0.1:5190/api/local/workspace')).json();
isolatedNavigation.originalEditingId = baseline.state.data.srsRuleCenterV1?.editingId;
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => {
  consoleMessages.push({ type: message.type(), text: message.text() });
  if (message.type() === 'error') errors.push(message.text());
});
await page.route('**/api/local/**', async route => {
  const request = route.request();
  if (!['GET', 'HEAD'].includes(request.method())) {
    writeRequests.push({ method: request.method(), url: request.url(), body: request.postDataJSON() });
    if (!request.url().endsWith('/rules/test')) {
      errors.push(`Blocked unexpected write ${request.method()} ${request.url()}`);
      await route.abort();
      return;
    }
  }
  if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/local/workspace') {
    const response = await route.fetch();
    const payload = await response.json();
    if (payload.state.data.srsRuleCenterV1) payload.state.data.srsRuleCenterV1.editingId = null;
    await route.fulfill({ response, json: payload });
    return;
  }
  await route.continue();
});

async function recordLayout(name, viewport) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);
  const layout = await page.evaluate(() => {
    const ruleTable = document.querySelector('.rc-table');
    const tableBounds = ruleTable?.getBoundingClientRect();
    const panel = document.querySelector('dialog[open]');
    const panelBounds = panel?.getBoundingClientRect();
    return {
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      table: tableBounds ? { x: tableBounds.x, width: tableBounds.width, right: tableBounds.right } : null,
      panel: panelBounds ? { x: panelBounds.x, width: panelBounds.width, right: panelBounds.right, clientWidth: panel.clientWidth, scrollWidth: panel.scrollWidth } : null,
      panelContent: panel ? [...panel.querySelectorAll('.panel-header, .panel-body, .rc-panel, h2')].map(element => { const rect = element.getBoundingClientRect(); return { className: element.className, x: rect.x, width: rect.width, right: rect.right, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }; }) : [],
      horizontallyClippedControls: [...document.querySelectorAll('.rc-page button, .rc-page input, .rc-page select, .rc-panel button, .rc-panel select')]
        .filter(element => element.getClientRects().length)
        .map(element => ({ text: element.textContent.trim().slice(0, 40), rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.left < -1 || rect.right > innerWidth + 1)
        .map(({ text, rect }) => ({ text, x: rect.x, width: rect.width, right: rect.right })),
    };
  });
  layouts.push({ name, viewport, ...layout });
  assert.equal(layout.documentScrollWidth <= viewport.width, true, `${name} document overflow`);
  assert.equal(layout.horizontallyClippedControls.length, 0, `${name} control overflow`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${outputDirectory}/browser-review-${name}.png`, fullPage: false });
}

try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`http://127.0.0.1:5190/agent.html?semantic_review=${viewport.width}#rules`);
    if (await page.getByRole('button', { name: '关闭详情', exact: true }).isVisible().catch(() => false)) {
      await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    }
    await page.locator('.rc-table tbody tr').last().waitFor();
    assert.equal(await page.locator('.rc-table tbody tr').count(), 12);
    const attachmentRow = page.locator('.rc-table tbody tr').filter({ hasText: 'R005' });
    assert.match(await attachmentRow.innerText(), /已停用/);
    assert.equal(await page.locator('.rc-migration-history').evaluate(element => element.open), false);
    await recordLayout(`list-${viewport.width}x${viewport.height}`, viewport);
    await page.getByRole('button', { name: '业务招待高档消费风险', exact: true }).click();
    await page.locator('.rc-sample-test').waitFor();
    assert.equal(await page.locator('.rc-sample-test').evaluate(element => element.open), false);
    assert.equal(await page.locator('.rc-sample-body').count(), 0);
    await recordLayout(`detail-${viewport.width}x${viewport.height}`, viewport);
  }

  await page.locator('.rc-sample-test summary').click();
  const selector = page.locator('.rc-sample-test select');
  await selector.locator('option').first().waitFor({ state: 'attached' });
  assert.equal(await selector.locator('option').count(), 3);
  const expectedStates = { hit: 'MATCHED', clear: 'NOT_MATCHED', unknown: 'INSUFFICIENT_EVIDENCE' };
  for (const scenario of (priorHit ? ['clear', 'unknown'] : ['hit', 'clear', 'unknown'])) {
    await selector.selectOption(`SEM-EXPENSE-001-${scenario}`);
    assert.equal(await page.locator('.rc-sample-result').count(), 0, 'previous result must clear after changing sample');
    const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/local/rules/test') && response.request().method() === 'POST', { timeout: 180000 });
    await page.getByRole('button', { name: '运行测试', exact: true }).click();
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    const payload = await response.json();
    await fs.writeFile(`${outputDirectory}/browser-review-${scenario}-response.json`, JSON.stringify(payload, null, 2));
    await page.locator('.rc-sample-result').waitFor({ timeout: 5000 });
    const evaluation = payload.review.evaluations.find(item => item.ruleId === 'SEM-EXPENSE-001');
    assert.equal(evaluation?.state, expectedStates[scenario]);
    assert.match(evaluation.reason, /[\u3400-\u9fff]/);
    assert.equal(typeof payload.model, 'string');
    assert.ok(payload.model.length);
    if (scenario !== 'unknown') assert.ok(evaluation.evidence.length);
    for (const evidence of evaluation.evidence) {
      const segments = evidence.path.replace(/^\$\./, '').replace(/\[(\d+)\]/g, '.$1').split('.');
      const originalValue = segments.reduce((value, segment) => value[segment], payload.case.document);
      assert.ok(String(originalValue).includes(evidence.quote));
    }
    const displayedText = await page.locator('.rc-sample-result').innerText();
    assert.ok(displayedText.includes(evaluation.reason));
    assert.ok(displayedText.includes(payload.model));
    for (const evidence of evaluation.evidence) assert.ok(displayedText.includes(evidence.quote));
    samples.push({ scenario, payload, displayedText });
    await recordLayout(`sample-${scenario}-1280x800`, { width: 1280, height: 800 });
    console.log(JSON.stringify({ scenario, state: evaluation.state, reason: evaluation.reason, evidence: evaluation.evidence, model: payload.model }));
  }
  const finalSnapshot = await (await context.request.get('http://127.0.0.1:5190/api/local/workspace')).json();
  const workspaceUnchanged = JSON.stringify(finalSnapshot.state) === JSON.stringify(baseline.state);
  assert.deepEqual(finalSnapshot.state.data.srsRuleCenterV1, baseline.state.data.srsRuleCenterV1, 'rules and existing drafts must remain unchanged');
  assert.deepEqual(finalSnapshot.state.data.rulesSubmission, baseline.state.data.rulesSubmission, 'execution rules must remain unchanged');
  assert.equal(writeRequests.length, priorHit ? 2 : 3);
  for (const request of writeRequests) assert.deepEqual(Object.keys(request.body).sort(), ['caseId', 'rule']);
  assert.equal(errors.length, 0);
  await fs.writeFile(`${outputDirectory}/browser-review-results.json`, JSON.stringify({ success: true, isolatedNavigation, baselineRevision: baseline.revision, finalRevision: finalSnapshot.revision, workspaceUnchanged, ruleWorkspaceUnchanged: true, priorHit, errors, consoleMessages, writeRequests, layouts, samples }, null, 2));
  console.log(JSON.stringify({ success: true, errors, screenshots: layouts.length, ruleWorkspaceUnchanged: true }));
} catch (error) {
  errors.push(String(error));
  await page.screenshot({ path: `${outputDirectory}/browser-review-failure.png`, fullPage: true }).catch(() => {});
  await fs.writeFile(`${outputDirectory}/browser-review-results.json`, JSON.stringify({ success: false, isolatedNavigation, errors, consoleMessages, writeRequests, layouts, samples, body: await page.locator('body').innerText().catch(() => '') }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
