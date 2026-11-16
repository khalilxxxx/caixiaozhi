import { expect, test } from '@playwright/test';

test('个人规则真实排队验证后通过统一确认启用', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /张伟.*销售部/ }).click();
  await page.getByRole('button', { name: '制度与规则', exact: true }).click();
  await page.getByRole('tab', { name: '审核规则' }).click();
  await page.getByRole('button', { name: '创建个人提醒' }).click();
  const dialog = page.getByRole('dialog');
  const name = `分边界提醒-${Date.now()}`;
  await dialog.getByLabel('规则名称').fill(name);
  await dialog.getByLabel('每张单据餐饮合计严格超过（元）').fill('1000.00');
  await dialog.getByLabel('使用场景').selectOption('manager_review');
  await dialog.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: '验证金额边界' }),
  ).toBeEnabled();
  await expect(dialog.getByRole('button', { name: '核对并启用' })).toHaveCount(
    0,
  );
  const acceptedResponse = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      /\/api\/v1\/rules\/[^/]+\/tests$/.test(new URL(r.url()).pathname),
  );
  await dialog.getByRole('button', { name: '验证金额边界' }).click();
  const accepted = await acceptedResponse;
  expect(accepted.status()).toBe(202);
  const { data: task } = await accepted.json();
  expect(task).toMatchObject({ status: 'queued', test_run_id: task.task_id });
  await expect(
    dialog.getByRole('heading', { name: '边界样例通过' }),
  ).toBeVisible({ timeout: 30000 });
  await expect(dialog.getByRole('status')).toContainText('4/4');
  const proofResponse = await page.request.get(
    `/api/v1/rules/${task.rule_id}/tests/${task.task_id}`,
  );
  expect(proofResponse.ok()).toBe(true);
  const { data: completed } = await proofResponse.json();
  expect(completed.status).toBe('completed');
  expect(
    completed.cases.map((c: { amount_minor: string | null }) => c.amount_minor),
  ).toEqual(['99999', '100000', '100001', null]);
  expect(
    completed.proof.results.map((r: { truth: string }) => r.truth),
  ).toEqual(['false', 'false', 'true', 'unknown']);
  await dialog.getByRole('button', { name: '核对并启用' }).click();
  await expect(
    page.getByRole('heading', { name: '确认本次操作' }),
  ).toBeVisible();
  const confirmation = page.getByRole('dialog');
  await expect(confirmation).toContainText(name);
  const confirmResponse = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      /\/confirmations\/[^/]+\/confirm$/.test(new URL(r.url()).pathname),
  );
  await confirmation
    .getByRole('button', { name: '确认并执行', exact: true })
    .click();
  const result = await confirmResponse;
  expect(result.ok()).toBe(true);
  const { data: action } = await result.json();
  expect(action.state).toBe('succeeded');
  expect(action.items).toHaveLength(1);
  expect(action.items[0].receipt.outcome).toBe('succeeded');
  await expect(page.getByRole('heading', { name: '操作回执' })).toBeVisible();
  const saved = await page.request.get(`/api/v1/rules/${task.rule_id}`);
  expect((await saved.json()).data.lifecycle).toBe('active');
});

test('完成金额同快照下钻、生成私有报告并真实下载CSV', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /张伟.*销售部/ }).click();
  await page.getByRole('button', { name: '费用分析', exact: true }).click();
  await expect(page.getByLabel('分析内容')).toHaveValue(
    'expense.completed_amount',
  );
  await page.getByLabel('统计范围').selectOption('department');
  await page.getByLabel('开始日期').fill('2026-11-01');
  await page.getByLabel('结束日期（不含）').fill('2026-11-06');
  await page.getByLabel('对比 10 月完整月份').check();
  const queryResponse = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === '/api/v1/analytics/queries',
  );
  await page.getByRole('button', { name: '生成分析', exact: true }).click();
  const accepted = await queryResponse;
  expect(accepted.status()).toBe(202);
  const { data: query } = await accepted.json();
  await expect(page.locator('.finance-total')).toContainText('¥5,900.00', {
    timeout: 30000,
  });
  await expect(page.locator('.finance-total')).toContainText('¥1,800.00');
  await expect(page.locator('.finance-total')).toContainText('¥4,100.00');
  await expect(page.locator('.finance-total')).toContainText('227.78%');
  const request = await page.request.get(
    `/api/v1/analytics/queries/${query.request_id}`,
  );
  const { data: finished } = await request.json();
  const response = await page.request.get(
    `/api/v1/analytics/snapshots/${finished.snapshot_id}`,
  );
  const { data: snapshot } = await response.json();
  expect(snapshot.total.amount_minor).toBe('590000');
  expect(snapshot.comparison).toMatchObject({
    base: { amount_minor: '180000' },
    delta: { amount_minor: '410000' },
    rate_percent: '227.78',
  });
  await page.getByRole('button', { name: '查看明细', exact: true }).click();
  const detail = page.getByRole('dialog');
  await expect(
    detail.getByRole('cell', { name: '¥3,500.00', exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByRole('cell', { name: '¥2,400.00', exact: true }),
  ).toBeVisible();
  await expect(detail.locator('tbody tr')).toHaveCount(2);
  await detail.getByRole('button', { name: '关闭详情' }).click();
  const reportResponse = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === '/api/v1/analytics/reports',
  );
  await page.getByRole('button', { name: '生成私有报告' }).click();
  const created = await reportResponse;
  expect(created.status()).toBe(202);
  const { data: report } = await created.json();
  const reportDialog = page.getByRole('dialog');
  await expect(
    reportDialog.getByRole('heading', { name: '费用报告草稿' }),
  ).toBeVisible();
  await expect(reportDialog).toContainText('报告仅本人可见');
  await expect(reportDialog.locator('.finance-locked-fact')).toContainText(
    '¥5,900.00',
  );
  await expect(
    reportDialog.getByRole('button', { name: '导出 CSV 明细' }),
  ).toBeEnabled({ timeout: 30000 });
  const savedReport = await page.request.get(
    `/api/v1/analytics/reports/${report.report_id}`,
  );
  expect((await savedReport.json()).data.snapshot.id).toBe(snapshot.id);
  await reportDialog.getByRole('button', { name: '导出 CSV 明细' }).click();
  const downloadLink = reportDialog.getByRole('link', { name: /下载 CSV/ });
  await expect(downloadLink).toBeVisible({ timeout: 30000 });
  const href = await downloadLink.getAttribute('href');
  expect(href).toMatch(/^\/api\/v1\/analytics\/artifacts\/[^/]+\/download$/);
  const downloaded = await page.request.get(href!);
  expect(downloaded.ok()).toBe(true);
  expect(downloaded.headers()['content-disposition']).toContain('attachment');
  const csv = (await downloaded.body()).toString('utf8');
  expect(csv).toContain('350000');
  expect(csv).toContain('240000');
  const browserDownload = page.waitForEvent('download');
  await downloadLink.click();
  const file = await browserDownload;
  expect(file.suggestedFilename()).toMatch(/\.csv$/);
  expect(await file.failure()).toBeNull();
});
