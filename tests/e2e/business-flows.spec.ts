import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';

async function loginAsLi(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /李娜.*销售部/ }).click();
  await expect(page.getByRole('button', { name: '开始新任务' })).toBeVisible();
}
async function uploadAndConfirm(
  panel: Locator,
  filename: string,
  number: string,
  type: 'transport' | 'meals',
) {
  const path = fileURLToPath(
    new URL(`../../docs/demo-invoices/${filename}`, import.meta.url),
  );
  await panel.getByLabel('上传票据原件', { exact: true }).setInputFiles(path);
  await expect(
    panel.getByText('文件已完成内容校验。请选择演示识别或人工录入。'),
  ).toBeVisible({ timeout: 30000 });
  await panel.getByRole('button', { name: '演示识别', exact: true }).click();
  await expect(panel.getByLabel('票据号码')).toHaveValue(number, {
    timeout: 45000,
  });
  await expect(panel.getByLabel('价税合计（元）', { exact: true })).toHaveValue(
    type === 'transport' ? '180.00' : '200.00',
  );
  await expect(panel.getByLabel('税额（元）', { exact: true })).toHaveValue(
    '0.00',
  );
  await expect(
    panel.getByLabel('不含税金额（元）', { exact: true }),
  ).toHaveValue(type === 'transport' ? '180.00' : '200.00');
  await panel.getByLabel('费用类型', { exact: true }).selectOption(type);
  if (type === 'meals') await panel.getByLabel('本次餐饮属于业务招待').check();
  await panel
    .getByRole('button', { name: '确认票面与费用类型', exact: true })
    .click();
  await expect(
    panel.getByText('票面字段已确认；核验状态以服务端结果为准。'),
  ).toBeVisible();
  await expect(
    panel.getByRole('button', { name: '确认票面与费用类型', exact: true }),
  ).toBeDisabled();
}
async function confirmPrepared(page: Page) {
  const confirmation = page.getByRole('dialog', {
    name: '确认本次操作',
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  await confirmation
    .getByRole('button', { name: '确认并执行', exact: true })
    .click();
  const receipt = page.getByRole('dialog', { name: '操作回执', exact: true });
  await expect(
    receipt.getByRole('heading', { name: '已完成', exact: true }),
  ).toBeVisible();
  await receipt.getByRole('button', { name: '返回', exact: true }).click();
}

test('真实界面两票上传、识别、确认、关联OA并提交38000分，撤回释放本次额度', async ({
  page,
}) => {
  test.setTimeout(150000);
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  await loginAsLi(page);
  await page.getByRole('button', { name: '票据与报销', exact: true }).click();
  await page.getByRole('button', { name: '管理票据', exact: true }).click();
  const uploadDrawer = page.getByRole('dialog', {
      name: '票据与费用材料',
      exact: true,
    }),
    panel = uploadDrawer.locator('.invoice-panel');
  await uploadAndConfirm(
    panel,
    'invoice_transport_demo.pdf',
    'DEMO-TR-9001',
    'transport',
  );
  await uploadAndConfirm(
    panel,
    'invoice_ambiguous_demo.pdf',
    'DEMO-ME-9002',
    'meals',
  );
  await uploadDrawer
    .getByRole('button', { name: '关闭详情', exact: true })
    .click();
  await page.getByRole('button', { name: '新建报销', exact: true }).click();
  let drawer = page.getByRole('dialog', { name: '未命名报销', exact: true });
  const title = `界面两票报销-${Date.now()}`;
  await drawer.getByLabel('单据标题', { exact: true }).fill(title);
  await drawer
    .getByLabel('申请事由', { exact: true })
    .fill('合成演示交通和业务招待费用');
  await drawer.getByLabel('成本中心', { exact: true }).selectOption('cc-sales');
  for (const number of ['DEMO-TR-9001', 'DEMO-ME-9002']) {
    await drawer
      .getByRole('button', { name: '从已确认票据加入费用', exact: true })
      .click();
    const row = drawer.locator('.invoice-list>li').filter({ hasText: number });
    await row
      .getByRole('button', { name: '作为费用加入', exact: true })
      .click();
  }
  await expect(drawer.locator('.expense-line')).toHaveCount(2);
  const meals = drawer.locator('.expense-line').nth(1);
  await meals.getByLabel('业务招待餐饮', { exact: true }).check();
  await meals
    .getByLabel('关联已批准的招待申请', { exact: true })
    .selectOption('oa-001');
  await drawer.getByRole('button', { name: '保存草稿', exact: true }).click();
  drawer = page.getByRole('dialog', { name: title, exact: true });
  await expect(drawer.getByText(/草稿已保存 v/)).toBeVisible();
  await expect(
    drawer.locator('.document-heading').getByText('¥380.00', { exact: true }),
  ).toBeVisible();
  await drawer
    .getByRole('button', { name: '核对并准备提交', exact: true })
    .click();
  const confirmation = page.getByRole('dialog', {
    name: '确认本次操作',
    exact: true,
  });
  await expect(
    confirmation.getByText('¥380.00', { exact: true }),
  ).toBeVisible();
  await confirmPrepared(page);
  await expect(
    drawer
      .locator('.document-heading')
      .getByText('待主管审批', { exact: true }),
  ).toBeVisible();
  // 仍通过显式界面确认撤回本次新申请，避免改变后续五单预审的基准待办数量。
  await drawer
    .getByRole('button', { name: '核对撤回当前申请', exact: true })
    .click();
  await confirmPrepared(page);
  await expect(
    drawer.locator('.document-heading').getByText('已撤回', { exact: true }),
  ).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test('差旅抽屉手工保存后刷新仍读取同一持久版本', async ({ page }) => {
  await loginAsLi(page);
  await page.getByRole('button', { name: '差旅申请', exact: true }).click();
  await page.getByRole('button', { name: '新建差旅', exact: true }).click();
  let drawer = page.getByRole('dialog', { name: '未命名差旅', exact: true });
  const title = `界面保存差旅-${Date.now()}`;
  await drawer.getByLabel('单据标题', { exact: true }).fill(title);
  await drawer
    .getByLabel('申请事由', { exact: true })
    .fill('先保存手工内容，随后可继续补齐行程');
  await drawer.getByLabel('成本中心', { exact: true }).selectOption('cc-sales');
  await drawer.getByRole('button', { name: '保存草稿', exact: true }).click();
  drawer = page.getByRole('dialog', { name: title, exact: true });
  await expect(
    drawer.getByText('草稿已保存 v2。', { exact: true }),
  ).toBeVisible();
  await page.reload();
  drawer = page.getByRole('dialog', { name: title, exact: true });
  await expect(drawer.getByLabel('单据标题', { exact: true })).toHaveValue(
    title,
  );
  await expect(drawer.getByLabel('申请事由', { exact: true })).toHaveValue(
    '先保存手工内容，随后可继续补齐行程',
  );
  await expect(
    drawer.getByText('当前保存版本 v2', { exact: true }),
  ).toBeVisible();
});
