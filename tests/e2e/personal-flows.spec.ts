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

test('明确保存的个人偏好刷新后仍在，切换身份不能继承', async ({ page }) => {
  const key = `报告表达-${Date.now()}`;
  await page.goto('/');
  await authenticatedSession(page, 'u-zhang', () =>
    page.getByRole('button', { name: /张伟.*销售部/ }).click(),
  );
  await page.getByRole('button', { name: '记忆与提醒', exact: true }).click();
  await page.getByRole('button', { name: '保存一条偏好' }).click();
  const editor = page.getByRole('dialog', { name: '保存个人偏好' });
  await editor.getByRole('textbox', { name: '偏好名称' }).fill(key);
  await editor
    .getByRole('textbox', { name: '要记住的内容' })
    .fill('报告先给摘要，金额用元。');
  await editor.getByRole('button', { name: '明确保存偏好' }).click();
  await expect(
    page.getByText('个人记忆已保存，仅对你后续的表达与输入建议生效。'),
  ).toBeVisible();
  await expect(page.getByText(key, { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText(key, { exact: true })).toBeVisible();
  await expect(
    page.getByText('报告先给摘要，金额用元。', { exact: true }),
  ).toBeVisible();
  await authenticatedSession(page, 'u-li', () =>
    page.getByLabel('切换演示身份').selectOption('u-li'),
  );
  await page.getByRole('button', { name: '记忆与提醒', exact: true }).click();
  await expect(page.getByText(key, { exact: true })).toHaveCount(0);
  await expect(
    page.getByText('报告先给摘要，金额用元。', { exact: true }),
  ).toHaveCount(0);
  await authenticatedSession(page, 'u-zhang', () =>
    page.getByLabel('切换演示身份').selectOption('u-zhang'),
  );
  await page.getByRole('button', { name: '记忆与提醒', exact: true }).click();
  const row = page
    .locator('.personal-records article')
    .filter({ hasText: key });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '删除记忆' }).click();
  await expect(
    page.getByText('记忆已删除，后续上下文立即停止使用。'),
  ).toBeVisible();
});

test('只读日程显示三次计划，保存与查看收件箱不创建隐藏聊天', async ({
  page,
}) => {
  await page.goto('/');
  await authenticatedSession(page, 'u-zhang', () =>
    page.getByRole('button', { name: /张伟.*销售部/ }).click(),
  );
  const before = await page.request.get('/api/v1/threads');
  expect(before.ok(), await before.text()).toBe(true);
  const countBefore = (await before.json()).data.items.length;
  const beforeInboxResponse = await page.request.get('/api/v1/inbox');
  expect(beforeInboxResponse.ok(), await beforeInboxResponse.text()).toBe(true);
  const beforeInbox: { id: string; title: string; preview: string }[] = (
    await beforeInboxResponse.json()
  ).data.items;
  await page.getByRole('button', { name: '记忆与提醒', exact: true }).click();
  await page.getByRole('button', { name: '摘要日程', exact: true }).click();
  await page.getByRole('button', { name: '创建只读日程' }).click();
  const editor = page.getByRole('dialog', { name: '创建只读摘要' });
  const title = `只读早报-${Date.now()}`;
  await editor.getByRole('textbox', { name: '日程名称' }).fill(title);
  await expect(editor.getByLabel('时区')).toHaveValue('Asia/Shanghai');
  await editor.getByRole('button', { name: '启用只读日程' }).click();
  await expect(
    page.getByText('只读日程已保存，结果会进入你的收件箱。'),
  ).toBeVisible();
  await expect(page.locator('.schedule-preview li')).toHaveCount(3);
  const row = page
    .locator('.personal-records article')
    .filter({ hasText: title });
  await expect(row).toContainText('周一至周五 09:00');
  await expect(row).toContainText('仅投递到本人收件箱');
  const after = await page.request.get('/api/v1/threads');
  expect((await after.json()).data.items.length).toBe(countBefore);
  await row.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(row).toContainText('已暂停');
  await row.getByRole('button', { name: '删除', exact: true }).click();
  await expect(
    page.getByText('日程已删除，历史摘要仍可独立管理。'),
  ).toBeVisible();
  await page.getByRole('button', { name: /^收件箱(?:\s*\d+)?$/ }).click();
  await expect(page.locator('.inbox-records article')).toHaveCount(
    beforeInbox.length,
  );
  if (beforeInbox.length === 0)
    await expect(
      page.getByText('收件箱还是空的。已启用日程的摘要会显示在这里。'),
    ).toBeVisible();
  else
    for (let index = 0; index < beforeInbox.length; index++) {
      const item = beforeInbox[index]!;
      const inboxRow = page.locator('.inbox-records article').nth(index);
      await expect(inboxRow).toContainText(item.title);
      await expect(inboxRow).toContainText(item.preview);
    }
  const afterInboxResponse = await page.request.get('/api/v1/inbox');
  expect(afterInboxResponse.ok(), await afterInboxResponse.text()).toBe(true);
  expect(
    (await afterInboxResponse.json()).data.items.map(
      (item: { id: string }) => item.id,
    ),
  ).toEqual(beforeInbox.map((item) => item.id));
  const final = await page.request.get('/api/v1/threads');
  expect((await final.json()).data.items.length).toBe(countBefore);
});

test('E2E-08：业务时钟推进触发真实日报，点击收件箱才建聊天且重复打开复用', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto('/');
  await authenticatedSession(page, 'u-zhang', () =>
    page.getByRole('button', { name: /张伟.*销售部/ }).click(),
  );
  const getData = async (path: string) => {
    const response = await page.request.get(`/api/v1${path}`);
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).data;
  };
  const write = async (
    path: string,
    method: 'POST' | 'PUT' | 'DELETE',
    body: unknown,
    key = crypto.randomUUID(),
  ) => {
    const me = await getData('/me');
    const response = await page.request.fetch(`/api/v1${path}`, {
      method,
      headers: {
        origin: new URL(page.url()).origin,
        'x-csrf-token': me.csrf_token,
        'idempotency-key': key,
      },
      data: body,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).data;
  };
  const original = await getData('/demo/environments/current'),
    threadsBefore = (await getData('/threads')).items.length,
    inboxBefore = new Set(
      (await getData('/inbox')).items.map((item: { id: string }) => item.id),
    );
  await page.getByRole('button', { name: '记忆与提醒', exact: true }).click();
  await page.getByRole('button', { name: '摘要日程', exact: true }).click();
  await page.getByRole('button', { name: '创建只读日程' }).click();
  const editor = page.getByRole('dialog', { name: '创建只读摘要' }),
    title = `真实日报-${Date.now()}`;
  await editor.getByRole('textbox', { name: '日程名称' }).fill(title);
  await editor.getByLabel('频率', { exact: true }).selectOption('daily');
  await editor
    .getByLabel('开始日期', { exact: true })
    .fill(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(
        new Date(original.business_now),
      ),
    );
  await editor.getByRole('button', { name: '启用只读日程' }).click();
  await expect(
    page.getByText('只读日程已保存，结果会进入你的收件箱。'),
  ).toBeVisible();
  const subscription = (await getData('/subscriptions')).items.find(
    (item: { title: string }) => item.title === title,
  );
  expect(subscription).toBeTruthy();
  expect((await getData('/threads')).items.length).toBe(threadsBefore);
  await authenticatedSession(page, 'u-zhao', () =>
    page.getByLabel('切换演示身份').selectOption('u-zhao'),
  );
  await expect(
    page.getByRole('button', { name: '运行与演示', exact: true }),
  ).toBeVisible();
  let env = await getData('/demo/environments/current');
  await write('/demo/business-clock', 'PUT', {
    expected_generation: env.generation,
    expected_environment_version: env.version,
    expected_version: env.clock_version,
    business_now: new Date(
      Date.parse(subscription.next_run_at) + 60000,
    ).toISOString(),
    timezone: env.timezone,
  });
  env = await getData('/demo/environments/current');
  const triggerBody = {
      expected_generation: env.generation,
      expected_environment_version: env.version,
      subscription_id: subscription.id,
    },
    key = crypto.randomUUID();
  const trigger = await write(
    '/demo/summary-triggers',
    'POST',
    triggerBody,
    key,
  );
  expect(trigger.status).toBe('queued');
  expect(
    await write('/demo/summary-triggers', 'POST', triggerBody, key),
  ).toEqual(trigger);
  await expect
    .poll(
      async () =>
        (await getData(`/demo/summary-triggers/${trigger.request_id}`)).status,
      { timeout: 30000 },
    )
    .toMatch(/^(scheduled|no_due_subscription)$/);
  await authenticatedSession(page, 'u-zhang', () =>
    page.getByLabel('切换演示身份').selectOption('u-zhang'),
  );

  await expect(
    page.getByRole('button', { name: '记忆与提醒', exact: true }),
  ).toBeVisible();
  let delivered:
    | { id: string; version: number; revision: number; unread: boolean }
    | undefined;
  await expect
    .poll(
      async () => {
        delivered = (await getData('/inbox')).items.find(
          (item: { id: string }) => !inboxBefore.has(item.id),
        );
        return Boolean(delivered);
      },
      { timeout: 30000 },
    )
    .toBe(true);
  expect((await getData('/threads')).items.length).toBe(threadsBefore);
  expect(delivered!.unread).toBe(true);
  expect(
    (await getData(`/subscriptions/${subscription.id}/occurrences`)).items,
  ).toHaveLength(1);
  await page.getByRole('button', { name: '记忆与提醒', exact: true }).click();
  await page.getByRole('button', { name: /^收件箱(?:\s*\d+)?$/ }).click();
  const row = page.locator('.inbox-records article').first();
  await expect(row).toContainText('待办摘要');
  await row.getByRole('button', { name: '查看摘要' }).click();
  const drawer = page.getByRole('dialog', { name: '待办摘要', exact: true });
  await expect(
    drawer.getByText('此摘要只读。继续处理时，系统会重新核对权限和对象版本。'),
  ).toBeVisible();
  await expect(drawer.locator('.inbox-body')).toContainText('待本人审核');
  await expect
    .poll(
      async () =>
        (await getData('/inbox')).items.find(
          (item: { id: string }) => item.id === delivered!.id,
        )?.unread,
    )
    .toBe(false);
  expect((await getData('/threads')).items.length).toBe(threadsBefore + 1);
  await drawer.getByRole('button', { name: '关闭详情' }).click();
  await row.getByRole('button', { name: '查看摘要' }).click();
  await expect(
    page.getByRole('dialog', { name: '待办摘要', exact: true }),
  ).toBeVisible();
  expect((await getData('/threads')).items.length).toBe(threadsBefore + 1);
  await page
    .getByRole('dialog', { name: '待办摘要', exact: true })
    .getByRole('button', { name: '关闭详情' })
    .click();
  await write(`/subscriptions/${subscription.id}/pause`, 'POST', {
    expected_version: subscription.version,
  });
  const currentSub = (await getData('/subscriptions')).items.find(
    (item: { id: string }) => item.id === subscription.id,
  );
  await write(`/subscriptions/${subscription.id}`, 'DELETE', {
    expected_version: currentSub.version,
  });
  const currentItem = (await getData('/inbox')).items.find(
    (item: { id: string }) => item.id === delivered!.id,
  );
  await write(`/inbox/${delivered!.id}`, 'DELETE', {
    expected_version: currentItem.version,
  });
  await authenticatedSession(page, 'u-zhao', () =>
    page.getByLabel('切换演示身份').selectOption('u-zhao'),
  );

  env = await getData('/demo/environments/current');
  await write('/demo/business-clock', 'PUT', {
    expected_generation: env.generation,
    expected_environment_version: env.version,
    expected_version: env.clock_version,
    business_now: original.business_now,
    timezone: original.timezone,
  });
});
