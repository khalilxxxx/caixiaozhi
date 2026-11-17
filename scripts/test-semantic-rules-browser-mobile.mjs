import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const outputDirectory = 'artifacts/semantic-rules-20261117';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.addInitScript(() => sessionStorage.removeItem('cx.agent.local.panel'));
const page = await context.newPage();
const errors = [];
const writes = [];
const layouts = [];
const consoleMessages = [];
const baseline = await (await context.request.get('http://127.0.0.1:5190/api/local/workspace')).json();
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => {
  consoleMessages.push({ type: message.type(), text: message.text() });
  if (message.type() === 'error') errors.push(message.text());
});
await page.route('**/api/local/**', async route => {
  const request = route.request();
  if (!['GET', 'HEAD'].includes(request.method())) {
    writes.push({ method: request.method(), url: request.url() });
    await route.abort();
    return;
  }
  if (new URL(request.url()).pathname === '/api/local/workspace') {
    const response = await route.fetch();
    const payload = await response.json();
    payload.state.data.srsRuleCenterV1.editingId = null;
    await route.fulfill({ response, json: payload });
    return;
  }
  await route.continue();
});

async function snapshot(name) {
  await page.waitForTimeout(600);
  const layout = await page.evaluate(() => {
    const bounds = element => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
    };
    return {
      document: bounds(document.documentElement),
      tableScrollContainer: bounds(document.querySelector('.rc-table-wrap')),
      dialog: bounds(document.querySelector('dialog[open]')),
      panel: bounds(document.querySelector('dialog[open] .rc-panel')),
      selector: bounds(document.querySelector('.rc-sample-test select')),
      close: bounds(document.querySelector('dialog[open] [aria-label="关闭详情"]')),
      openDialogs: [...document.querySelectorAll('dialog[open]')].map(element => element.innerText.slice(0, 60)),
      helpButtonVisible: [...document.querySelectorAll('button')].some(element => element.innerText.trim() === '使用指引' && element.getClientRects().length),
      helpContentVisible: [...document.querySelectorAll('dialog[open]')].some(element => element.innerText.startsWith('使用指引')),
    };
  });
  layouts.push({ name, ...layout });
  assert.equal(layout.document.scrollWidth, 390, `${name} document horizontal overflow`);
  assert.equal(layout.helpContentVisible, false, `${name} help must stay hidden`);
  if (layout.dialog) {
    assert.ok(layout.close.x >= 0 && layout.close.right <= 390 && layout.close.y >= 0 && layout.close.y < 844);
    assert.ok(layout.panel.scrollWidth <= layout.panel.clientWidth);
  }
  if (layout.selector) assert.ok(layout.selector.x >= 0 && layout.selector.right <= 390);
  await page.screenshot({ path: `${outputDirectory}/browser-mobile-${name}.png`, fullPage: false });
}

try {
  await page.goto('http://127.0.0.1:5190/agent.html?semantic_mobile_review=390#rules');
  await page.locator('.rc-table tbody tr').last().waitFor();
  assert.equal(await page.locator('.rc-table tbody tr').count(), 12);
  assert.equal(await page.locator('.rc-migration-history').evaluate(element => element.open), false);
  await snapshot('list');
  await page.getByRole('button', { name: '业务招待高档消费风险', exact: true }).click();
  await page.locator('.rc-sample-test').waitFor();
  assert.equal(await page.locator('.rc-sample-test').evaluate(element => element.open), false);
  await snapshot('detail');
  await page.locator('.rc-sample-test summary').click();
  await page.locator('.rc-sample-test select option').first().waitFor({ state: 'attached' });
  await page.locator('.rc-sample-test select').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('.rc-sample-test select option').count(), 3);
  await snapshot('samples');
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  assert.equal(await page.locator('dialog[open]').count(), 0);
  const finalSnapshot = await (await context.request.get('http://127.0.0.1:5190/api/local/workspace')).json();
  assert.deepEqual(finalSnapshot.state, baseline.state);
  assert.equal(writes.length, 0);
  assert.equal(errors.length, 0);
  await fs.writeFile(`${outputDirectory}/browser-mobile.json`, JSON.stringify({ success: true, viewport: { width: 390, height: 844 }, workspaceUnchanged: true, baselineRevision: baseline.revision, finalRevision: finalSnapshot.revision, isolatedEditingId: baseline.state.data.srsRuleCenterV1.editingId, closeConfirmed: true, errors, writes, consoleMessages, layouts }, null, 2));
  console.log(JSON.stringify({ success: true, errors, writes, closeConfirmed: true }));
} catch (error) {
  errors.push(String(error));
  await page.screenshot({ path: `${outputDirectory}/browser-mobile-failure.png`, fullPage: false }).catch(() => {});
  await fs.writeFile(`${outputDirectory}/browser-mobile.json`, JSON.stringify({ success: false, errors, writes, consoleMessages, layouts, body: await page.locator('body').innerText() }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
