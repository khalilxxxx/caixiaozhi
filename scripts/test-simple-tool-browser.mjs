import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';

const out = 'artifacts/flow-simple-20261117';
const base = process.env.SIMPLE_TEST_WEB || 'http://127.0.0.1:5193';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
try {
  await page.goto(`${base}/agent.html#skills?tab=tools&tool=expense-summary`);
  await page.getByRole('heading', { name: '费用汇总', exact: true }).waitFor();
  await page.locator('.expense-summary-file-input').setInputFiles({ name: '页面费用汇总.csv', mimeType: 'text/csv', buffer: Buffer.from('费用类型,金额\n交通,12.50\n办公,20.00\n交通,-2.50\n') });
  await expect(page.getByLabel('费用文件', { exact: true })).toHaveValue(/file-/);
  await page.getByRole('button', { name: '开始汇总', exact: true }).click();
  await expect(page.locator('.expense-summary-result tfoot')).toContainText('30.00');
  await expect(page.locator('.expense-summary-result tbody')).toContainText('10.00');
  await expect(page.locator('.expense-summary-result tbody')).toContainText('20.00');
  const resultId = new URLSearchParams(page.url().split('?tab=')[1] ? page.url().split('#')[1].split('?')[1] : '').get('result');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载汇总 CSV', exact: true }).click();
  await (await downloadEvent).saveAs(`${out}/browser-summary.csv`);
  const csv = await fs.readFile(`${out}/browser-summary.csv`, 'utf8');
  if (!csv.includes('交通,10.00,2') || !csv.includes('合计,30.00,3')) throw new Error('下载金额不一致');
  await page.screenshot({ path: `${out}/tool-1440.png`, fullPage: true });
  await page.reload();
  await expect(page.locator('.expense-summary-result tfoot')).toContainText('30.00');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${out}/tool-390.png`, fullPage: true });
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('工具窄屏整页溢出');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.expense-summary-file-input').setInputFiles({ name: '错误金额.csv', mimeType: 'text/csv', buffer: Buffer.from('费用类型,金额\n办公,NaN\n') });
  await page.getByRole('button', { name: '开始汇总', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('第 2 行金额无效');
  await page.screenshot({ path: `${out}/tool-invalid.png`, fullPage: true });
  const live = JSON.parse(await fs.readFile(`${out}/live-journeys.json`, 'utf8')).find((item) => item.kind === 'csv');
  await page.goto(`${base}/agent.html#history`);
  await page.getByRole('button', { name: /请调用费用汇总小工具，汇总这个CSV/ }).first().click();
  await page.locator('.result-card').filter({ hasText: '费用汇总' }).last().click();
  await expect(page).toHaveURL(new RegExp(`result=${live.cards[0].id}`));
  await expect(page.locator('.expense-summary-result tfoot')).toContainText('30.00');
  if (errors.length) throw new Error(errors.join('\n'));
  await fs.writeFile(`${out}/browser-tool.json`, JSON.stringify({ resultId, total: '30.00', download: true, refresh: true, chatCard: true, mobileOverflow: false, invalidMoneyRejected: true, errors }, null, 2));
  console.log(JSON.stringify({ toolFlow: 'passed', resultId, errors }));
} catch (error) {
  await fs.writeFile(`${out}/tool-browser-failure.txt`, String(error) + '\n\n' + await page.locator('body').innerText());
  await page.screenshot({ path: `${out}/tool-browser-failure.png`, fullPage: true });
  throw error;
} finally { await browser.close(); }
