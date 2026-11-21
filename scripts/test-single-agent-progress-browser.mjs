// Exercise the real agent entry point with isolated SSE and workspace fixtures.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { createServer } = webRequire('vite');
const out = process.env.PROGRESS_ARTIFACT_DIR || 'artifacts/agent-activity-feed';
const seed = JSON.parse(await fs.readFile(new URL('../apps/agno-service/seed.json', import.meta.url), 'utf8'));
const clients = new Set();
let snapshot, task, runId, runStatus, history, sequence, submitted;
const responseTo = () => task.messages.find(message => message.runId === runId);

function reset(elapsedMs = 0) {
  for (const client of clients) client.end();
  clients.clear();
  history = []; sequence = 0; submitted = [];
  runId = 'qa-run'; runStatus = 'running';
  const runStartedAt = Date.now() - elapsedMs;
  task = {
    id: 'qa-progress', title: '费用核对', type: 'assistant', status: '处理中', updated: '刚刚',
    refs: [], input: '', activeRunId: runId,
    messages: [
      { id: 'qa-user', role: 'user', text: '核对费用材料和报销草稿，看看是否可以提交。' },
      { id: 'assistant-' + runId, runId, runStatus, role: 'assistant', text: '', tools: [], createdAt: runStartedAt, runStartedAt },
    ],
  };
  snapshot = { revision: 1, state: { ...structuredClone(seed), activeTask: task.id, tasks: [task] } };
}

function emit(kind, data, replayId) {
  const id = replayId ?? ++sequence;
  const entry = 'id: ' + id + '\nevent: ' + kind + '\ndata: ' + JSON.stringify(data) + '\n\n';
  if (!replayId) history.push({ id, entry });
  for (const client of clients) client.write(entry);
  return id;
}

function step(id, name, label, status, extra = {}) {
  const tools = responseTo().tools;
  const index = tools.findIndex(entry => entry.id === id);
  const startedAt = tools[index]?.startedAt ?? Date.now() - (extra.durationMs ?? 0);
  const entry = { id, name, label, status, startedAt, ...extra };
  if (status !== 'running') entry.finishedAt = startedAt + (extra.durationMs ?? 0);
  if (index < 0) tools.push(entry);
  else tools[index] = entry;
  snapshot.revision++;
  return emit('tool', entry);
}

function finish(status, text, { elapsedMs, question } = {}) {
  const message = responseTo();
  const runFinishedAt = elapsedMs === undefined ? Date.now() : message.runStartedAt + elapsedMs;
  runStatus = status;
  task.activeRunId = null;
  task.status = { completed: '已完成', cancelled: '已暂停', failed: '执行失败', awaiting_input: '待你回答' }[status];
  Object.assign(message, { text, runStatus: status, runFinishedAt });
  if (question) message.question = question;
  message.tools = message.tools.map(entry => entry.status === 'running'
    ? { ...entry, status: status === 'failed' ? 'failed' : 'cancelled', finishedAt: runFinishedAt }
    : entry);
  snapshot.revision++;
  if (status === 'cancelled' || status === 'failed') emit('error', { runId, runStatus, message: text });
  else emit('result', { runId, runStatus, text, tools: message.tools, status: task.status, workspace: snapshot });
  emit('done', {});
  for (const client of clients) client.end();
  clients.clear();
}

const vite = await createServer({
  configFile: fileURLToPath(new URL('../apps/web/vite.agent.config.ts', import.meta.url)),
  cacheDir: fileURLToPath(new URL('../.runtime/progress-browser-vite', import.meta.url)),
  server: { middlewareMode: true, hmr: false },
  logLevel: 'error',
});
const server = http.createServer(async (request, response) => {
  const path = new URL(request.url, 'http://fixture').pathname;
  if (!path.startsWith('/api/local/')) return vite.middlewares(request, response);
  const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
  if (path.endsWith('/events')) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    response.write(': connected\n\n');
    clients.add(response);
    const after = Number(request.headers['last-event-id'] ?? 0);
    for (const event of history) if (event.id > after) response.write(event.entry);
    if (runStatus !== 'running') response.end();
    response.on('close', () => clients.delete(response));
    return;
  }
  let body = ''; for await (const chunk of request) body += chunk;
  const payload = body ? JSON.parse(body) : {};
  if (path.endsWith('/health')) return json({ status: 'ready', modelConfigured: true, model: 'fixture', framework: 'Agno' });
  if (path.endsWith('/workspace')) {
    if (request.method === 'PATCH') {
      const incoming = payload.tasks?.find(item => item.id === task.id);
      if (incoming) for (const key of ['input', 'title', 'refs']) if (key in incoming) task[key] = incoming[key];
      snapshot.revision++;
    }
    return json(snapshot);
  }
  if (path.endsWith('/cancel')) {
    finish('cancelled', '任务已暂停，已保存内容仍保留。');
    return json({ cancelled: true });
  }
  if (path.endsWith('/runs') && request.method === 'POST') {
    const previous = responseTo();
    if (previous.question && payload.questionAnswer) {
      previous.question.status = 'answered';
      previous.question.answer = payload.questionAnswer;
    }
    submitted.push(payload); history = []; sequence = 0;
    runId = 'qa-run-' + submitted.length; runStatus = 'running';
    const now = Date.now();
    task.status = '处理中'; task.activeRunId = runId;
    task.messages.push({ id: 'user-' + runId, role: 'user', text: payload.message });
    task.messages.push({ id: 'assistant-' + runId, runId, runStatus, role: 'assistant', text: '', tools: [], createdAt: now, runStartedAt: now });
    snapshot.revision++;
    return json({ taskId: task.id, runId, workspace: snapshot });
  }
  if (path.includes('/runs/')) return json({ id: runId, status: runStatus });
  response.statusCode = 404; return json({ message: '未提供测试接口' });
});

reset();
await fs.mkdir(out, { recursive: true });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port + '/agent.html#chat';
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const message = page.locator('.message.assistant').last();
  const progress = message.locator('.run-progress');
  const activity = progress.locator('.run-progress-summary');
  const disclosure = progress.locator('details > summary');
  const findings = progress.locator('.run-progress-finding');
  const thread = page.locator('.chat-thread');
  const hasMotion = async () => activity.evaluate(el => el.getAnimations({ subtree: true }).some(a => a.playState === 'running'));
  async function open() {
    if (page.url() === url) await page.reload();
    else await page.goto(url);
    await expect(page.locator('.chat-titlebar h1')).toHaveText(task.title);
    if (runStatus === 'running') await expect.poll(() => clients.size).toBeGreaterThan(0);
  }

  // A single quick lookup finishes directly. Actual backend timestamps, not tool durations, drive elapsed time.
  task.title = '查询差旅制度';
  task.messages[0].text = '境内出差可以按什么座席订票？';
  await open();
  step('rule', 'search_policies', '检索差旅制度', 'running');
  await expect(activity).toContainText('检索差旅制度');
  await expect(activity.locator('.run-progress-face')).toBeVisible();
  await expect(message.locator('.assistant-name img')).toBeVisible();
  step('rule', 'search_policies', '检索差旅制度', 'completed', { durationMs: 60 });
  finish('completed', '境内出差可以按二等座标准订票。', { elapsedMs: 1500 });
  await expect(message).toContainText('二等座标准');
  await expect(disclosure).toHaveCount(0);
  await expect(message.getByText(/办理记录|执行记录/)).toHaveCount(0);
  await expect(message.locator('.run-progress-face')).toBeHidden();

  // Keep facts while subsequent operations run, across live events, reconnect and history.
  reset(470000);
  await open();
  step('materials', 'list_materials', '查看材料', 'completed', { durationMs: 90, finding: '已列出 2 份材料。' });
  const fact = '2 条费用记录合计 900.00 元。';
  const readId = step('read', 'read_expense_summary', '读取费用汇总', 'completed', { durationMs: 180, finding: fact });
  emit('tool', responseTo().tools.at(-1), readId);
  step('check', 'validate_submission', '检查报销草稿', 'running');
  await expect(activity).toContainText('检查报销草稿');
  await expect(findings.filter({ hasText: fact })).toHaveCount(1);
  await expect(page.getByText(fact, { exact: true })).toBeVisible();
  await expect.poll(hasMotion).toBe(true);
  const roleImage = message.locator('.assistant-name img');
  await roleImage.evaluate(el => { window.qaAvatar = el; });
  await page.screenshot({ path: out + '/desktop-running.png' });
  await message.screenshot({ path: out + '/running-message.png' });
  await page.locator('.composer textarea').fill('还没有发送的补充说明');
  if (process.env.CAPTURE_PROGRESS_GIF === '1') {
    await fs.mkdir(out + '/motion-frames', { recursive: true });
    for (let frame = 0; frame < 38; frame++) {
      await activity.evaluate((el, ms) => {
        for (const animation of el.getAnimations({ subtree: true })) {
          animation.pause(); animation.currentTime = ms;
        }
      }, frame * 100);
      await activity.screenshot({ path: out + '/motion-frames/frame-' + String(frame).padStart(2, '0') + '.png' });
    }
    await activity.evaluate(el => el.getAnimations({ subtree: true }).forEach(a => a.play()));
  }
  await disclosure.click();
  await expect(page.getByText(fact, { exact: true })).toBeHidden();
  emit('status', { phase: 'working', label: '检查报销草稿' });
  await expect(page.getByText(fact, { exact: true })).toBeHidden();
  await disclosure.focus(); await page.keyboard.press('Enter');
  await expect(page.getByText(fact, { exact: true })).toBeVisible();
  emit('delta', { text: '正在检查草稿字段。' });
  await expect(message).toContainText('正在检查草稿字段。');
  assert.ok(await roleImage.evaluate(el => el === window.qaAvatar));
  await page.reload();
  await expect(activity).toContainText('检查报销草稿');
  await expect(page.getByText(fact, { exact: true })).toBeVisible();
  await expect(page.locator('.composer textarea')).toHaveValue('还没有发送的补充说明');
  step('check', 'validate_submission', '检查报销草稿', 'failed', { durationMs: 900 });
  step('retry', 'validate_submission', '检查报销草稿', 'completed', { durationMs: 650, finding: '草稿有 1 项字段需要核对。' });
  finish('completed', '费用汇总为 900.00 元，报销草稿中仍有 1 项字段需要核对。', { elapsedMs: 474000 });
  await expect(message).toContainText('费用汇总为 900.00 元');
  await expect(disclosure).toContainText(/用时\s*7\s*分(?:钟)?\s*54\s*秒/);
  await expect(page.getByText(fact, { exact: true })).toBeHidden();
  await expect(activity.locator('.run-progress-face')).toBeHidden();
  await message.screenshot({ path: out + '/completed-message.png' });
  await disclosure.click();
  await expect(page.getByText(fact, { exact: true })).toBeVisible();
  await expect(progress.locator('.run-progress-steps')).toContainText(/失败|未成功|未完成|未能/);
  await page.screenshot({ path: out + '/desktop-history.png' });
  await page.reload();
  await expect(disclosure).toContainText(/用时\s*7\s*分(?:钟)?\s*54\s*秒/);
  await expect(page.getByText(fact, { exact: true })).toBeHidden();
  await disclosure.focus(); await page.keyboard.press('Enter');
  await expect(page.getByText(fact, { exact: true })).toBeVisible();

  // Waiting for a real question stops the face immediately. The question remains actionable in the composer.
  reset(16000);
  task.title = '北京差旅申请';
  task.messages[0].text = '11 月 22 日从杭州去北京，帮我准备差旅申请。';
  await open();
  step('lookup', 'get_submission_draft', '读取差旅草稿', 'completed', {
    durationMs: 140, finding: '差旅申请中已有 1 段行程。', itinerary: { destination: '北京', transport: '高铁' },
  });
  emit('status', { status: '待你回答', label: '等待回答' });
  await expect(activity.locator('.run-progress-face')).toBeHidden();
  const question = { id: 'q-trip', title: '这次需要另起一份申请吗？', multiple: false, status: 'pending', options: [{ id: 'new', label: '另起一份申请' }, { id: 'existing', label: '我指的是已有申请' }] };
  finish('awaiting_input', question.title, { question, elapsedMs: 17000 });
  await expect(page.getByRole('radio', { name: '我指的是已有申请' })).toBeVisible();
  await expect(page.getByText('差旅申请中已有 1 段行程。', { exact: true })).toBeVisible();
  const send = page.getByRole('button', { name: '发送回答' });
  await expect(send).toBeDisabled();
  await page.getByRole('radio', { name: '我指的是已有申请' }).check();
  await send.click();
  await expect.poll(() => submitted.length).toBe(1);
  await expect.poll(() => clients.size).toBeGreaterThan(0);
  finish('completed', '原申请已提交待受理。');
  await expect(message).toContainText('原申请已提交待受理。');

  // Users can read older messages, stop a run, resume it, and see an actionable failure at narrow widths.
  reset(12000);
  task.messages.unshift(...Array.from({ length: 20 }, (_, i) => ({
    id: 'earlier-' + i, role: i % 2 ? 'assistant' : 'user', text: '历史对话 ' + (i + 1) + '，查看上次核对的数据。\n费用材料已归入原单。',
  })));
  step('receipt', 'list_materials', '查看材料', 'completed', { durationMs: 100, finding: '已列出 2 份材料。' });
  step('amount', 'validate_submission', '核对金额字段', 'running');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open();
  await expect(activity).toContainText('核对金额字段');
  await expect.poll(hasMotion).toBe(false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: out + '/mobile-running.png' });
  await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'active' });
  await expect.poll(hasMotion).toBe(false);
  await page.emulateMedia({ forcedColors: 'none', contrast: 'more' });
  await expect.poll(hasMotion).toBe(false);
  await page.emulateMedia({ contrast: 'no-preference' });
  await expect.poll(hasMotion).toBe(true);
  await thread.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  await expect(page.getByRole('button', { name: '回到最新' })).toBeVisible();
  await expect.poll(hasMotion).toBe(false);
  emit('delta', { text: '正在核对金额字段。' });
  await expect.poll(() => thread.evaluate(el => el.scrollTop)).toBe(0);
  await page.getByRole('button', { name: '回到最新' }).click();
  await expect.poll(hasMotion).toBe(true);
  await message.getByRole('button', { name: '停止办理', exact: true }).click();
  await expect(page.getByRole('button', { name: '继续处理', exact: true })).toBeVisible();
  await expect(message.locator('.run-progress-face')).toBeHidden();
  await page.getByRole('button', { name: '继续处理', exact: true }).click();
  await expect.poll(() => clients.size).toBeGreaterThan(0);
  finish('failed', '材料缺少金额列，请补充附件后继续。');
  await expect(message).toContainText('材料缺少金额列');
  await expect(page.getByRole('button', { name: /继续处理|重试/ }).last()).toBeVisible();
  await expect(message.locator('.run-progress-face')).toBeHidden();
  await page.screenshot({ path: out + '/mobile-failure.png' });

  assert.deepEqual(errors, []);
  const results = ['短任务直接呈现结果', '动作、发现和当前面屏同屏', '事件去重及刷新恢复', '整轮实测耗时与键盘回看', '待答停动与输入区应答', '窄屏和减少动态', '阅读位置与停止/继续、失败恢复'];
  await fs.writeFile(out + '/browser-verification.json', JSON.stringify({ fixture: true, results, errors, status: 'passed' }, null, 2));
  console.log(JSON.stringify({ status: 'passed', results }, null, 2));
} finally {
  for (const client of clients) client.end();
  await browser?.close();
  await vite.close();
  await new Promise(resolve => server.close(resolve));
}
