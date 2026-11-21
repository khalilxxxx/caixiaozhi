export const css = `
.variant-c .assistant-identity{margin-bottom:12px;gap:8px}
.variant-c .assistant-avatar{width:25px;height:25px}
.variant-c .c-status{display:flex;gap:10px;align-items:center;min-height:29px;font-size:13px;color:#66666b}
.variant-c .c-status .c-time{font-size:11px;color:#68686e;font-variant-numeric:tabular-nums;margin-left:2px}
.variant-c .c-progress{margin:2px 0 14px}
.variant-c .records{margin:6px 0 18px}
.variant-c .step-list{padding-left:3px;margin-left:2px;border-left:1px solid #deded8}
.variant-c .step-row{padding:7px 0 7px 12px}
.variant-c .step-copy small{display:none}
.variant-c .c-done-record{display:flex;align-items:center;gap:18px;margin-top:17px}
.variant-c .c-done-record .records{margin:0;flex:1}
.variant-c .question-notice{margin-top:15px}
.variant-c .assistant-result{margin-top:14px}
.variant-c .c-stopped{font-size:13px;color:#6b6b71;margin:4px 0}
`;

export function renderAssistant(view, ui) {
  const active = !['completed','waiting','failed','stopped'].includes(view.phase);
  const identity = `<div class="assistant-identity">${ui.mascot('assistant-avatar')}<span>财小智</span></div>`;
  const status = view.phase === 'completed' ? '' : `<div class="c-status">${active ? '<span class="phase-indicator"></span>' : ui.icon(view.phase === 'failed' ? 'alert' : view.phase === 'stopped' ? 'stop' : 'chat',15)}<span>${ui.escape(view.title)}</span>${active ? `<span class="c-time" data-elapsed>${view.elapsed} 秒</span>` : ''}</div>`;
  const recovery = view.phase === 'failed' ? `<p class="failure-line">制度来源暂时无法读取，费用明细已保留。</p><button class="text-action" data-action="retry">${ui.icon('refresh',13)}重新核对</button>` : view.phase === 'stopped' ? `<p class="c-stopped">已保留处理记录和输入草稿。</p><button class="text-action" data-action="resume">${ui.icon('play',13)}继续处理</button>` : '';
  return `<article class="assistant-body">${identity}<div class="c-progress">${status}${recovery}${view.phase !== 'completed' ? ui.records(view) : ''}${ui.questionNotice(view)}</div>${ui.result(view)}${view.phase === 'completed' ? `<div class="c-done-record">${ui.records(view)}</div>` : ''}</article>`;
}
