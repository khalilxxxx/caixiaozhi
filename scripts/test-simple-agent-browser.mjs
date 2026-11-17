import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';

const root = 'artifacts/flow-simple-20261117';
const base = process.env.SIMPLE_TEST_WEB || 'http://127.0.0.1:5193';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
try {
  await page.goto(`${base}/agent.html#files`);
  await page.getByRole('heading', { name: '材料与文件', exact: true }).waitFor();
  await page.getByRole('checkbox', { name: '选择办公费用材料.txt', exact: true }).last().check();
  await page.getByRole('button', { name: '核对费用', exact: true }).click();
  await expect(page.locator('.dw-expense-item')).toHaveCount(1);
  if (await page.locator('.dw-expense-head').getAttribute('aria-expanded') !== 'true')
    await page.locator('.dw-expense-head').click();
  await expect(page.getByLabel('金额（元）', { exact: true })).toHaveValue('80.50');
  await page.screenshot({ path: `${root}/material-confirm.png`, fullPage: true });
  await page.getByRole('button', { name: '保存并确认', exact: true }).click();
  await page.getByRole('checkbox', { name: /已核对本次使用的 1 笔费用/ }).check();
  await page.getByRole('button', { name: /生成.*草稿/ }).click();
  // 部分入口直接载入已核对费用；手动载入入口仍可使用。
  await page.getByRole('button', { name: '载入费用', exact: true }).click({ timeout: 1500 }).catch(() => {});
  await expect(page.locator('.sf-panel')).toContainText('80.50');
  const edit = page.getByRole('tab', { name: '编辑单据', exact: true });
  if (await edit.count()) await edit.click();
  await page.getByLabel('单据事由', { exact: true }).fill('日常办公采购');
  await page.screenshot({ path: `${root}/submission-before-check.png`, fullPage: true });
  await page.getByRole('button', { name: /保存并检查|检查并继续|核对并提交/ }).click();
  await page.getByRole('checkbox', { name: '我已核对内容，确认提交请求。' }).check();
  await page.getByRole('button', { name: '确认提交', exact: true }).click();
  await expect(page.getByRole('heading', { name: '本地业务已受理', exact: true })).toBeVisible();
  await page.screenshot({ path: `${root}/submission-receipt.png`, fullPage: true });
  const snapshot = await (await page.request.get(`${base}/api/local/workspace`)).json();
  const request = snapshot.state.data.submissions.requests.find((item) => item.amountCents === 8050 && item.snapshot.purpose === '日常办公采购');
  if (!request) throw new Error('没有对应的80.50元受理记录');
  if (request.check.review.findings.some((finding) => finding.rule.metric === 'validInvoice')) throw new Error('残留发票查验');
  await page.reload();
  await page.getByRole('heading', { name: '材料与文件', exact: true }).waitFor();
  const after = await (await page.request.get(`${base}/api/local/receipts/${request.receiptId}`)).json();
  if (after.receipt.id !== request.receiptId) throw new Error('刷新后回执丢失');
  await fs.writeFile(`${root}/browser-material.json`, JSON.stringify({ requestId: request.id, receiptId: request.receiptId, amountCents: request.amountCents, errors }, null, 2));
  console.log(JSON.stringify({ materialFlow: 'passed', amountCents: request.amountCents, receiptId: request.receiptId, errors }));
} catch (error) {
  await fs.writeFile(`${root}/browser-failure.txt`, String(error) + '\n\n' + await page.locator('body').innerText());
  await page.screenshot({ path: `${root}/browser-failure.png`, fullPage: true });
  throw error;
} finally {
  await browser.close();
}
