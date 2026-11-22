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

async function sampleActionText(activity, times, seekAnimations = false) {
  const label = activity.getByRole('status');
  const frames = [];
  const start = performance.now();
  for (const ms of times) {
    if (seekAnimations) {
      await activity.evaluate(async (row, time) => {
        const animations = row.getAnimations({ subtree: true });
        for (const animation of animations) animation.pause();
        await Promise.all(animations.map(animation => animation.ready));
        for (const animation of animations) animation.currentTime = time;
      }, ms);
    } else {
      // Observe reduced-motion playback without advancing an intentionally paused animation.
      await new Promise(resolve => setTimeout(resolve, Math.max(0, start + ms - performance.now())));
    }
    const png = await label.screenshot();
    if (process.env.CAPTURE_PROGRESS_GIF === '1')
      await fs.writeFile(out + '/text-' + times.length + '-' + ms + '.png', png);
    frames.push(await label.evaluate(async (_, data) => {
      const image = new Image();
      image.src = 'data:image/png;base64,' + data;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      const lightness = [];
      for (let i = 0; i < pixels.length; i += 4)
        lightness.push(Math.round(.2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2]));
      return { width: image.width, lightness };
    }, png.toString('base64')));
  }
  return frames;
}

function measureTextSweep(frames, reference) {
  const { width, lightness } = reference;
  const paper = lightness[0];
  // The still frame identifies the letters independently of the animation.
  // Measure changes against each pixel's darkest sample to locate the moving highlight.
  const darkest = lightness.map((_, i) => Math.min(...frames.map(frame => frame.lightness[i])));
  const centers = [];
  let maxGlyphChange = 0, maxPaperChange = 0;
  for (const frame of frames) {
    assert.equal(frame.lightness.length, lightness.length);
    let weightedX = 0, weight = 0, visiblePixels = 0;
    for (let i = 0; i < lightness.length; i++) {
      const change = frame.lightness[i] - darkest[i];
      if (lightness[i] >= paper - 3) maxPaperChange = Math.max(maxPaperChange, change);
      if (lightness[i] > paper - 45) continue;
      maxGlyphChange = Math.max(maxGlyphChange, change);
      if (change < 18) continue;
      weightedX += (i % width) * change;
      weight += change;
      visiblePixels++;
    }
    if (visiblePixels >= 8) centers.push(weightedX / weight / width);
  }
  const travel = centers.length ? centers.at(-1) - centers[0] : 0;
  return { maxGlyphChange, maxPaperChange, travel: Number(travel.toFixed(2)), visibleFrames: centers.length };
}

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

const server = http.createServer();
const vite = await createServer({
  configFile: fileURLToPath(new URL('../apps/web/vite.agent.config.ts', import.meta.url)),
  cacheDir: fileURLToPath(new URL('../.runtime/progress-browser-vite', import.meta.url)),
  server: { middlewareMode: true, watch: null, hmr: { server } },
  logLevel: 'error',
});
server.on('request', async (request, response) => {
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
      if (incoming) {
        for (const key of ['input', 'title', 'refs']) if (key in incoming) task[key] = incoming[key];
        for (const message of incoming.messages ?? []) {
          if (message.role === 'user' && !task.messages.some(previous => previous.id === message.id))
            task.messages.push(message);
        }
      }
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
    if (previous?.question && payload.questionAnswer) {
      previous.question.status = 'answered';
      previous.question.answer = payload.questionAnswer;
    }
    submitted.push(payload); history = []; sequence = 0;
    runId = 'qa-run-' + submitted.length; runStatus = 'running';
    const now = Date.now();
    task.status = '处理中'; task.activeRunId = runId;
    if (!payload.useSavedComposer) task.refs = payload.refs;
    if (!payload.preserveComposerDraft && !payload.questionAnswer) task.input = '';
    const last = task.messages.at(-1);
    if (last?.role !== 'user' || last.text !== payload.message)
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
  const context = await browser.newContext({
    viewport: { width: 1360, height: 900 },
    deviceScaleFactor: process.env.CAPTURE_PROGRESS_GIF === '1' ? 2 : 1,
  });
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
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const still = await sampleActionText(activity, [0, 400, 1000]);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => activity.getByRole('status').evaluate(el =>
    el.getAnimations({ subtree: true }).some(animation => animation.playState === 'running')
  )).toBe(true);
  const animated = await sampleActionText(activity, Array.from({ length: 11 }, (_, i) => i * 100), true);
  const sweep = measureTextSweep(animated, still[0]);
  const reducedSweep = measureTextSweep(still, still[0]);
  console.log('首秒文字像素', JSON.stringify({ sweep, reducedSweep }));
  assert.ok(sweep.travel >= .35 && sweep.maxGlyphChange >= 25 && sweep.visibleFrames >= 5,
    '首秒应在至少 5 帧中看到亮带沿字形向右移动超过三分之一行宽：' + JSON.stringify(sweep));
  assert.ok(sweep.maxPaperChange <= 4, '亮带应只照亮字形，不改变文字背景');
  assert.equal(reducedSweep.maxGlyphChange, 0, '减少动态时文字应保持完全静止');
  step('rule', 'search_policies', '检索差旅制度', 'completed', { durationMs: 60 });
  finish('completed', '境内出差可以按二等座标准订票。', { elapsedMs: 1500 });
  await expect(message).toContainText('二等座标准');
  await expect(disclosure).toHaveCount(0);
  await expect(message.getByText(/办理记录|执行记录/)).toHaveCount(0);
  await expect(message.locator('.run-progress-face')).toBeHidden();

  // Let a single lookup actually cross the threshold without sending a new SSE event.
  reset();
  await open();
  step('policy', 'search_policies', '查询差旅制度', 'running');
  await expect(activity).toContainText('查询差旅制度');
  await expect(disclosure).toHaveCount(0);
  const scope = progress.getByText('我先查找与这次咨询相关的制度条款。', { exact: true });
  await expect(scope).toBeVisible({ timeout: 11000 });
  await expect(disclosure).toContainText(/用时\s*\d+\s*秒/);
  await disclosure.focus();
  await page.keyboard.press('Space');
  await expect(scope).toBeHidden();
  step('policy', 'search_policies', '查询差旅制度', 'completed', { finding: '查到 2 份相关制度。' });
  step('draft', 'get_submission_draft', '读取草稿', 'running');
  await expect(activity).toContainText('读取草稿');
  await expect(scope).toBeHidden();
  await expect(disclosure).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(progress.getByText('查到 2 份相关制度。', { exact: true })).toBeVisible();
  step('draft', 'get_submission_draft', '读取草稿', 'completed');
  finish('completed', '已根据两份制度核对差旅草稿。');
  await expect(message).toContainText('已根据两份制度核对差旅草稿。');
  await expect(scope).toBeHidden();

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
    const faceBox = await activity.locator('.run-progress-face').boundingBox();
    const labelBox = await activity.getByRole('status').boundingBox();
    const x = Math.floor(faceBox.x - 8);
    const y = Math.floor(Math.min(faceBox.y, labelBox.y) - 5);
    const clip = {
      x, y,
      width: Math.ceil(labelBox.x + labelBox.width + 8) - x,
      height: Math.ceil(Math.max(faceBox.y + faceBox.height, labelBox.y + labelBox.height) + 5) - y,
    };
    const period = await activity.getByRole('status').evaluate(el =>
      Math.max(0, ...el.getAnimations({ subtree: true }).map(a => Number(a.effect.getTiming().duration)))
    );
    for (let frame = 0; frame * 50 < (period || 2200); frame++) {
      await activity.evaluate((el, ms) => {
        for (const animation of el.getAnimations({ subtree: true })) {
          animation.pause(); animation.currentTime = ms;
        }
      }, frame * 50);
      await page.screenshot({ clip, path: out + '/motion-frames/frame-' + String(frame).padStart(3, '0') + '.png' });
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
  const tripFact = page.getByText('差旅申请中已有 1 段行程。', { exact: true });
  await expect(tripFact).toBeVisible();
  await disclosure.focus();
  await page.keyboard.press('Space');
  await expect(tripFact).toBeHidden();
  await expect(progress.getByRole('status')).toContainText('待你回答');
  const send = page.getByRole('button', { name: '发送回答' });
  await expect(send).toBeDisabled();
  await page.getByRole('radio', { name: '我指的是已有申请' }).focus();
  await page.keyboard.press('Space');
  await expect(send).toBeEnabled();
  await send.focus();
  await page.keyboard.press('Enter');
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
  await expect(message).toContainText('正在核对金额字段。');
  await expect.poll(() => thread.evaluate(el => el.scrollTop)).toBe(0);
  await page.getByRole('button', { name: '回到最新' }).click();
  await expect.poll(hasMotion).toBe(true);
  await message.getByRole('button', { name: '停止办理', exact: true }).click();
  await expect(page.getByRole('button', { name: '继续处理', exact: true })).toBeVisible();
  await expect(message.locator('.run-progress-face')).toBeHidden();
  await page.getByRole('button', { name: '继续处理', exact: true }).click();
  await expect.poll(() => clients.size).toBeGreaterThan(0);
  step('extract', 'extract_expense_materials', '提取费用材料', 'running');
  await expect(activity).toContainText('提取费用材料');
  finish('failed', '材料缺少金额列，请补充附件后继续。');
  await expect(message).toContainText('材料缺少金额列');
  await expect(page.locator('.chat-titlebar .badge.red')).toHaveText('执行失败');
  const resume = page.getByRole('button', { name: '继续处理', exact: true });
  await expect(resume).toBeVisible();
  await expect(message.locator('.run-progress-face')).toBeHidden();
  await page.setViewportSize({ width: 320, height: 740 });
  await disclosure.focus();
  await page.keyboard.press('Enter');
  await expect(progress.locator('.run-progress-steps')).toBeHidden();
  await expect(progress.getByRole('status')).toContainText('提取费用材料未成功');
  await expect(progress.getByRole('status').locator('.run-problem-action')).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: out + '/mobile-failure.png' });
  await resume.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => submitted.length).toBe(2);
  await expect.poll(() => clients.size).toBeGreaterThan(0);
  finish('completed', '已重新读取补充的材料。');
  await expect(message).toContainText('已重新读取补充的材料。');

  // A terminal notification can arrive while the reader has keyboard focus on a closed disclosure.
  for (const terminalStatus of ['awaiting_input', 'failed']) {
    reset(12000);
    await open();
    step('files', 'list_materials', '查看材料', 'completed', { finding: '已列出 2 份材料。' });
    step('validate', 'validate_submission', '检查单据', 'running');
    await expect(activity).toContainText('检查单据');
    await disclosure.focus();
    await page.keyboard.press('Space');
    await expect(progress.locator('details')).toHaveJSProperty('open', false);
    if (terminalStatus === 'failed') {
      step('validate', 'validate_submission', '检查单据', 'failed');
      step('policy', 'search_policies', '查询制度说明', 'completed');
      finish('failed', '办理未完成，可稍后继续处理。');
      await expect(message).toContainText('办理未完成，可稍后继续处理。');
    } else {
      finish('awaiting_input', question.title, { question: { ...question, status: 'pending' } });
      await expect(page.getByRole('radio', { name: '我指的是已有申请' })).toBeVisible();
    }
    await expect(progress.getByRole('status')).toContainText(terminalStatus === 'failed' ? '办理未完成' : '待你回答');
    await expect(progress.locator('details')).toHaveJSProperty('open', false);
    await expect(disclosure).toBeFocused();
    if (terminalStatus === 'failed')
      await expect(progress.getByRole('status').getByText(/检查单据未成功/)).toBeVisible();
  }

  // The run does not exist yet. Hold the actual POST until the user has typed another draft.
  reset();
  finish('completed', '上一轮核对已完成。');
  const sourceFile = { kind: 'file', id: 'qa-expenses', title: '费用清单.pdf' };
  task.refs = [sourceFile];
  await open();
  const input = page.locator('.composer textarea');
  const originalText = '请根据费用清单核对本次报销金额。';
  const nextDraft = '稍后再帮我准备一份新的差旅申请。';
  const failureText = '服务暂时不可用，请稍后重试。';
  let releaseRequest;
  const holdFirstPost = new Promise(resolve => { releaseRequest = resolve; });
  await page.route('**/api/local/runs', async route => {
    await holdFirstPost;
    await route.fulfill({ status: 503, json: { message: failureText } });
  }, { times: 1 });
  const firstRequest = page.waitForRequest(request =>
    request.method() === 'POST' && request.url().endsWith('/api/local/runs')
  );
  await input.fill(originalText);
  await input.press('Enter');
  const firstPayload = (await firstRequest).postDataJSON();
  try {
    await expect(page.getByRole('button', { name: '正在发送请求' })).toBeDisabled();
    await expect(page.getByRole('button', { name: /停止当前任务|停止办理/ })).toHaveCount(0);
    await input.fill(nextDraft);
  } finally {
    releaseRequest();
  }
  await expect(message.getByText(failureText, { exact: true })).toBeVisible();
  await expect(page.locator('.chat-titlebar .badge.red')).toHaveText('发送失败');
  await expect(page.locator('.toast').filter({ hasText: failureText })).toHaveCount(0);
  await expect(input).toHaveValue(nextDraft);
  await page.getByRole('button', { name: '移除费用清单.pdf' }).click();
  assert.equal(firstPayload.message, originalText);
  assert.deepEqual(firstPayload.refs, [sourceFile]);
  await page.getByRole('button', { name: '重新发送', exact: true }).click();
  await expect.poll(() => submitted.length).toBe(1);
  assert.equal(submitted[0].message, originalText);
  assert.deepEqual(submitted[0].refs, [sourceFile]);
  assert.equal(submitted[0].preserveComposerDraft, true);
  await expect.poll(() => clients.size).toBeGreaterThan(0);
  await expect(input).toHaveValue(nextDraft);
  await expect(page.getByRole('button', { name: '移除费用清单.pdf' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '停止当前任务' })).toBeEnabled();
  finish('completed', '已根据费用清单核对报销金额。');
  await expect(message).toContainText('已根据费用清单核对报销金额。');
  await expect(input).toHaveValue(nextDraft);
  await expect(page.locator('.message.user').getByText(originalText, { exact: true })).toHaveCount(1);

  // A newly typed draft can reach workspace PATCH before an ordinary POST reaches the service.
  let acceptRequest;
  const holdOrdinaryPost = new Promise(resolve => { acceptRequest = resolve; });
  await page.route('**/api/local/runs', async route => {
    await holdOrdinaryPost;
    await route.continue();
  }, { times: 1 });
  const ordinaryRequest = page.waitForRequest(request =>
    request.method() === 'POST' && request.url().endsWith('/api/local/runs')
  );
  await input.press('Enter');
  assert.equal((await ordinaryRequest).postDataJSON().message, nextDraft);
  const laterDraft = '新申请请补充出发地和目的地。';
  try {
    await input.fill(laterDraft);
    await expect.poll(() => task.input).toBe(laterDraft);
  } finally {
    acceptRequest();
  }
  await expect.poll(() => submitted.length).toBe(2);
  assert.deepEqual(submitted[1].refs, []);
  await expect.poll(() => clients.size).toBeGreaterThan(0);
  await expect(input).toHaveValue(laterDraft);
  finish('completed', '差旅申请已准备好。');
  await expect(message).toContainText('差旅申请已准备好。');
  await expect(input).toHaveValue(laterDraft);
  assert.deepEqual(errors, []);
  const results = [
    '短任务直接呈现结果',
    '首秒文字光扫逐帧可见且横移，减少动态时字形静止',
    '单项任务超过 8 秒自动展示范围',
    '手动折叠经过工具切换仍保持可键盘展开',
    '动作、发现和当前面屏同屏',
    '事件去重及刷新恢复',
    '整轮耗时与键盘回看',
    '待答停动、收起后键盘应答',
    '窄屏和减少动态',
    '阅读位置与停止/继续',
    '失败收起后仍可读原因并键盘重试',
    '转为待答或失败保留折叠及键盘焦点',
    '失败后其他步骤成功仍保留实际失败原因',
    '创建运行前的发送状态与可编辑草稿',
    '发送失败后仅提示一次，重发原话与引用并保留新草稿',
    '普通发送成功后保留请求途中已暂存的新草稿',
  ];
  await fs.writeFile(out + '/browser-verification.json', JSON.stringify({ fixture: true, results, firstSecond: { sweep, reducedSweep }, errors, status: 'passed' }, null, 2));
  console.log(JSON.stringify({ status: 'passed', results }, null, 2));
} finally {
  for (const client of clients) client.end();
  await browser?.close();
  await vite.close();
  await new Promise(resolve => server.close(resolve));
}
