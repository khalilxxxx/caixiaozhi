const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const output = process.env.SCHEDULE_TEST_OUTPUT || 'artifacts/scheduled-tasks-20261117';
  const frontend = process.env.SCHEDULE_TEST_FRONTEND || 'http://127.0.0.1:5190';
  const backend = process.env.SCHEDULE_TEST_BACKEND || 'http://127.0.0.1:5194';
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const page = await browser.newPage({ baseURL: frontend, viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    let historyMode = 'server';
    await page.route('**/api/local/**', async route => {
      const source = new URL(route.request().url());
      if (/\/schedules\/[^/]+\/runs$/.test(source.pathname)) {
        if (historyMode === 'offline') {
          return route.fulfill({ status: 503, json: { message: '运行记录暂时无法加载' } });
        }
        if (historyMode === 'failed') {
          return route.fulfill({ json: { items: [
            {
              id: 'fixture-failed', status: 'failed', trigger: 'manual',
              scheduledAt: null, startedAt: '2026-11-20T09:00:00+08:00', finishedAt: '2026-11-20T09:00:02+08:00',
              summary: '', error: '未获取到待处理单据', taskId: null,
            },
            {
              id: 'fixture-missed', status: 'missed', trigger: 'scheduled',
              scheduledAt: '2026-11-19T09:00:00+08:00', startedAt: '2026-11-19T10:10:00+08:00', finishedAt: '2026-11-19T10:10:00+08:00',
              summary: '', error: '已错过执行时间，未自动补跑。', taskId: null,
            },
          ] } });
        }
      }
      const target = new URL(source.pathname + source.search, backend);
      const response = await route.fetch({ url: target.href, headers: { ...route.request().headers(), origin: target.origin } });
      await route.fulfill({ response });
    });
    await page.goto('/agent.html#home');
    const nav = page.getByRole('navigation', { name: '应用导航' });
    await expect(nav.getByRole('group', { name: '工作区' }).getByRole('button')).toHaveText(['能力中心', '轻应用', '自动化']);
    await expect(nav.getByRole('group', { name: '常用应用' }).getByRole('button')).toHaveText(['我的工作', '规则中心', '数据分析', '全部工具']);
    const automation = nav.getByRole('button', { name: '自动化', exact: true });
    await automation.click();
    await expect(page).toHaveURL(/#schedules$/);
    await expect(automation).toHaveAttribute('aria-current', 'page');
    const banner = page.locator('header.catalog-heading[data-catalog="schedules"]');
    await expect(banner.getByRole('heading', { name: '自动化', level: 1, exact: true })).toBeVisible();

    await page.getByRole('button', { name: '新建任务', exact: true }).click();
    let editor = page.getByRole('dialog', { name: '新建定时任务' });
    const taskName = `定时预审回归-${Date.now()}`;
    await editor.getByLabel('任务名称').fill(taskName);
    await expect(editor.getByLabel('执行时间 · 北京时间')).toHaveValue('09:00');
    await page.screenshot({ path: path.join(output, 'editor.png') });
    await editor.getByRole('button', { name: '保存任务' }).click();
    await expect(editor).toHaveCount(0);

    const trigger = page.getByRole('button', { name: taskName, exact: true });
    const row = page.locator('.schedule-item').filter({ has: page.getByText(taskName, { exact: true }) });
    const drawer = page.getByRole('dialog', { name: taskName, exact: true });
    const historyTab = drawer.getByRole('tab', { name: '执行历史', exact: true });
    const detailsTab = drawer.getByRole('tab', { name: '任务详情', exact: true });
    const history = drawer.getByRole('region', { name: taskName + '的运行记录' });
    await expect(row).toContainText('每天 09:00');
    await expect(row).toContainText('已启用');
    await page.reload();
    await expect(row).toContainText('每天 09:00');
    await row.locator('td').filter({ hasText: '每天 09:00' }).click();
    await expect(drawer).toBeVisible();
    await expect(detailsTab).toHaveAttribute('aria-selected', 'true');
    await expect(drawer).toContainText('预审');
    await expect(drawer).toContainText('每天 09:00');
    await page.screenshot({ path: path.join(output, 'task-details.png') });

    historyMode = 'offline';
    await historyTab.click();
    await expect(history).toContainText('运行记录暂时无法加载');
    historyMode = 'server';
    await history.getByRole('button', { name: '重试' }).click();
    await expect(history).toContainText(/暂无.*记录/);
    await detailsTab.click();

    historyMode = 'failed';
    await historyTab.click();
    await expect(history).toContainText('未获取到待处理单据');
    await expect(history.getByRole('button', { name: /查看会话/ })).toHaveCount(0);
    const missed = history.getByRole('button', { name: /已错过/ });
    await expect(missed).toHaveAttribute('aria-expanded', 'false');
    await missed.click();
    await expect(missed).toHaveAttribute('aria-expanded', 'true');
    await expect(history).toContainText('已错过执行时间，未自动补跑。');
    historyMode = 'server';
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.press('Enter');
    await drawer.getByRole('button', { name: '暂停', exact: true }).click();
    await expect(drawer.getByRole('button', { name: '启用', exact: true })).toBeVisible();
    await expect(row).toContainText('已暂停');
    await drawer.getByRole('button', { name: '启用', exact: true }).click();
    await expect(row).toContainText('已启用');
    await drawer.getByRole('button', { name: '编辑任务', exact: true }).click();
    editor = page.getByRole('dialog', { name: '编辑定时任务' });
    await editor.getByLabel('执行频率').selectOption('weekly');
    await editor.getByLabel('周一', { exact: true }).check();
    await editor.getByLabel('周五', { exact: true }).check();
    await editor.getByRole('button', { name: '保存任务' }).click();
    await expect(editor).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText('周一、周五 09:00');
    await drawer.getByRole('button', { name: '关闭任务详情' }).click();
    await expect(trigger).toBeFocused();
    await row.getByRole('button', { name: '立即运行', exact: true }).click();
    await expect(historyTab).toHaveAttribute('aria-selected', 'true');
    await expect(history).toContainText('已完成', { timeout: 25000 });
    await expect(history).toContainText('已预审');
    await page.screenshot({ path: path.join(output, 'list-and-history.png') });
    await history.getByRole('button', { name: '查看会话', exact: true }).click();
    await expect(page).toHaveURL(/#chat$/);
    await expect(page.locator('.chat-page')).toContainText('已预审');

    await page.goto('/agent.html#schedules');
    await expect(automation).toHaveAttribute('aria-current', 'page');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByLabel('搜索定时任务').fill(taskName);
    await expect(page.locator('.schedule-item')).toHaveCount(1);
    await expect(page.getByRole('region', { name: taskName + '的运行记录' })).toHaveCount(0);
    await page.screenshot({ path: path.join(output, 'desktop-1280.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1280);
    const historyShortcut = row.getByRole('button', { name: `查看${taskName}的执行历史` });
    await historyShortcut.click();
    await expect(historyTab).toHaveAttribute('aria-selected', 'true');
    await expect(history).toContainText('已预审');
    await page.keyboard.press('Escape');
    await expect(historyShortcut).toBeFocused();

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      if (width === 390) {
        await page.goto('/agent.html#home');
        const openNavigation = page.getByRole('button', { name: '打开导航' });
        await openNavigation.click();
        await automation.click();
        await expect(openNavigation).toHaveAttribute('aria-expanded', 'false');
      }
      await expect(page.getByRole('heading', { name: '自动化', level: 1 })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await trigger.click();
      await expect(drawer).toBeVisible();
      await expect.poll(() => drawer.evaluate(el => {
        const rect = el.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= window.innerWidth + 1;
      })).toBe(true);
      await historyTab.click();
      await expect(history).toContainText('已预审');
      expect(await drawer.evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: path.join(output, `mobile-history-${width}.png`) });
      await drawer.getByRole('button', { name: '关闭任务详情' }).click();
      await expect(trigger).toBeFocused();
    }

    await trigger.click();
    await drawer.getByRole('button', { name: '删除任务', exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await expect(row).toHaveCount(0);
    expect(errors).toEqual([]);
    console.log('通过自动化任务创建、整行与键盘打开、历史失败和重试、空历史、编辑、启停、真实预审及结果会话、回焦、删除及窄屏回归。');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
