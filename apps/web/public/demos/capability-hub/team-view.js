'use strict';

(() => {
  const sessions = new Map();
  const prompts = ['预审这张差旅报销单', '核对住宿是否超标', '核对附件和供应商主体'];
  const statusNames = {done: '已完成', partial: '部分完成', blocked: '未执行', clarify: '待补充'};
  const timeFormat = new Intl.DateTimeFormat('zh-CN', {hour: '2-digit', minute: '2-digit', hour12: false});
  const escapes = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};

  function safe(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => escapes[c]);
  }

  function options(records, selected, label, blank) {
    return '<option value="">' + safe(blank) + '</option>' + Object.entries(records).map(([key, item]) =>
      '<option value="' + safe(key) + '"' + (selected === key ? ' selected' : '') + '>' +
      safe(label(item)) + '</option>').join('');
  }

  function nameOf(records, key) {
    return records.find(item => item.key === key)?.name ?? key;
  }

  function sessionFor(ctx) {
    if (!sessions.has(ctx.role)) {
      sessions.set(ctx.role, {
        draft: '', billKey: ctx.bills.beijing ? 'beijing' : '', supplierKey: ctx.suppliers.studio ? 'studio' : '',
        records: [], selected: null
      });
    }
    return sessions.get(ctx.role);
  }

  window.renderTeam = function renderTeam(container, ctx) {
    const {team, skills, connectors, run, allowed} = window.teamModel;
    const {icon, bills, suppliers} = ctx;
    const state = sessionFor(ctx);
    const find = selector => container.querySelector(selector);
    const billLabel = bill => bill.city + '差旅 · ' + bill.id;
    const supplierLabel = supplier => supplier.name;
    const field = (key, label, symbol, choices) =>
      '<label class="tv-field"><span>' + icon(symbol, 15) + label + '</span><select name="' +
      key + '">' + choices + '</select></label>';

    container.innerHTML = '<div class="tv"><a class="back" href="#hub/teams">' + icon('back', 15) +
      '返回能力中心</a><div class="tv-heading"><div class="tv-identity"><span class="tv-avatar"><img src="expert.webp" alt=""></span>' +
      '<h1>' + safe(team.name) + '</h1></div><button class="secondary" type="button" data-tv-composition>' +
      icon('layers', 16) + '能力组成</button></div><div class="tv-workspace">' +
      '<form class="tv-compose"><label class="tv-title" for="tv-input">新任务</label>' +
      '<textarea name="task" id="tv-input" rows="3" placeholder="描述要核对的事项…" aria-describedby="tv-error"></textarea>' +
      '<p id="tv-error" class="tv-error" hidden role="alert"></p>' +
      '<div class="tv-prompts" aria-label="常用任务">' + prompts.map((prompt, index) =>
        '<button type="button" data-tv-prompt="' + index + '">' + safe(prompt) + '</button>').join('') +
      '</div><div class="tv-fields">' +
      field('billKey', '示例单据', 'file', options(bills, state.billKey, billLabel, '未关联单据')) +
      field('supplierKey', '示例供应商', 'building', options(suppliers, state.supplierKey, supplierLabel, '未关联供应商')) +
      '</div><div class="tv-actions"><button type="submit" class="primary">' + icon('message', 16) +
      '执行任务</button></div></form><aside class="tv-history" aria-labelledby="tv-history-title"></aside>' +
      '<section class="tv-report" aria-labelledby="tv-report-title" hidden></section></div></div>';

    const input = find('#tv-input');
    const error = find('#tv-error');
    const form = find('.tv-compose');
    const history = find('.tv-history');
    const report = find('.tv-report');
    input.value = state.draft;

    function clearError() {
      input.removeAttribute('aria-invalid');
      error.hidden = true;
      error.textContent = '';
    }

    function focusDraft() {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }

    function openPanel(trigger, title, html) {
      trigger.focus({preventScroll: true});
      ctx.showPanel(title, html);
    }

    find('[data-tv-composition]').onclick = event => {
      const list = team.skills.map(key => {
        const skill = skills.find(item => item.key === key);
        if (!skill) return '';
        return '<section class="tv-panel-row"><h4>' + safe(skill.name) + '</h4><p>' +
          safe(skill.description) + '</p><small>' +
          safe(skill.connectors.map(id => nameOf(connectors, id)).join('、')) + '</small></section>';
      }).join('');
      const sources = team.connectors.map(key => {
        const source = connectors.find(item => item.key === key);
        if (!source) return '';
        const active = allowed(key, ctx.role);
        return '<section class="tv-panel-row"><div><h4>' + safe(source.name) +
          '</h4><span class="badge ' + (active ? '' : 'hold') + '">' + (active ? '已授权' : '未授权') +
          '</span></div><p>' + safe(source.description) + '</p></section>';
      }).join('');
      openPanel(event.currentTarget, '能力组成', '<div class="tv-panel"><p>' + safe(team.description) +
        '</p><h3>已配置的技能</h3>' + list + '<h3>连接器</h3>' + sources + '</div>');
    };

    input.oninput = () => {state.draft = input.value; clearError();};
    input.onkeydown = event => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
        event.preventDefault();
        form.requestSubmit();
      }
    };
    form.elements.billKey.onchange = event => {state.billKey = event.target.value;};
    form.elements.supplierKey.onchange = event => {state.supplierKey = event.target.value;};
    form.querySelectorAll('[data-tv-prompt]').forEach(button => {
      button.onclick = () => {
        input.value = state.draft = prompts[Number(button.dataset.tvPrompt)];
        clearError();
        focusDraft();
      };
    });

    function statusBadge(status) {
      const color = status === 'done' ? '' : status === 'clarify' ? 'neutral' : 'hold';
      return '<span class="badge ' + color + '">' + safe(statusNames[status]) + '</span>';
    }

    function drawHistory() {
      const entries = [...state.records].reverse();
      const items = entries.map(record =>
        '<button type="button" data-tv-record="' + record.id + '" aria-current="' +
        (state.selected === record.id ? 'true' : 'false') + '"><span>' + safe(record.text) +
        '</span><small>' + safe(record.time) + '<i></i>' + safe(statusNames[record.result.status]) +
        '</small></button>').join('');
      const select = '<select class="tv-history-select" aria-label="切换执行记录">' + entries.map(record =>
        '<option value="' + record.id + '"' + (state.selected === record.id ? ' selected' : '') +
        '>' + safe(record.time + ' · ' + record.text) + '</option>').join('') + '</select>';
      history.innerHTML = '<h2 id="tv-history-title" class="tv-title">执行记录<span class="count">' +
        entries.length + '</span></h2>' + (items ? '<div class="tv-history-list">' +
        items + '</div>' + select : '<p class="tv-history-empty">' + icon('message', 19) + '暂无执行记录</p>');
      history.querySelectorAll('[data-tv-record]').forEach(button => {
        button.onclick = () => selectRecord(Number(button.dataset.tvRecord));
      });
      const control = history.querySelector('select');
      if (control) control.onchange = () => selectRecord(Number(control.value));
    }

    function contextLine(record) {
      const {result} = record;
      const attached = [...result.usedSkills, ...result.blocked.map(item => item.skill)];
      const receiptNeeded = attached.some(key => ['materials', 'policy'].includes(key)) ||
        result.missing.some(item => /单据|报销单|费用|发票/.test(item));
      const supplierNeeded = attached.includes('supplier') || result.missing.some(item => item.includes('供应商'));
      const pieces = [];
      if (receiptNeeded || (!receiptNeeded && !supplierNeeded)) {
        pieces.push(record.billKey ? billLabel(bills[record.billKey]) : '未关联单据');
      }
      if (supplierNeeded || (!receiptNeeded && !supplierNeeded)) {
        pieces.push(record.supplierKey ? supplierLabel(suppliers[record.supplierKey]) : '未关联供应商');
      }
      return pieces.map(safe).join('　/　');
    }

    function invocation(label, records, keys) {
      return '<div><dt>' + label + '</dt><dd>' + (keys.length ? keys.map(key =>
        '<span>' + safe(nameOf(records, key)) + '</span>').join('') : '无') + '</dd></div>';
    }

    function selectRecord(id) {
      state.selected = id;
      drawHistory();
      drawReport();
      const heading = find('#tv-report-title');
      heading.focus({preventScroll: true});
      report.scrollIntoView({block: 'start'});
    }

    function drawReport() {
      const record = state.records.find(item => item.id === state.selected);
      report.hidden = !record;
      if (!record) return;
      const result = record.result;
      const findings = result.findings.map((item, index) =>
        '<article class="tv-finding"><div><span class="tv-item-mark' + (item.issue ? ' tv-pending' : '') + '">' +
        icon(item.issue ? 'file' : 'check', 16) + '</span><h4>' + safe(item.title) + '</h4></div><p>' +
        safe(item.body) + '</p>' + (item.evidence.length ? '<button type="button" class="linkbtn" data-tv-evidence="' +
        index + '">' + icon('file', 14) + '查看依据</button>' : '') + '</article>').join('');
      const blocked = result.blocked.map(item =>
        '<article class="tv-blocked"><strong>' + icon('lock', 15) + safe(nameOf(skills, item.skill)) +
        '</strong><p>' + safe(nameOf(connectors, item.connector)) + ' · ' + safe(item.reason) + '</p></article>').join('');
      const repeatedMessage = [result.missing.join(''), result.blocked.map(item => item.reason).join('')].includes(result.message);
      const summary = repeatedMessage ? '' : '<p class="tv-summary">' + safe(result.message) + '</p>';
      const missing = result.missing.length ? '<ul class="tv-missing">' + result.missing.map(item =>
        '<li>' + safe(item) + '</li>').join('') + '</ul>' : '';
      const followup = !result.followup.length ? '' : record.hasChecklist ?
        '<section class="tv-follow"><h3 id="tv-checklist" tabindex="-1">' + icon('checklist', 17) +
        '补件与核实清单</h3><ol>' + result.followup.map(item => '<li>' + safe(item) + '</li>').join('') +
        '</ol></section>' : '<button type="button" data-tv-follow class="secondary">' +
        icon('checklist', 16) + '整理补件清单</button>';
      report.innerHTML = '<div class="tv-report-heading"><h2 id="tv-report-title" tabindex="-1" class="tv-title">执行结果</h2>' +
        statusBadge(result.status) + '</div><div class="tv-request"><strong>' + safe(record.text) +
        '</strong><small>' + contextLine(record) + '</small></div>' + summary +
        '<dl class="tv-invocations">' + invocation('实际使用的技能', skills, result.usedSkills) +
        invocation('实际使用的连接器', connectors, result.usedConnectors) + '</dl>' +
        (findings ? '<h3 class="tv-subtitle">核对事项</h3>' + findings : '') +
        (blocked ? '<h3 class="tv-subtitle">权限受限</h3>' + blocked : '') +
        (missing ? '<h3 class="tv-subtitle">待补信息</h3>' + missing : '') +
        (result.status === 'clarify' || missing ? '<button type="button" class="secondary" data-tv-edit>' +
        icon('message', 15) + '补充任务</button>' : '') + followup;
      report.querySelectorAll('[data-tv-evidence]').forEach(button => {
        button.onclick = () => {
          const item = result.findings[Number(button.dataset.tvEvidence)];
          openPanel(button, '核对依据', '<p class="panel-note">' + safe(item.title) + '</p>' +
            item.evidence.map(proof => '<section class="proof"><h3>' + safe(proof.title) +
            '</h3><small>' + safe(proof.source) + '</small><blockquote>' + safe(proof.quote) +
            '</blockquote></section>').join(''));
        };
      });
      const followButton = report.querySelector('[data-tv-follow]');
      if (followButton) followButton.onclick = () => {
        record.hasChecklist = true;
        drawReport();
        find('#tv-checklist').focus();
      };
      const edit = report.querySelector('[data-tv-edit]');
      if (edit) edit.onclick = () => {
        if (!state.draft) {
          state.draft = input.value = record.text;
          form.elements.billKey.value = state.billKey = record.billKey;
          form.elements.supplierKey.value = state.supplierKey = record.supplierKey;
        }
        focusDraft();
      };
    }

    form.onsubmit = event => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) {
        error.hidden = false;
        error.textContent = '请填写需要核对的事项。';
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      const {billKey, supplierKey} = state;
      const result = run({text, role: ctx.role, billKey, supplierKey}, ctx);
      const id = state.records.length + 1;
      state.records.push({id, text, billKey, supplierKey, result, time: timeFormat.format(Date.now()), hasChecklist: false});
      state.draft = input.value = '';
      clearError();
      selectRecord(id);
    };
    drawHistory();
    drawReport();
  };
})();
