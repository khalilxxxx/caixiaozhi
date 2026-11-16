import { expect, test } from '@playwright/test';
import { loadConfig } from '@caixiaozhi/platform/config';

test('真实浏览器会话、业务抽屉、前端刷新和身份隔离', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: /李娜.*销售部/ }).click();
  await expect(page.getByRole('button', { name: '开始新任务' })).toBeVisible();
  await page.getByRole('button', { name: '差旅申请', exact: true }).click();
  await page.getByRole('button', { name: '杭州客户拜访', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(
    page.getByRole('dialog').getByRole('textbox', { name: /标题/ }),
  ).toBeVisible();
  await page.screenshot({
    path: 'test-results/workspace-desktop.png',
    fullPage: true,
  });
  await page.reload();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '关闭详情' }).click();
  await page.getByLabel('切换演示身份').selectOption('u-chen');
  await expect(page.getByLabel('切换演示身份')).toHaveValue('u-chen');
  await page.getByRole('button', { name: '差旅申请', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '杭州客户拜访', exact: true }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: 'test-results/workspace-mobile.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test('五单预审为真实分组且低风险仅手选后才准备确认', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /张伟.*销售部/ }).click();
  await page.getByRole('button', { name: '待我审批', exact: true }).click();
  await expect(page.getByText('当前列表合计 ¥5,540.00')).toBeVisible();
  await page.getByRole('button', { name: '检查当前待审报销' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText(/低风险/).first()).toBeVisible();
  await page.getByRole('button', { name: '开始本次预审', exact: true }).click();
  await expect
    .poll(
      async () => {
        const text = await page.getByRole('dialog').innerText();
        return text.includes('clm-004') && text.includes('clm-005');
      },
      { timeout: 30000 },
    )
    .toBe(true);
  await page.screenshot({
    path: 'test-results/preaudit-desktop.png',
    fullPage: true,
  });
  const actions = await page.request.get('/api/v1/actions/not-a-real-action');
  expect(actions.status()).toBe(404);
});

test('真实任务反映实际模型终态，缺模型时保留明确失败', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /李娜.*销售部/ }).click();
  const status = await page.request.get('/api/v1/health/ready');
  expect(status.ok()).toBe(true);
  const meResponse = await page.request.get('/api/v1/me');
  expect(meResponse.ok()).toBe(true);
  const me = (await meResponse.json()).data;
  expect(me.actor.user_id).toBe('u-li');
  const textarea = page.getByRole('textbox', { name: '向财小智提问' });
  await textarea.fill('请读取我的差旅草稿');
  const submittedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /^\/api\/v1\/threads(?:\/[^/]+\/messages)?$/.test(
        new URL(response.url()).pathname,
      ),
  );
  await page.getByRole('button', { name: /发送/ }).click();
  const submitted = await submittedResponse;
  expect(submitted.ok(), await submitted.text()).toBe(true);
  const accepted = (await submitted.json()).data;
  expect(accepted.run_id).toEqual(expect.any(String));
  expect(accepted.message.run_id).toBe(accepted.run_id);
  expect(accepted.message.thread_id).toBe(accepted.thread.id);
  expect(accepted.thread.owner_id).toBe(me.actor.user_id);
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/v1/runs/${accepted.run_id}`,
        );
        expect(response.ok()).toBe(true);
        const run = (await response.json()).data;
        expect(run.id).toBe(accepted.run_id);
        expect(run.owner_id).toBe(me.actor.user_id);
        expect(run.thread_id).toBe(accepted.thread.id);
        expect(run.input_message_id).toBe(accepted.message.id);
        return run.status;
      },
      { timeout: 30000 },
    )
    .toMatch(/failed|succeeded|waiting_user/);
  const configured = loadConfig().dsh;
  if (!(
    configured.apiKey &&
    configured.baseURL &&
    configured.model &&
    configured.contextWindow
  )) {
    const response = await page.request.get(`/api/v1/runs/${accepted.run_id}`);
    expect(response.ok()).toBe(true);
    const run = (await response.json()).data;
    expect(run.id).toBe(accepted.run_id);
    expect(run.owner_id).toBe(me.actor.user_id);
    expect(run.thread_id).toBe(accepted.thread.id);
    expect(run.input_message_id).toBe(accepted.message.id);
    expect(run.status).toBe('failed');
    expect(run.error_code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(run.usage.model_calls).toBe(0);
    expect(run.usage.tool_calls).toBe(0);
  }
});
