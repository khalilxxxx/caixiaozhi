import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const out = 'artifacts/semantic-rules-20261117';
const snapshot = await fetch('http://127.0.0.1:5191/api/local/workspace').then(r => r.json());
snapshot.state.data.srsRuleCenterV1.editingId = null;
delete snapshot.state.data.srsRuleCenterV1.drafts.new;
const originalCount = snapshot.state.data.srsRuleCenterV1.rules.length;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
// 生成调用真实服务与模型；保存仅在隔离副本验收，不添加用户规则。
await context.route('**/api/local/workspace', async route => {
  if (route.request().method() === 'PATCH') {
    Object.assign(snapshot.state.data, route.request().postDataJSON().data ?? {});
    snapshot.revision++;
  }
  await route.fulfill({ json: snapshot });
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
try {
  await page.goto('http://127.0.0.1:5190/agent.html#rules');
  await page.getByRole('button', { name: '新增规则', exact: true }).click();
  await page.getByLabel('规则内容', { exact: true }).fill('业务招待事由中包含高档消费时，例如高档酒、高档消费娱乐场所等等，需要提示风险');
  const completed = page.waitForResponse(r => r.url().endsWith('/api/local/generate/rule'), { timeout: 180000 });
  await page.getByRole('button', { name: '生成规则', exact: true }).click();
  const response = await completed;
  assert.equal(response.status(), 200);
  const { rule } = await response.json();
  assert.equal(rule.metric, 'semantic');
  assert.deepEqual([...rule.requiredFields].sort(), ['purpose']);
  assert.deepEqual([...rule.documentTypes].sort(), ['expense', 'personal']);
  await expect(page.getByRole('region', { name: '规则解析' })).toContainText(rule.name);
  await page.screenshot({ path: `${out}/generated-rule.png`, fullPage: true });
  await page.getByRole('button', { name: '保存并启用', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认启用', exact: true }).click();
  await expect.poll(() => snapshot.state.data.srsRuleCenterV1.rules.length).toBe(originalCount + 1);
  const published = snapshot.state.data.srsRuleCenterV1.rules.find(r => r.id === rule.id);
  const projected = snapshot.state.data.rulesSubmission.rules.find(r => r.id === rule.id);
  for (const stored of [published, projected]) {
    assert.equal(stored.metric, 'semantic');
    assert.equal(stored.instruction, rule.instruction);
    assert.deepEqual(stored.requiredFields, rule.requiredFields);
    assert.deepEqual(stored.documentTypes, rule.documentTypes);
    assert.equal(stored.enabled, true);
    assert.equal(stored.effect, 'warn');
  }
  await page.reload();
  await expect(page.locator('.rc-rule-name').filter({ hasText: rule.name })).toBeVisible();
  assert.deepEqual(errors, []);
  const result = { passed: true, generated: rule, published, projected, errors, workspaceWrites: '仅隔离路由内存', generation: '真实服务与模型' };
  await fs.writeFile(`${out}/generation-save.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: true, ruleName: rule.name, metric: rule.metric, requiredFields: rule.requiredFields, documentTypes: rule.documentTypes, errors }, null, 2));
} finally {
  await browser.close();
}
