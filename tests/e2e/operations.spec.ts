import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

async function authenticatedSession(
  page: Page,
  userId: string,
  action: () => Promise<unknown>,
) {
  const [login] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/api\/v1\/auth\/demo\/(login|switch)$/.test(
          new URL(response.url()).pathname,
        ),
    ),
    action(),
  ]);
  expect(login.ok(), await login.text()).toBe(true);
  const identity = page.getByLabel('切换演示身份');
  await expect(identity).toHaveValue(userId);
  await expect(identity).toBeEnabled();
  // busy结束代表产品自身的refreshIdentity已完成；随后直接请求失败仍使测试失败。
  const response = await page.request.get('/api/v1/me');
  expect(response.status(), await response.text()).toBe(200);
  const me = (await response.json()).data;
  expect(me.actor.user_id).toBe(userId);
  expect(me.csrf_token).toEqual(expect.any(String));
  return me;
}

test('运维只显示元数据，场景先审阅，故障正式启用后可停止且不重建环境', async ({
  page,
}) => {
  const marker = `仅本人会话可见-${randomUUID()}`;
  await page.goto('/');
  const me = await authenticatedSession(page, 'u-li', () =>
    page.getByRole('button', { name: /李娜.*销售部/ }).click(),
  );
  const created = await page.request.post('/api/v1/threads', {
    headers: {
      origin: new URL(page.url()).origin,
      'x-csrf-token': me.csrf_token,
      'idempotency-key': randomUUID(),
    },
    data: {
      title: '运维隐私隔离回归',
      initial_message: {
        client_message_id: randomUUID(),
        content: `${marker}。这是隐私隔离检查，请勿执行任何业务操作。`,
      },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const runId = (await created.json()).data.run_id;
  expect(runId).toBeTruthy();
  await authenticatedSession(page, 'u-zhao', () =>
    page.getByLabel('切换演示身份').selectOption('u-zhao'),
  );
  await page.getByRole('button', { name: '运行与演示', exact: true }).click();
  for (const name of ['环境状态', '场景选择', '业务时钟与摘要', '故障与恢复'])
    await expect(
      page.getByRole('heading', { name, exact: true }),
    ).toBeVisible();
  const before = (
    await (await page.request.get('/api/v1/demo/environments/current')).json()
  ).data;
  let destructiveRequests = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/demo\/(reset|scenarios\/[^/]+\/start)$/.test(
        new URL(request.url()).pathname,
      )
    )
      destructiveRequests++;
  });
  await page
    .locator('.operations-scenarios article')
    .first()
    .getByRole('button', { name: '审阅并运行' })
    .click();
  const review = page.getByRole('dialog', {
    name: '确认运行隔离旅程',
    exact: true,
  });
  await expect(
    review.getByText(/旧会话、待确认操作和后台任务会失效/),
  ).toBeVisible();
  await review.getByRole('button', { name: '暂不运行' }).click();
  expect(destructiveRequests).toBe(0);
  await page.getByRole('tab', { name: '任务运维', exact: true }).click();
  await page.getByLabel('用户标识', { exact: true }).fill('u-li');
  await page.getByRole('button', { name: '查询运行记录' }).click();
  await expect(
    page.getByRole('button', { name: `查看运行 ${runId}`, exact: true }),
  ).toBeVisible();
  await expect(page.locator('.operations-page')).not.toContainText(marker);
  const metadata = await page.request.get(
    '/api/v1/operations/runs?user_id=u-li',
  );
  expect(metadata.ok()).toBe(true);
  const raw = await metadata.text();
  expect(raw).not.toContain(marker);
  expect(raw).not.toContain('actor_context');
  expect(raw).not.toContain('input_message_id');
  const [timelineResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes(`/operations/runs/${runId}/timeline`),
    ),
    page
      .getByRole('button', { name: `查看运行 ${runId}`, exact: true })
      .click(),
  ]);
  expect(timelineResponse.ok()).toBe(true);
  const timelineRaw = await timelineResponse.text();
  expect(timelineRaw).not.toContain(marker);
  const timelineData = (await timelineResponse.json()).data;
  for (const event of timelineData.events)
    expect(Object.keys(event).sort()).toEqual(['occurred_at', 'seq', 'type']);
  const timeline = page.getByRole('dialog', {
    name: '运行时间线',
    exact: true,
  });
  await expect(timeline).toBeVisible();
  await expect(timeline).not.toContainText(marker);
  await timeline.getByRole('button', { name: '关闭详情' }).click();
  await page.getByRole('tab', { name: '演示控制', exact: true }).click();
  await page.getByRole('button', { name: '配置演示故障' }).click();
  const fault = page.getByRole('dialog', { name: '配置演示故障', exact: true });
  await fault
    .getByLabel('故障类型', { exact: true })
    .selectOption('ocr.timeout');
  await fault
    .getByLabel('演示对象范围', { exact: true })
    .selectOption('clm-003');
  await fault.getByLabel('生效次数', { exact: true }).fill('1');
  await fault.getByLabel('有效期（分钟）', { exact: true }).fill('1');
  const [armedResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/demo/faults') &&
        response.request().method() === 'POST',
    ),
    fault.getByRole('button', { name: '启用此故障' }).click(),
  ]);
  expect(armedResponse.status()).toBe(201);
  const armed = (await armedResponse.json()).data;
  expect(armed).toMatchObject({
    kind: 'ocr.timeout',
    scope_alias: 'clm-003',
    remaining_hits: 1,
    state: 'armed',
  });
  const row = page.locator(`[data-fault-id="${armed.id}"]`);
  await expect(row).toContainText('已启用');
  await row.getByRole('button', { name: '停止后续注入' }).click();
  await expect(row).toContainText('已停用');
  await expect(
    page.getByText('已停止后续注入，原有失败或待核实结果保持原状态。'),
  ).toBeVisible();
  const stored = (
    await (await page.request.get('/api/v1/demo/faults')).json()
  ).data.items.find((item: { id: string }) => item.id === armed.id);
  expect(stored.state).toBe('disabled');
  const after = (
    await (await page.request.get('/api/v1/demo/environments/current')).json()
  ).data;
  expect(after.generation).toBe(before.generation);
  expect(destructiveRequests).toBe(0);
});
