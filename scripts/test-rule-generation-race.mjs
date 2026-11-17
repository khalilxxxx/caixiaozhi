import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// 所有工作区变更都留在浏览器路由内存中，不修改用户数据。
const snapshot = await fetch('http://127.0.0.1:5191/api/local/workspace').then(r => r.json());
snapshot.state.data.srsRuleCenterV1.editingId = null;
delete snapshot.state.data.srsRuleCenterV1.drafts.new;
const template = snapshot.state.data.srsRuleCenterV1.rules.find(r => r.id === 'SEM-EXPENSE-001');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pending = [];
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
await page.route('**/api/local/workspace', async route => {
  if (route.request().method() === 'PATCH') {
    const patch = route.request().postDataJSON();
    Object.assign(snapshot.state.data, patch.data ?? {});
    snapshot.revision++;
  }
  await route.fulfill({ json: snapshot });
});
await page.route('**/api/local/generate/rule', route => {
  pending.push(route);
});
const answer = async (index, name) => {
  const route = pending[index];
  const { text } = route.request().postDataJSON();
  await route.fulfill({ json: { rule: { ...template, id: `personal-race-${index}`, name, logic: text, instruction: text } } });
};
try {
  await page.goto('http://127.0.0.1:5190/agent.html#rules');
  await page.getByRole('button', { name: '新增规则', exact: true }).click();
  await page.getByLabel('规则内容', { exact: true }).fill('旧需求：业务招待包含高档酒时提醒。');
  await page.getByRole('button', { name: '生成规则', exact: true }).click();
  await expect.poll(() => pending.length).toBe(1);
  await page.getByRole('button', { name: '放弃草稿', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '放弃草稿', exact: true }).click();
  await page.getByRole('button', { name: '新增规则', exact: true }).click();
  await page.getByLabel('规则内容', { exact: true }).fill('新需求：报销用途与事由不一致时提醒。');
  await page.getByRole('button', { name: '生成规则', exact: true }).click();
  await expect.poll(() => pending.length).toBe(2);
  await answer(1, '新需求规则');
  await expect(page.getByRole('region', { name: '规则解析' })).toContainText('新需求规则');
  await answer(0, '迟到旧规则');
  await page.waitForTimeout(600);
  await expect(page.getByRole('region', { name: '规则解析' })).toContainText('新需求规则');
  assert.equal(snapshot.state.data.srsRuleCenterV1.drafts.new.generated.name, '新需求规则');

  // 同一编辑器修改内容后，旧请求也必须失效。
  await page.getByRole('button', { name: '重新生成', exact: true }).click();
  await expect.poll(() => pending.length).toBe(3);
  await page.getByLabel('规则内容', { exact: true }).fill('第三版需求：只检查差旅事由。');
  await answer(2, '过期内容规则');
  await page.waitForTimeout(600);
  await expect(page.getByRole('region', { name: '规则解析' })).not.toContainText('过期内容规则');

  // 放弃草稿后，即使响应成功也不能重新创建草稿。
  await page.getByRole('button', { name: '重新生成', exact: true }).click();
  await expect.poll(() => pending.length).toBe(4);
  await page.getByRole('button', { name: '放弃草稿', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '放弃草稿', exact: true }).click();
  await answer(3, '已放弃规则');
  await page.waitForTimeout(600);
  assert.equal(snapshot.state.data.srsRuleCenterV1.drafts.new, undefined);
  assert.deepEqual(errors, []);
  const result = { passed: true, cases: ['旧请求不覆盖新结果', '修改内容使旧请求失效', '放弃后不重建草稿'], errors, workspaceWrites: '仅隔离路由内存' };
  await fs.writeFile('artifacts/semantic-rules-20261117/generation-race.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
