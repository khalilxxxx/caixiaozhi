// Browser interaction verification uses an isolated HTTP fixture, never writes the user workspace.
import { chromium, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs/promises';

const out = 'artifacts/single-agent-progress-20261117';
await fs.mkdir(out, { recursive: true });
const base = await fetch('http://127.0.0.1:5191/api/local/workspace').then(r => r.json());
let snapshot, task, runId, runStatus, history, clients, sequence, submitted;
function reset(status = 'running') {
  for (const client of clients ?? []) client.end();
  clients = new Set(); history = []; sequence = 0; submitted = [];
  runId = 'qa-run'; runStatus = status;
  task = { id: 'qa-progress', title: '费用对比与报表', status: status === 'running' ? '处理中' : '已暂停', type: 'assistant', input: '', refs: [], updated: '刚刚', activeRunId: status === 'running' ? runId : null,
    messages: [{ id: 'qa-user', role: 'user', text: '对比两个月的费用，核对金额后生成报表。' }, { id: `assistant-${runId}`, runId, runStatus: status, role: 'assistant', text: '', tools: [] }] };
  snapshot = { ...structuredClone(base), revision: 1, state: { ...structuredClone(base.state), activeTask: task.id, tasks: [task] } };
}
reset();
function emit(kind, data, replayId) {
  const id = replayId ?? ++sequence;
  const entry = `id: ${id}\nevent: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
  if (!replayId) history.push({ id, entry });
  for (const client of clients) client.write(entry);
  return id;
}
function step(id, name, label, status, durationMs) {
  const entry = { id, name, label, status, startedAt: Date.now() - 1500, ...(status === 'running' ? {} : { finishedAt: Date.now(), durationMs }) };
  const message = task.messages.find(m => m.runId === runId);
  const index = message.tools.findIndex(s => s.id === id);
  if (index < 0) message.tools.push(entry); else message.tools[index] = entry;
  snapshot.revision++;
  return emit('tool', entry);
}
function finish(status = 'completed', text = '费用报表已生成，金额已核对。') {
  runStatus = status; task.activeRunId = null;
  task.status = status === 'completed' ? '已完成' : status === 'cancelled' ? '已暂停' : '执行失败';
  const message = task.messages.find(m => m.runId === runId);
  message.text = text; message.runStatus = status;
  message.tools = message.tools.map(s => s.status === 'running' ? { ...s, status: 'cancelled', finishedAt: Date.now(), durationMs: 1500 } : s);
  snapshot.revision++;
  emit('result', { workspace: snapshot, text, status: task.status, runStatus: status });
  emit('done', {});
  for (const client of clients) client.end();
  clients.clear();
}
const server = http.createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:5190');
  response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Access-Control-Allow-Headers', 'content-type,last-event-id');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  const path = new URL(request.url, 'http://fixture').pathname;
  const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
  if (path.endsWith('/events')) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    response.write(': connected\n\n'); clients.add(response);
    const after = Number(request.headers['last-event-id'] ?? 0);
    for (const event of history) if (event.id > after) response.write(event.entry);
    if (runStatus !== 'running') response.end();
    request.on('close', () => clients.delete(response)); return;
  }
  let body = ''; for await (const chunk of request) body += chunk;
  const payload = body ? JSON.parse(body) : {};
  if (path.endsWith('/health')) return json({ status: 'ready', modelConfigured: true, model: 'fixture', framework: 'Agno', version: '3.2.0' });
  if (path.endsWith('/workspace')) {
    if (request.method === 'PATCH') {
      const incoming = payload.tasks?.find(t => t.id === task.id);
      if (incoming) for (const key of ['input', 'title', 'refs']) if (key in incoming) task[key] = incoming[key];
      snapshot.revision++;
    }
    return json(snapshot);
  }
  if (path.endsWith('/cancel')) { finish('cancelled', '任务已暂停，已保存内容仍保留。'); return json({ cancelled: true }); }
  if (path.endsWith('/runs') && request.method === 'POST') {
    submitted.push(payload); history = []; sequence = 0; runId = `qa-run-${submitted.length}`; runStatus = 'running';
    task.activeRunId = runId; task.status = '处理中';
    task.messages.push({ id: `u-${runId}`, role: 'user', text: payload.message });
    task.messages.push({ id: `assistant-${runId}`, runId, runStatus, role: 'assistant', text: '', tools: [] });
    return json({ taskId: task.id, runId, workspace: snapshot });
  }
  if (path.includes('/runs/')) return json({ id: runId, status: runStatus });
  response.statusCode = 404; json({ message: '未提供测试接口' });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const results = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.route('**/api/local/**', route => route.continue({ url: `http://127.0.0.1:${port}${new URL(route.request().url()).pathname}` }));
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto('http://127.0.0.1:5190/agent.html#chat');
  await expect(page.locator('.chat-titlebar h1')).toHaveText(task.title);
  await expect.poll(() => clients.size).toBeGreaterThan(0);
  emit('status', { phase: 'thinking', label: '正在分析任务' });
  step('read', 'read_uploaded_file', '读取费用材料', 'running');
  step('read', 'read_uploaded_file', '读取费用材料', 'completed', 120);
  const duplicate = step('sum', 'summarize_expense_csv', '核对费用合计', 'running');
  await expect(page.locator('.run-progress-summary').last()).toContainText('核对费用合计');
  await page.locator('.run-progress-summary').last().click();
  await expect(page.locator('.run-progress-step')).toHaveCount(2);
  emit('tool', task.messages.at(-1).tools.at(-1), duplicate);
  await expect(page.locator('.run-progress-step')).toHaveCount(2);
  emit('delta', { text: '已完成费用归类，正在核对合计。' });
  await expect(page.locator('.assistant-name').last().locator('..')).toContainText('已完成费用归类');
  await expect(page.locator('.run-progress-step')).toHaveCount(2);
  await page.locator('.composer textarea').fill('请保留我还没有发送的补充说明');
  await page.screenshot({ path: `${out}/desktop-running.png`, fullPage: true });
  results.push('运行中的真实动作、步骤去重、文字与进度并存、输入草稿');

  await page.reload();
  await expect(page.locator('.run-progress-summary').last()).toContainText('核对费用合计');
  await page.locator('.run-progress-summary').last().click();
  await expect(page.locator('.run-progress-step')).toHaveCount(2);
  await expect(page.locator('.composer textarea')).toHaveValue('请保留我还没有发送的补充说明');
  step('sum', 'summarize_expense_csv', '核对费用合计', 'failed', 1800);
  step('sum-retry', 'summarize_expense_csv', '核对费用合计', 'running');
  step('sum-retry', 'summarize_expense_csv', '核对费用合计', 'completed', 800);
  step('publish', 'publish_skill_artifact', '保存生成文件', 'completed', 220);
  finish();
  await expect(page.locator('.chat-titlebar')).toContainText('已完成');
  await expect(page.locator('.run-progress-details').last()).not.toHaveAttribute('open', '');
  await page.locator('.run-progress-summary').last().click();
  await expect(page.locator('.run-progress-step')).toHaveCount(4);
  await expect(page.locator('.run-progress-step.is-failed')).toHaveCount(1);
  await expect(page.locator('.composer textarea')).toHaveValue('请保留我还没有发送的补充说明');
  await page.screenshot({ path: `${out}/desktop-completed.png`, fullPage: true });
  results.push('刷新恢复、失败重试分开、终态收起与历史展开、输入保留');

  reset();
  step('long', 'read_uploaded_file', '读取材料', 'running');
  await page.reload();
  await expect(page.getByRole('button', { name: '停止当前任务' })).toBeVisible();
  await page.getByRole('button', { name: '停止当前任务' }).click();
  await expect(page.getByRole('button', { name: '继续处理', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '继续处理', exact: true }).click();
  await expect.poll(() => submitted.length).toBe(1);
  await expect.poll(() => clients.size).toBeGreaterThan(0);
  step('resumed', 'read_uploaded_file', '读取已保存材料', 'running');
  await expect(page.locator('.run-progress-summary').last()).toContainText('读取已保存材料');
  finish('failed', '材料缺少金额列，请补充后继续。');
  await expect(page.locator('.chat-titlebar')).toContainText('执行失败');
  await expect(page.getByRole('button', { name: /继续处理|重试/ }).last()).toBeVisible();
  results.push('停止保留记录、主动继续、失败恢复入口');

  reset();
  for (let i = 0; i < 28; i++) step(`history-${i}`, 'read_uploaded_file', `核对第 ${i + 1} 份费用材料`, 'completed', 100 + i);
  step('current', 'validate_submission', '检查单据', 'running');
  await page.reload();
  await page.locator('.run-progress-summary').last().click();
  const thread = page.locator('.chat-thread');
  await thread.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  const top = await thread.evaluate(element => element.scrollTop);
  emit('delta', { text: '已核对材料，继续检查。' });
  await expect.poll(() => thread.evaluate(element => element.scrollTop)).toBe(top);
  await expect(page.getByRole('button', { name: '回到最新' })).toBeVisible();
  await page.getByRole('button', { name: '回到最新' }).click();
  await expect.poll(() => thread.evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThan(120);
  results.push('向上阅读不抢滚动、回到最新');

  reset();
  step('mobile-one', 'read_uploaded_file', '读取费用材料', 'completed', 1700);
  step('mobile-two', 'validate_submission', '检查费用金额与附件完整性', 'running');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator('.run-progress-summary').last().click();
  await expect(page.locator('.run-progress-step')).toHaveCount(2);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) throw new Error('窄屏存在横向溢出');
  await page.screenshot({ path: `${out}/mobile-running.png`, fullPage: true });
  finish('cancelled', '任务已暂停，已保存内容仍保留。');
  await expect(page.getByRole('button', { name: '继续处理', exact: true })).toBeVisible();
  await page.screenshot({ path: `${out}/mobile-paused.png`, fullPage: true });
  results.push('390px布局、暂停与继续操作可达');
  if (errors.length) throw new Error(errors.join('\n'));
  await fs.writeFile(`${out}/browser-verification.json`, JSON.stringify({ fixture: true, results, errors, status: 'passed' }, null, 2));
  console.log(JSON.stringify({ status: 'passed', results, errors }, null, 2));
} finally {
  for (const client of clients) client.end();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
