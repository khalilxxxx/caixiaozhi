import { xiaozhiIcon, xiaozhiIconCss } from './xiaozhi-icon.js';

export const css = xiaozhiIconCss + `
.variant-a .a-assistant { color: #29292d; }
.variant-a .a-assistant .assistant-identity { margin-bottom: 16px; }
.variant-a .a-assistant .assistant-avatar { width: 32px; height: 32px; }
.variant-a .a-work { margin: 0 0 22px; }
.variant-a .a-work-heading { display: flex; align-items: center; gap: 9px; min-height: 24px; }
.variant-a .a-work-heading strong { font-size: 14px; font-weight: 600; line-height: 1.6; }
.variant-a .a-state-icon { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 24px; height: 26px; color: #66666b; }
.variant-a .a-state-icon .xz-icon { width: 21px; height: 21px; }
.variant-a .a-phase-symbol { display: inline-flex; width: 17px; align-items: center; justify-content: center; color: #607a8c; }
.variant-a .a-assistant[data-phase='failed'] .a-phase-symbol { color: #ab3639; }
.variant-a .a-assistant[data-phase='waiting'] .a-phase-symbol { color: #89612e; }
.variant-a .a-assistant[data-phase='completed'] .a-phase-symbol { color: #557363; }
.variant-a .a-work-meta { margin-left: auto; color: #66666b; font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.variant-a .a-work-detail { margin: 4px 0 0 33px; color: #66666b; font-size: 14px; line-height: 1.7; overflow-wrap: anywhere; }
.variant-a .a-plan { display: grid; gap: 0; margin: 14px 0 0 33px; padding: 0; list-style: none; }
.variant-a .a-plan-row { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; align-items: start; gap: 10px; padding: 9px 0; border-bottom: 1px solid #ecece9; }
.variant-a .a-plan-row:last-child { border-bottom: 0; }
.variant-a .a-step-mark { display: flex; align-items: center; justify-content: center; width: 18px; height: 22px; color: #77777b; }
.variant-a .a-step-content { min-width: 0; }
.variant-a .a-step-content strong { display: block; font-size: 14px; font-weight: 400; line-height: 1.6; overflow-wrap: anywhere; }
.variant-a .a-step-content p { margin: 3px 0 0; color: #66666b; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.variant-a .a-step-state { padding-top: 2px; color: #66666b; font-size: 12px; line-height: 1.6; white-space: nowrap; }
.variant-a .a-plan-row[data-status='running'] .a-step-content strong { font-weight: 600; }
.variant-a .a-plan-row[data-status='running'] .a-step-mark { color: #376f99; }
.variant-a .a-plan-row[data-status='completed'] .a-step-content strong { color: #66666b; font-size: 13px; }
.variant-a .a-plan-row[data-status='completed'] .a-step-mark { color: #557363; }
.variant-a .a-plan-row[data-status='pending'] .a-step-content strong { color: #66666b; }
.variant-a .a-plan-row[data-status='failed'] .a-step-mark,
.variant-a .a-plan-row[data-status='failed'] .a-step-state { color: #ab3639; }
.variant-a .a-assistant[data-phase='waiting'] .a-state-icon { color: #89612e; }
.variant-a .a-assistant[data-phase='failed'] .a-state-icon { color: #ab3639; }
.variant-a .a-assistant[data-phase='completed'] .a-state-icon { color: #557363; }
.variant-a .a-record-toggle { display: inline-flex; align-items: center; gap: 7px; margin: 8px 0 0 26px; padding: 5px 0; border: 0; background: transparent; color: #66666b; font-size: 12px; cursor: pointer; }
.variant-a .a-record-toggle:hover { color: #29292d; }
.variant-a .a-record-toggle svg { transition: transform 160ms cubic-bezier(.16, 1, .3, 1); }
.variant-a .a-record-toggle[aria-expanded='true'] svg { transform: rotate(180deg); }
.variant-a .a-recovery { display: inline-flex; align-items: center; gap: 6px; margin: 12px 0 0 26px; padding: 7px 11px; border: 1px solid #d9d9d5; border-radius: 7px; background: #fff; color: #29292d; font-size: 13px; cursor: pointer; }
.variant-a .a-recovery:hover { background: #f1f1ee; }
.variant-a .a-record-toggle:focus-visible,
.variant-a .a-recovery:focus-visible { outline: 2px solid #8c8782; outline-offset: 4px; }
.variant-a .a-assistant .assistant-result { margin-top: 20px; }
.variant-a .a-assistant[data-phase='completed'] .a-work { margin-bottom: 12px; }
@media (prefers-reduced-motion: reduce) {
  .variant-a .a-record-toggle svg { transition: none; }
}
@media (max-width: 620px) {
  .variant-a .a-work-heading { flex-wrap: wrap; }
  .variant-a .a-work-meta { margin-left: 33px; width: 100%; }
  .variant-a .a-plan { margin-left: 0; }
}
`;

export function renderAssistant(view, ui) {
  const { icon, escape } = ui;
  const live = ['thinking', 'working', 'checking', 'responding'].includes(view.phase);
  const done = view.phase === 'completed';
  const interrupted = ['failed', 'stopped'].includes(view.phase);
  const steps = Array.isArray(view.steps) ? view.steps : [];
  const concurrent = steps.filter(step => step.status === 'running').length;
  const stateIcon = xiaozhiIcon(view.phase, '', true);
  const terminalSymbol = live ? '' : `<span class="a-phase-symbol" aria-hidden="true">${icon(done ? 'check' : view.phase === 'failed' ? 'alert' : view.phase === 'waiting' ? 'chat' : 'pause', 15)}</span>`;
  const meta = live
    ? `${concurrent > 1 ? `${concurrent} 项同步进行 · ` : '已用 '}<span data-elapsed>${Math.max(0, Math.floor(Number(view.elapsed) || 0))} 秒</span>`
    : done ? '本次处理结束' : '';
  const detail = view.phase === 'failed'
    ? '费用明细和已完成步骤已保留，重新核对制度后继续。'
    : view.phase === 'stopped'
      ? '处理记录和输入草稿已保留，可以接着当前步骤继续。'
      : view.detail;
  const renderPlan = () => `<ol class="a-plan" aria-label="办理步骤">${steps.map(step => {
    const status = ['pending', 'running', 'completed', 'failed'].includes(step.status) ? step.status : 'pending';
    const businessIcon = { read: 'file', policy: 'book', compare: 'chart', report: 'file' }[step.id] || 'arrow';
    const symbol = status === 'completed' ? 'check' : status === 'failed' ? 'alert' : status === 'running' && live ? businessIcon : 'clock';
    const label = status === 'completed' ? '已完成' : status === 'failed' ? '未完成' : status === 'running' ? live ? '处理中' : '待继续' : '待处理';
    const showDetail = status === 'running' || status === 'failed' || view.recordOpen;
    return `<li class="a-plan-row" data-status="${status}">
      <span class="a-step-mark" aria-hidden="true">${icon(symbol, 15)}</span>
      <div class="a-step-content"><strong>${escape(step.label)}</strong>${showDetail && step.detail ? `<p>${escape(step.detail)}</p>` : ''}</div>
      <span class="a-step-state">${label}</span>
    </li>`;
  }).join('')}</ol>`;
  const recovery = interrupted
    ? `<button class="a-recovery" data-action="${view.phase === 'failed' ? 'retry' : 'resume'}">${icon(view.phase === 'failed' ? 'refresh' : 'play', 14)}${view.phase === 'failed' ? '重新尝试' : '继续处理'}</button>`
    : '';
  const recordButton = done && steps.length
    ? `<button class="a-record-toggle" data-action="records" aria-expanded="${Boolean(view.recordOpen)}">${icon('down', 13)}${view.recordOpen ? '收起处理记录' : '查看处理记录'}<span>· ${steps.length} 项</span></button>`
    : '';
  return `<section class="assistant a-assistant" data-phase="${escape(view.phase)}" aria-label="财小智回复">
    <div class="assistant-identity">${xiaozhiIcon('idle', 'assistant-avatar')}<span>财小智</span></div>
    <div class="assistant-body">
      <div class="a-work">
        <div class="a-work-heading"><span class="a-state-icon" aria-hidden="true">${stateIcon}</span><strong>${escape(view.title)}</strong>${terminalSymbol}${meta ? `<span class="a-work-meta">${meta}</span>` : ''}</div>
        ${detail ? `<p class="a-work-detail">${escape(detail)}</p>` : ''}
        ${!done && steps.length ? renderPlan() : ''}
        ${recovery}
      </div>
      ${ui.questionNotice(view)}
      ${ui.result(view)}
      ${recordButton}
      ${done && view.recordOpen ? renderPlan() : ''}
    </div>
  </section>`;
}
