export const css = `
.variant-b .b-assistant { color: #29292d; margin: 28px 0 12px; }
.variant-b .b-companion { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 18px; align-items: start; }
.variant-b .b-mascot-stage { position: relative; width: 64px; height: 72px; display: flex; align-items: flex-start; justify-content: center; }
.variant-b .b-mascot { display: block; width: 60px; height: 60px; object-fit: contain; transform-origin: 50% 84%; }
.variant-b .b-action-symbol { position: absolute; right: 0; bottom: 9px; width: 24px; height: 24px; display: grid; place-items: center; border: 2px solid #fafaf9; border-radius: 50%; color: #276584; background: #e8f1f5; }
.variant-b .b-dialogue { min-width: 0; padding-top: 1px; }
.variant-b .b-identity { display: flex; align-items: baseline; flex-wrap: wrap; column-gap: 10px; row-gap: 4px; margin-bottom: 9px; font-size: 13px; line-height: 1.5; }
.variant-b .b-name { color: #55555c; font-weight: 600; }
.variant-b .b-status { color: #66666b; font-size: 12px; }
.variant-b .b-sentence { margin: 0; font-size: 17px; font-weight: 500; line-height: 1.65; overflow-wrap: anywhere; }
.variant-b .b-detail { margin: 5px 0 0; max-width: 64ch; color: #66666b; font-size: 14px; line-height: 1.8; overflow-wrap: anywhere; }
.variant-b .b-trajectory { margin-top: 22px; max-width: 620px; }
.variant-b .b-trail { display: flex; align-items: flex-start; list-style: none; padding: 0; margin: 0; }
.variant-b .b-trail-item { flex: 1 1 0; position: relative; min-width: 0; padding-right: 12px; }
.variant-b .b-trail-item:last-child { padding-right: 0; }
.variant-b .b-trail-item:not(:last-child)::before { content: ''; position: absolute; height: 1px; top: 8px; left: 23px; right: 8px; background: #e2e4e5; }
.variant-b .b-trail-marker { position: relative; width: 17px; height: 17px; display: grid; place-items: center; color: #78787e; border: 1px solid #d8dadd; border-radius: 50%; background: #fafaf9; }
.variant-b .b-trail-item[data-step-status='completed'] .b-trail-marker { color: #52646b; border-color: #c8d2d6; background: #edf1f2; }
.variant-b .b-trail-item[data-step-status='running'] .b-trail-marker { color: #276584; border-color: #8faebb; background: #e8f1f5; }
.variant-b .b-trail-item[data-step-status='failed'] .b-trail-marker { color: #a33d3e; border-color: #deb7b8; background: #f8eeee; }
.variant-b .b-trail-dot { width: 4px; height: 4px; border-radius: 50%; background: currentColor; }
.variant-b .b-trail-label { display: block; margin-top: 7px; color: #66666b; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.variant-b .b-trail-item[data-step-status='running'] .b-trail-label { color: #276584; font-weight: 600; }
.variant-b .b-trail-footer { display: flex; align-items: center; flex-wrap: wrap; column-gap: 14px; row-gap: 2px; margin-top: 9px; }
.variant-b .b-timing { color: #66666b; font-size: 12px; font-variant-numeric: tabular-nums; }
.variant-b .b-record-toggle { display: inline-flex; align-items: center; gap: 5px; min-height: 36px; padding: 5px 0; border: 0; color: #55555c; background: transparent; font: inherit; font-size: 12px; cursor: pointer; text-underline-offset: 3px; }
.variant-b .b-record-toggle:hover { color: #29292d; text-decoration: underline; }
.variant-b .b-record-toggle:focus-visible, .variant-b .b-recovery:focus-visible { outline: 2px solid #276584; outline-offset: 4px; border-radius: 4px; }
.variant-b .b-record-toggle svg { flex: 0 0 auto; }
.variant-b .b-records { list-style: none; padding: 5px 0 0; margin: 0; border-top: 1px solid #e8e8e7; }
.variant-b .b-record-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 16px; padding: 12px 0; }
.variant-b .b-record-row + .b-record-row { border-top: 1px solid #ededec; }
.variant-b .b-record-label { margin: 0; font-size: 14px; line-height: 1.6; font-weight: 500; }
.variant-b .b-record-detail { margin: 3px 0 0; color: #66666b; font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; }
.variant-b .b-record-state { padding-top: 2px; color: #66666b; font-size: 12px; line-height: 1.6; white-space: nowrap; }
.variant-b .b-record-row[data-step-status='failed'] .b-record-state { color: #a33d3e; }
.variant-b .b-recovery { display: inline-flex; align-items: center; gap: 6px; min-height: 40px; margin-top: 12px; padding: 5px 0; color: #a52f34; background: transparent; border: 0; font: inherit; font-size: 14px; font-weight: 500; cursor: pointer; }
.variant-b .b-recovery:hover { text-decoration: underline; text-underline-offset: 4px; }
.variant-b .b-assistant[data-phase='failed'] .b-action-symbol { color: #a33d3e; background: #f8eeee; }
.variant-b .b-assistant[data-phase='stopped'] .b-action-symbol { color: #66666b; background: #ededec; }
.variant-b .b-assistant[data-phase='completed'] .b-action-symbol { color: #3d665b; background: #eaf1ee; }
.variant-b .b-assistant[data-phase='thinking'] .b-mascot,
.variant-b .b-assistant[data-phase='working'] .b-mascot,
.variant-b .b-assistant[data-phase='checking'] .b-mascot { animation: b-companion-breathe 3.6s ease-in-out infinite; }
.variant-b .b-assistant .assistant-result { margin-top: 20px; }
.variant-b .b-assistant .result-card { margin-top: 18px; }
.variant-b .b-assistant ::selection { color: #183f52; background: #dcecf3; }
@keyframes b-companion-breathe { 0%, 100% { transform: translateY(0) rotate(0); } 50% { transform: translateY(-2px) rotate(-1deg); } }
body[data-motion='paused'] .variant-b .b-assistant *,
body[data-motion='paused'] .variant-b .b-assistant *::before,
body[data-motion='paused'] .variant-b .b-assistant *::after { animation-play-state: paused !important; }
@media (prefers-reduced-motion: reduce) {
  .variant-b .b-assistant .b-mascot { animation: none; transform: none; }
}
@media (max-width: 620px) {
  .variant-b .b-companion { grid-template-columns: 52px minmax(0, 1fr); gap: 10px; }
  .variant-b .b-mascot-stage { width: 52px; height: 62px; }
  .variant-b .b-mascot { width: 50px; height: 50px; }
  .variant-b .b-action-symbol { width: 22px; height: 22px; right: -2px; bottom: 5px; }
  .variant-b .b-sentence { font-size: 16px; }
  .variant-b .b-trajectory { margin-top: 18px; }
  .variant-b .b-trail { flex-wrap: wrap; gap: 14px 0; }
  .variant-b .b-trail-item { flex-basis: 50%; }
  .variant-b .b-trail-item:nth-child(2n)::before { display: none; }
  .variant-b .b-record-row { column-gap: 10px; }
}
`;

const phases = {
  thinking: { label: '梳理中', icon: 'search', sentence: '我先梳理一下这次分析。' },
  working: { label: '处理中', icon: 'file', sentence: '我正在核对费用明细。' },
  waiting: { label: '等待确认', icon: 'chat', sentence: '有个口径需要你确认。' },
  checking: { label: '复核中', icon: 'search', sentence: '我再核对一次结果。' },
  responding: { label: '整理中', icon: 'file', sentence: '我正在整理分析结果。' },
  completed: { label: '已完成', icon: 'check', sentence: '已经整理好了。' },
  failed: { label: '处理失败', icon: 'alert', sentence: '这一步未能完成。' },
  stopped: { label: '已停止', icon: 'pause', sentence: '已停止处理。' },
};

function stepState(step, phase) {
  const status = ['pending', 'running', 'completed', 'failed'].includes(step.status) ? step.status : 'pending';
  if (status === 'running' && phase === 'stopped') return { status: 'pending', label: '已中断', icon: 'pause' };
  if (status === 'running' && phase === 'failed') return { status: 'failed', label: '未完成', icon: 'alert' };
  if (status === 'running' && phase === 'waiting') return { status, label: '等待确认', icon: 'chat' };
  return {
    status,
    label: { pending: '待处理', running: '进行中', completed: '已完成', failed: '未完成' }[status],
    icon: status === 'completed' ? 'check' : status === 'failed' ? 'alert' : '',
  };
}

export function renderAssistant(view, ui) {
  const phase = Object.hasOwn(phases, view.phase) ? view.phase : 'thinking';
  const current = phases[phase];
  const steps = Array.isArray(view.steps) ? view.steps : [];
  const completed = steps.filter(step => step.status === 'completed').length;
  const actionTitle = String(view.title || '').replace(/[。.!！]+$/, '');
  const sentence = phase === 'working' && actionTitle
    ? `${actionTitle.startsWith('正在') ? '我' : '我正在'}${actionTitle}。`
    : current.sentence;
  const elapsed = Math.max(0, Math.floor(Number(view.elapsed) || 0));
  const timing = `${['completed', 'failed', 'stopped'].includes(phase) ? '本次用时' : '已用时'} <span data-elapsed>${elapsed} 秒</span>`;
  const detail = phase === 'failed'
    ? '制度核对未完成，已完成的步骤已保留。'
    : phase === 'stopped'
      ? '当前草稿和已完成的核对已保留。'
      : view.detail;
  const trajectory = steps.length ? `
    <div class="b-trajectory">
      <ol class="b-trail" aria-label="任务轨迹">
        ${steps.map(step => {
          const state = stepState(step, phase);
          return `<li class="b-trail-item" data-step-status="${state.status}">
            <span class="b-trail-marker" aria-hidden="true">${state.icon ? ui.icon(state.icon, 11) : '<span class="b-trail-dot"></span>'}</span>
            <span class="b-trail-label" aria-label="${ui.escape(`${step.label}，${state.label}`)}">${ui.escape(step.label)}</span>
          </li>`;
        }).join('')}
      </ol>
      <div class="b-trail-footer">
        <span class="b-timing">${ui.escape(`${completed} / ${steps.length} 项已完成`)} · ${timing}</span>
        <button type="button" class="b-record-toggle" data-action="records" aria-expanded="${Boolean(view.recordOpen)}" aria-controls="b-working-record">
          ${view.recordOpen ? '收起工作记录' : '查看工作记录'}${ui.icon(view.recordOpen ? 'up' : 'down', 13)}
        </button>
      </div>
      <ol class="b-records" id="b-working-record" aria-label="工作记录"${view.recordOpen ? '' : ' hidden'}>
        ${steps.map(step => {
          const state = stepState(step, phase);
          return `<li class="b-record-row" data-step-status="${state.status}">
            <div><p class="b-record-label">${ui.escape(step.label)}</p>${step.detail ? `<p class="b-record-detail">${ui.escape(step.detail)}</p>` : ''}</div>
            <span class="b-record-state">${state.label}</span>
          </li>`;
        }).join('')}
      </ol>
    </div>` : `<p class="b-timing">${timing}</p>`;

  const recovery = phase === 'failed'
    ? `<button type="button" class="b-recovery" data-action="retry">${ui.icon('refresh', 15)}重新尝试</button>`
    : phase === 'stopped'
      ? `<button type="button" class="b-recovery" data-action="resume">${ui.icon('play', 15)}继续处理</button>`
      : '';

  return `<section class="b-assistant" data-phase="${phase}" aria-label="财小智回复">
    <div class="b-companion">
      <div class="b-mascot-stage" aria-hidden="true">${ui.mascot('b-mascot')}<span class="b-action-symbol">${ui.icon(current.icon, 13)}</span></div>
      <div class="b-dialogue">
        <div class="b-identity"><span class="b-name">财小智</span><span class="b-status">${current.label}</span></div>
        <p class="b-sentence">${ui.escape(sentence)}</p>
        ${detail ? `<p class="b-detail">${ui.escape(detail)}</p>` : ''}
        ${ui.questionNotice(view)}
        ${recovery}
        ${trajectory}
        ${ui.result(view)}
      </div>
    </div>
  </section>`;
}
