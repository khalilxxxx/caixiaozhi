// Browser interaction verification uses an isolated HTTP fixture, never writes the user workspace.
import { chromium, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs/promises';

const out = process.env.PROGRESS_ARTIFACT_DIR || 'artifacts/single-agent-progress-20261117';
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
function step(id, name, label, status, durationMs, itinerary) {
  const entry = { id, name, label, status, ...(itinerary && { itinerary }), startedAt: Date.now() - 1500, ...(status === 'running' ? {} : { finishedAt: Date.now(), durationMs }) };
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
  await expect(page.locator('.run-progress-details').last()).toHaveAttribute('open', '');
  await expect(page.locator('.run-progress-step')).toHaveCount(2);
  await page.locator('.run-progress-toggle').click();
  await expect(page.locator('.run-progress-steps')).toBeHidden();
  emit('status', { phase: 'working', label: '核对费用合计' });
  await expect(page.locator('.run-progress-steps')).toBeHidden();
  await page.locator('.run-progress-toggle').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.run-progress-steps')).toBeVisible();
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
  await expect(page.locator('.run-progress-details').last()).toHaveAttribute('open', '');
  await expect(page.locator('.run-progress-step')).toHaveCount(2);
  await expect(page.locator('.composer textarea')).toHaveValue('请保留我还没有发送的补充说明');
  step('sum', 'summarize_expense_csv', '核对费用合计', 'failed', 1800);
  step('sum-retry', 'summarize_expense_csv', '核对费用合计', 'running');
  step('sum-retry', 'summarize_expense_csv', '核对费用合计', 'completed', 800);
  step('publish', 'publish_skill_artifact', '保存生成文件', 'completed', 220);
  finish();
  await expect(page.locator('.chat-titlebar')).toContainText('已完成');
  await expect(page.locator('.run-progress-details').last()).not.toHaveAttribute('open', '');
  await page.locator('.run-progress-toggle').last().click();
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
  await expect(page.locator('.run-progress-details').last()).toHaveAttribute('open', '');
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
  await expect(page.locator('.run-progress-details').last()).toHaveAttribute('open', '');
  await expect(page.locator('.run-progress-step')).toHaveCount(2);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) throw new Error('窄屏存在横向溢出');
  await page.screenshot({ path: `${out}/mobile-running.png`, fullPage: true });
  finish('cancelled', '任务已暂停，已保存内容仍保留。');
  await expect(page.getByRole('button', { name: '继续处理', exact: true })).toBeVisible();
  await page.screenshot({ path: `${out}/mobile-paused.png`, fullPage: true });
  results.push('390px布局、暂停与继续操作可达');

  // Exercise the real CSS animation path separately from the existing reduced-motion journeys.
  reset();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload();
  await expect.poll(() => clients.size).toBeGreaterThan(0);
  const progress = page.locator('.run-progress').last();
  const summary = progress.locator('.run-progress-summary');
  const activityLabel = summary.locator('.run-progress-label');
  const hasRunningAnimation = locator => locator.evaluate(element =>
    element.getAnimations({ subtree: true }).some(animation => animation.playState === 'running'));
  const icon = summary.locator('.run-progress-activity-icon');
  const glint = activityLabel.locator('.run-progress-glint');
  const orbit = icon.locator('.run-progress-orbit-light');
  const animations = locator => locator.evaluate(element =>
    element.getAnimations({ subtree: true }).map(animation => animation.animationName));
  const expectActivity = async (kind, label) => {
    await expect(summary).toHaveAttribute('data-activity', kind);
    await expect(icon).toBeVisible();
    await expect(progress.getByRole('status')).toHaveText(label);
    await expect(activityLabel).toContainText(label);
    await expect(glint).toHaveAttribute('aria-hidden', 'true');
    await expect.poll(() => animations(glint)).toContain('run-progress-glint');
    await expect.poll(() => hasRunningAnimation(summary)).toBe(true);
    if (kind === 'thinking') {
      await expect(orbit).toBeVisible();
      await expect.poll(() => animations(orbit)).toContain('run-progress-orbit');
    } else {
      await expect(orbit).toHaveCount(0);
    }
  };
  emit('status', { phase: 'thinking', label: '正在分析任务' });
  await expectActivity('thinking', '正在分析任务');
  await page.screenshot({ path: `${out}/desktop-thinking-motion.png`, fullPage: true });
  await page.locator('.message.assistant').last().screenshot({ path: `${out}/thinking-status-detail.png` });
  const captureMotionFrames = async (firstFrame, count) => {
    if (process.env.CAPTURE_PROGRESS_GIF !== '1') return;
    const frames = `${out}/motion-frames`;
    await fs.mkdir(frames, { recursive: true });
    try {
      for (let frame = 0; frame < count; frame++) {
        await summary.evaluate((element, time) => {
          for (const animation of element.getAnimations({ subtree: true })) {
            animation.pause();
            animation.currentTime = time;
          }
        }, frame * 100);
        const number = String(firstFrame + frame).padStart(2, '0');
        await summary.screenshot({ path: `${frames}/frame-${number}.png` });
      }
    } finally {
      await summary.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => animation.play()));
    }
  };
  await captureMotionFrames(0, 38);
  const activities = [
    ['reading', 'read_uploaded_file', '读取费用材料'],
    ['searching', 'search_policies', '检索差旅制度'],
    ['calculating', 'summarize_expense_csv', '汇总费用金额'],
    ['writing', 'write_skill_file', '保存工作文件'],
    ['checking', 'validate_skill_artifact', '核对成果金额'],
  ];
  const symbols = new Set();
  for (const [kind, name, label] of activities) {
    step(kind, name, label, 'running');
    emit('status', { phase: 'working', label });
    await expectActivity(kind, label);
    symbols.add(await icon.locator('svg').innerHTML());
    const details = progress.locator('.run-progress-details');
    if (kind === 'reading') {
      await captureMotionFrames(38, 19);
      await details.locator('summary').click();
    }
    await expect(details).not.toHaveAttribute('open', '');
    step(kind, name, label, 'completed', 180);
  }
  if (symbols.size !== activities.length) throw new Error('不同业务动作使用了相同图标');
  await progress.locator('.run-progress-toggle').click();
  await expect(progress.locator('.run-progress-steps')).toBeVisible();
  await expect.poll(() => hasRunningAnimation(progress.locator('.run-progress-details'))).toBe(false);
  emit('status', { phase: 'thinking', label: '正在思考' });
  await expectActivity('thinking', '正在思考');
  emit('status', { phase: 'responding', label: '正在整理回复' });
  await expectActivity('writing', '正在整理回复');
  emit('status', { phase: 'checking', label: '正在核对结果' });
  await expectActivity('checking', '正在核对结果');
  await page.screenshot({ path: `${out}/desktop-checking-motion.png`, fullPage: true });
  await page.locator('.message.assistant').last().screenshot({ path: `${out}/checking-status-detail.png` });
  results.push('思考光轨、五类动作图标和当前动作扫光；新增步骤保留手动折叠状态，步骤和计数保持静态');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => hasRunningAnimation(progress)).toBe(false);
  await expect(progress.getByRole('status')).toHaveText('正在核对结果');
  await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'active' });
  await expect.poll(() => hasRunningAnimation(progress)).toBe(false);
  await expect(activityLabel).toBeVisible();
  await page.emulateMedia({ forcedColors: 'none', contrast: 'more' });
  await expect.poll(() => hasRunningAnimation(progress)).toBe(false);
  await expect(icon).toBeVisible();
  await page.emulateMedia({ contrast: 'no-preference' });
  await expectActivity('checking', '正在核对结果');
  emit('status', { status: '待你回答', label: '等待回答' });
  await expect(activityLabel).toHaveText('等待回答');
  await expect(glint).toHaveCount(0);
  await expect(orbit).toHaveCount(0);
  await expect.poll(() => hasRunningAnimation(progress)).toBe(false);
  results.push('服务端等待回答事件停止动效，即使尚未收到本轮终态');
  finish();
  await expect(progress).toHaveClass(/is-completed/);
  await expect(glint).toHaveCount(0);
  await expect(orbit).toHaveCount(0);
  await expect.poll(() => hasRunningAnimation(progress)).toBe(false);
  await expect(progress.locator('.run-progress-toggle')).toContainText('已完成');
  results.push('减少动态、增强对比度和强制色彩时保持静态且文字可读，完成后停止进度动效');

  // A long conversation provides real scroll clipping for IntersectionObserver pause/resume.
  reset();
  task.messages.unshift(...Array.from({ length: 18 }, (_, index) => ({
    id: `motion-history-${index}`, role: index % 2 ? 'assistant' : 'user',
    text: `第 ${index + 1} 条历史核对记录。\n已核对费用类型与归集月份。\n保留原始材料和业务依据。\n继续处理最新事项。`,
  })));
  await page.reload();
  await expect.poll(() => clients.size).toBeGreaterThan(0);
  emit('status', { phase: 'thinking', label: '正在分析任务' });
  await expectActivity('thinking', '正在分析任务');
  await thread.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  await expect(progress).toHaveAttribute('data-motion-paused', 'true');
  await expect.poll(() => hasRunningAnimation(progress)).toBe(false);
  await page.getByRole('button', { name: '回到最新' }).click();
  await expect(progress).not.toHaveAttribute('data-motion-paused', 'true');
  await expectActivity('thinking', '正在分析任务');
  results.push('向上阅读使活动行离屏后暂停、回到最新恢复动效');

  step('motion-stop', 'read_uploaded_file', '读取费用材料', 'running');
  await expectActivity('reading', '读取费用材料');
  await page.getByRole('button', { name: '停止办理', exact: true }).click();
  await expect(progress).toHaveClass(/is-paused|is-cancelled/);
  await expect(glint).toHaveCount(0);
  await expect(orbit).toHaveCount(0);
  await expect.poll(() => hasRunningAnimation(progress)).toBe(false);
  await expect(page.getByRole('button', { name: '继续处理', exact: true })).toBeVisible();
  results.push('卡内停止后无活动动画，保留继续处理入口');
  reset();
  task.title = '准备一份差旅申请';
  task.messages[0].text = '帮我准备去上海的差旅申请。';
  step('attachment', 'read_uploaded_file', '读取行程附件', 'completed', 800);
  step('travel', 'get_submission_draft', '读取差旅草稿', 'completed', 1100,
    { destination: '上海', transport: '高铁二等座' });
  step('prepare', 'update_submission_draft', '正在更新差旅申请草稿', 'running');
  await page.reload();
  await expect(progress.locator('.run-progress-count')).toHaveText('2/3 项已完成');
  await expect(progress.locator('.run-progress-context')).toContainText('上海');
  await expect(progress.getByText('0.8 秒')).toBeVisible();
  await page.locator('.message.assistant').last().screenshot({ path: `${out}/stitch-execution-card.png` });
  await page.screenshot({ path: `${out}/stitch-execution-desktop.png` });
  results.push('与本轮绑定的行程摘要、完成数量及毫秒级耗时');
  if (errors.length) throw new Error(errors.join('\n'));
  await fs.writeFile(`${out}/browser-verification.json`, JSON.stringify({ fixture: true, results, errors, status: 'passed' }, null, 2));
  console.log(JSON.stringify({ status: 'passed', results, errors }, null, 2));
} finally {
  for (const client of clients) client.end();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
