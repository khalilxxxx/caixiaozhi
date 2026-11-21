(function () {
  'use strict';

  const FILE_LIMIT = 512 * 1024;
  const basePath = 'cxz.workbench.tools.v1.' + encodeURIComponent(location.pathname) + '.';
  const blankDraft = () => ({ name: '', version: '1.0.0', filename: '', source: '', size: 0 });
  const drafts = new Map();
  const openUrls = new Map();
  const paths = {
    upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
    external: '<path d="M14 4h6v6m0-6-9 9m0-7H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>',
    calculator: '<rect x="5" y="2.5" width="14" height="19" rx="2.6"/><path d="M8.5 7.5h7m-7 4.5h1m4 0h1m-6 4h1m4 0h1"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    check: '<path d="m5 12 4.5 4.5L19 7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    file: '<path d="M14 2.5H6a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8.5l-6-6Z"/><path d="M14 2.5v6h6M8 13h8m-8 4h6"/>',
    box: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9h18m-10 5 2 2 3-4"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>'
  };
  function icon(name, size = 18) {
    return '<svg aria-hidden="true" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">' + paths[name] + '</svg>';
  }
  function esc(value) {
    return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function getDraft(key) {
    if (drafts.has(key)) return drafts.get(key);
    let data = blankDraft();
    try {
      const saved = JSON.parse(sessionStorage.getItem(key));
      if (saved && typeof saved.name === 'string' && typeof saved.version === 'string' && typeof saved.source === 'string') {
        data = saved;
      }
    } catch { /* The in-memory draft remains available during this visit. */ }
    drafts.set(key, data);
    return data;
  }
  function saveDraft(key, data) {
    drafts.set(key, data);
    try { sessionStorage.setItem(key, JSON.stringify(data)); } catch { /* Keep the session's in-memory copy. */ }
  }
  function listLocal(prefix) {
    const items = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const item = JSON.parse(localStorage.getItem(key));
      if (item && typeof item.name === 'string' && typeof item.version === 'string' && typeof item.source === 'string') {
        items.push({ ...item, key });
      }
    }
    return items.sort((a, b) => b.created - a.created || a.name.localeCompare(b.name));
  }
  function isolatedUrl(item) {
    const previous = openUrls.get(item.key);
    if (previous && previous.created === item.created) return previous.url;
    if (previous) URL.revokeObjectURL(previous.url);

    const policy = "default-src 'none'; script-src 'unsafe-inline' data: blob:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
    const source = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + esc(policy) + '">' + item.source;
    const wrapper = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>' + esc(item.name) + ' · 财小智</title><style>*{box-sizing:border-box}body{margin:0;height:100vh;height:100dvh;display:flex;flex-direction:column;font:14px -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#243348;background:#fff}header{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:53px;padding:10px 20px;border-bottom:1px solid #e0e5e9}strong{overflow-wrap:anywhere}small{color:#536374;white-space:nowrap}iframe{width:100%;min-height:0;flex:1;border:0}</style></head><body><header><strong>' + esc(item.name) + '</strong><small>' + esc(item.version) + ' · 个人本地</small></header><iframe title="' + esc(item.name) + '" referrerpolicy="no-referrer" sandbox="allow-scripts allow-forms" srcdoc="' + esc(source) + '"></iframe></body></html>';
    const url = URL.createObjectURL(new Blob([wrapper], { type: 'text/html;charset=utf-8' }));
    openUrls.set(item.key, { created: item.created, url });
    return url;
  }
  function fileIssue(file) {
    if (!/\.html?$/i.test(file.name)) return '请选择 .html 或 .htm 文件。';
    if (!file.size) return '文件为空，请重新选择。';
    if (file.size > FILE_LIMIT) return '文件超过 512 KB，请缩小后重新选择。';
    return '';
  }
  function sourceIssue(source) {
    if (!source.trim() || source.includes('\u0000') || !/<(?:!doctype\s+html|[a-z][\w:-]*[\s/>])/i.test(source)) return '文件中没有可识别的 HTML 内容。';
    const template = document.createElement('template');
    template.innerHTML = source;
    if (template.content.querySelector('iframe, frame, object, embed, base[href], meta[http-equiv="refresh" i]')) return '文件包含嵌入页面、页面跳转或外部基地址，请使用独立 HTML。';
    const inline = value => /^(?:#|data:|blob:|$)/i.test(value.trim());
    for (const element of template.content.querySelectorAll('[src], link[href], [poster], [srcset], image, use')) {
      for (const name of ['src', 'href', 'xlink:href', 'poster']) {
        if (element.hasAttribute(name) && !inline(element.getAttribute(name))) return '文件依赖外部资源，请将脚本、样式和图片嵌入 HTML。';
      }
      if (element.hasAttribute('srcset')) return '请将响应式图片改为单个内嵌图片后上传。';
    }
    for (const element of template.content.querySelectorAll('style, [style]')) {
      const css = element.localName === 'style' ? element.textContent : element.getAttribute('style');
      if (/@import\s/i.test(css) || [...css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)].some(match => !inline(match[2]))) {
        return '样式引用了外部资源，请将样式和资源嵌入 HTML。';
      }
    }
    return '';
  }

  window.renderTools = function renderTools(container, owner = 'personal') {
    const namespace = basePath + encodeURIComponent(String(owner));
    const prefix = namespace + '.entry.';
    const draftKey = namespace + '.draft';
    const draft = getDraft(draftKey);

    container.innerHTML = '<div class="tools-module"><header class="tools-top"><h1>轻应用</h1><button type="button" class="tools-btn tools-upload-trigger">' + icon('upload', 16) + '上传轻应用</button></header><div class="tools-status" role="status"></div><section aria-labelledby="tools-builtin-heading"><h2 class="tools-subhead" id="tools-builtin-heading">内置应用</h2><article class="tools-builtin"><span class="tools-illustration" aria-hidden="true">' + icon('calculator', 31) + '</span><div class="tools-builtin-copy"><h3>费用分摊计算器</h3><p>按部门权重分摊费用，生成精确到分的金额明细。</p></div><a class="tools-btn tools-open" href="tool.html" target="_blank" rel="noopener noreferrer">打开应用' + icon('external', 15) + '</a></article></section><section class="tools-personal" aria-labelledby="tools-personal-heading"><h2 class="tools-subhead" id="tools-personal-heading">我的应用 <span class="tools-count"></span></h2><div class="tools-entries"></div></section></div>';
    const module = container.querySelector('.tools-module');
    const trigger = module.querySelector('.tools-upload-trigger');
    const status = module.querySelector('.tools-status');
    function refresh() {
      const entries = module.querySelector('.tools-entries');
      let items;
      try {
        items = listLocal(prefix);
      } catch {
        entries.innerHTML = '<p class="tools-empty">无法读取本地应用。请检查此浏览器的本地存储权限后重新打开。</p>';
        return;
      }
      module.querySelector('.tools-count').textContent = String(items.length);
      if (!items.length) {
        entries.innerHTML = '<div class="tools-empty">' + icon('box', 23) + '<span>暂无本地应用</span></div>';
        return;
      }
      entries.innerHTML = items.map(item => '<article class="tools-entry"><span class="tools-file-icon">' + icon('file', 21) + '</span><div class="tools-entry-copy"><h3>' + esc(item.name) + '</h3><p>' + esc(item.version) + ' <span aria-hidden="true">·</span> 个人本地</p></div><a class="tools-btn tools-entry-link" target="_blank" rel="noopener noreferrer" href="' + esc(isolatedUrl(item)) + '" aria-label="打开' + esc(item.name) + '">打开' + icon('external', 14) + '</a></article>').join('');
    }
    refresh();
    trigger.addEventListener('click', () => {
      if (module.querySelector('dialog')) return;
      const dialog = document.createElement('dialog');
      dialog.className = 'tools-dialog';
      dialog.setAttribute('aria-labelledby', 'tools-dialog-title');
      module.append(dialog);
      dialog.innerHTML = '<form class="tools-upload-form" novalidate><header class="tools-dialog-head"><h2 id="tools-dialog-title">上传轻应用</h2><button class="tools-icon-btn" type="button" data-close aria-label="关闭上传轻应用">' + icon('close') + '</button></header><div class="tools-dialog-body"><div class="tools-form-row"><label>应用名称<input class="tools-input" name="toolName" maxlength="40" required placeholder="输入应用名称"></label><label>版本号<input class="tools-input" name="version" maxlength="20" required placeholder="例如 1.0.0"></label></div><div class="tools-field"><span class="tools-field-title">作用范围</span><div class="tools-scope">' + icon('lock', 15) + '个人本地</div></div><div class="tools-field"><span class="tools-field-title">应用文件</span><button class="tools-file-picker" type="button"><span class="tools-file-tile">' + icon('upload', 23) + '</span><span class="tools-picked"><strong>选择 HTML 文件</strong><small>单个自包含 HTML 文件，最大 512 KB</small></span><span class="tools-change">选择文件</span></button><input class="tools-file-input" type="file" accept=".html,.htm,text/html" tabindex="-1" aria-label="应用文件"><div class="tools-file-state" role="status"></div></div><p class="tools-form-error" role="alert"></p></div><footer class="tools-dialog-foot"><button type="button" class="tools-btn" data-close>取消</button><button type="submit" class="tools-btn tools-primary">保存到本地</button></footer></form>';
      const form = dialog.querySelector('form');
      const name = form.elements.toolName;
      const version = form.elements.version;
      const picker = form.querySelector('.tools-file-picker');
      const input = form.querySelector('input[type="file"]');
      const state = form.querySelector('.tools-file-state');
      const error = form.querySelector('.tools-form-error');
      const submit = form.querySelector('[type="submit"]');
      let sequence = 0;
      let reading = false;
      name.value = draft.name;
      version.value = draft.version;
      function fileDisplay() {
        const selected = Boolean(draft.source);
        picker.querySelector('strong').textContent = selected ? draft.filename : '选择 HTML 文件';
        picker.querySelector('small').textContent = selected ? 'HTML · ' + Math.max(1, Math.ceil(draft.size / 1024)) + ' KB' : '单个自包含 HTML 文件，最大 512 KB';
        picker.querySelector('.tools-change').textContent = selected ? '更换文件' : '选择文件';
        state.textContent = selected ? '已通过文件校验' : '';
      }
      fileDisplay();
      function updateDraft() {
        draft.name = name.value;
        draft.version = version.value;
        saveDraft(draftKey, draft);
      }
      [name, version].forEach(field => field.addEventListener('input', () => {
        field.removeAttribute('aria-invalid');
        error.textContent = '';
        updateDraft();
      }));
      function close() {
        dialog.close();
      }
      dialog.addEventListener('close', () => {
        sequence++;
        dialog.remove();
        if (trigger.isConnected) trigger.focus();
      }, { once: true });
      form.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', close));
      picker.addEventListener('click', () => input.click());
      input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        const request = ++sequence;
        input.value = '';
        reading = true;
        submit.disabled = true;
        error.textContent = '';
        Object.assign(draft, { filename: '', source: '', size: 0 });
        updateDraft();
        fileDisplay();
        state.textContent = '正在校验文件…';
        try {
          let message = fileIssue(file);
          const source = message ? '' : await file.text();
          if (request !== sequence) return;
          if (!message) message = sourceIssue(source);
          if (message) {
            state.textContent = '';
            error.textContent = message;
            return;
          }
          Object.assign(draft, { filename: file.name, source, size: file.size });
          if (!name.value.trim()) name.value = file.name.replace(/\.html?$/i, '').slice(0, 40);
          updateDraft();
          fileDisplay();
        } catch {
          if (request === sequence) {
            state.textContent = '';
            error.textContent = '无法读取此文件，请重新选择。';
          }
        } finally {
          if (request === sequence) {
            reading = false;
            submit.disabled = false;
          }
        }
      });
      function invalid(field, message) {
        error.textContent = message;
        field.setAttribute('aria-invalid', 'true');
        field.focus();
      }
      form.addEventListener('submit', event => {
        event.preventDefault();
        if (reading) return;
        const toolName = name.value.trim();
        const toolVersion = version.value.trim();
        if (!toolName) return invalid(name, '请填写应用名称。');
        if (!/^v?\d+(?:\.\d+){0,2}(?:-[a-z0-9][a-z0-9.-]*)?$/i.test(toolVersion)) return invalid(version, '请输入有效版本号，例如 1.0.0。');
        if (!draft.source) return invalid(picker, '请选择并校验应用文件。');
        const key = prefix + encodeURIComponent(toolName.normalize('NFKC').toLowerCase()) + ':' + encodeURIComponent(toolVersion.toLowerCase().replace(/^v/, ''));
        try {
          if (localStorage.getItem(key) !== null) return invalid(version, '已有同名同版本应用，请修改名称或版本号。');
          const entry = { name: toolName, version: toolVersion, source: draft.source, created: Date.now() };
          localStorage.setItem(key, JSON.stringify(entry));
        } catch {
          error.textContent = '本地保存失败。请检查浏览器存储权限或可用空间，再次保存。';
          return;
        }
        Object.assign(draft, blankDraft());
        saveDraft(draftKey, draft);
        close();
        refresh();
        status.textContent = '“' + toolName + '”已保存到我的应用。';
      });
      dialog.showModal();
      name.focus();
    });
  };

  function allocate(total, weights) {
    const weightTotal = weights.reduce((sum, weight) => sum + weight, 0n);
    const portions = weights.map(weight => total * weight / weightTotal);
    const remainders = weights.map((weight, index) => ({ index, value: total * weight % weightTotal }));
    remainders.sort((a, b) => a.value === b.value ? a.index - b.index : a.value > b.value ? -1 : 1);
    const outstanding = Number(total - portions.reduce((sum, value) => sum + value, 0n));
    for (let i = 0; i < outstanding; i++) portions[remainders[i].index]++;
    return { portions, outstanding };
  }
  function asInteger(value, scale) {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole + fraction.padEnd(scale, '0'));
  }
  function formatAmount(cents) {
    return (cents / 100n).toLocaleString('zh-CN') + '.' + (cents % 100n).toString().padStart(2, '0');
  }
  function calculator() {
    const form = document.querySelector('.tools-calc-form');
    if (!form) return;
    const rows = form.querySelector('.tools-departments');
    const amount = form.elements.total;
    const output = document.querySelector('.tools-results');
    const error = form.querySelector('.tools-form-error');
    let rowId = 0;
    let computed = false;
    function blankResults(changed = false) {
      computed = false;
      output.innerHTML = '<div class="tools-result-empty">' + icon('calculator', 26) + '<span>' + (changed ? '输入已更改，请重新计算。' : '计算后查看各部门分摊金额。') + '</span></div>';
    }
    function changed() {
      if (computed) blankResults(true);
      error.textContent = '';
      form.querySelectorAll('[aria-invalid]').forEach(node => node.removeAttribute('aria-invalid'));
    }
    function relabel() {
      [...rows.children].forEach((row, index) => {
        row.querySelector('[name="department"]').setAttribute('aria-label', '第 ' + (index + 1) + ' 行部门名称');
        row.querySelector('[name="weight"]').setAttribute('aria-label', '第 ' + (index + 1) + ' 行分摊权重');
        const remove = row.querySelector('button');
        remove.disabled = rows.children.length === 1;
        remove.setAttribute('aria-label', '移除第 ' + (index + 1) + ' 行部门');
      });
    }
    function addRow(dept = '', weight = '1') {
      const row = document.createElement('div');
      row.className = 'tools-dept-row';
      row.dataset.row = String(++rowId);
      row.innerHTML = '<input class="tools-input" name="department" type="text" maxlength="40" placeholder="部门名称"><input class="tools-input" name="weight" type="text" inputmode="decimal" maxlength="14" placeholder="权重"><button class="tools-icon-btn" type="button">' + icon('close', 15) + '</button>';
      const title = row.querySelector('[name="department"]');
      title.value = dept;
      row.querySelector('[name="weight"]').value = weight;
      rows.append(row);
      relabel();
      row.querySelector('button').addEventListener('click', () => {
        const neighbor = row.nextElementSibling || row.previousElementSibling;
        row.remove();
        relabel();
        changed();
        neighbor?.querySelector('input').focus();
      });
      return title;
    }
    addRow('市场部');
    addRow('运营部');
    blankResults();
    form.addEventListener('input', changed);
    form.querySelector('.tools-add-dept').addEventListener('click', () => {
      changed();
      addRow().focus();
    });
    function invalid(field, message) {
      error.textContent = message;
      field.setAttribute('aria-invalid', 'true');
      field.focus();
    }
    form.addEventListener('submit', event => {
      event.preventDefault();
      const raw = amount.value.trim();
      if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(raw) || asInteger(raw, 2) <= 0n) return invalid(amount, '请输入大于零的金额，整数最多 12 位，最多保留两位小数。');
      const depts = [];
      const weights = [];
      const seen = new Set();
      for (const row of rows.children) {
        const nameField = row.querySelector('[name="department"]');
        const weightField = row.querySelector('[name="weight"]');
        const name = nameField.value.trim();
        const key = name.normalize('NFKC').toLowerCase();
        if (!name) return invalid(nameField, '请填写部门名称。');
        if (seen.has(key)) return invalid(nameField, '部门名称重复，请合并权重或修改名称。');
        const value = weightField.value.trim();
        if (!/^\d{1,9}(?:\.\d{1,4})?$/.test(value) || asInteger(value, 4) <= 0n) return invalid(weightField, '请输入大于零的权重，整数最多 9 位，最多保留四位小数。');
        seen.add(key);
        depts.push(name);
        weights.push(asInteger(value, 4));
      }
      const total = asInteger(raw, 2);
      const amounts = allocate(total, weights);
      const shares = allocate(10000n, weights).portions;
      error.textContent = '';
      computed = true;
      const detail = depts.map((name, index) => '<tr><th scope="row">' + esc(name) + '</th><td>' + formatAmount(shares[index]) + '%</td><td>' + formatAmount(amounts.portions[index]) + '</td></tr>').join('');
      output.innerHTML = '<div class="tools-summary"><span>分摊合计</span><strong><small>¥</small> ' + formatAmount(total) + '</strong></div><div class="tools-table-wrap"><table class="tools-result-table"><thead><tr><th scope="col">部门</th><th scope="col">权重占比</th><th scope="col">分摊金额（元）</th></tr></thead><tbody>' + detail + '</tbody></table></div>' + (amounts.outstanding ? '<p class="tools-rounding">余分按小数余数从大到小分配，余数相同时按部门顺序分配。</p>' : '');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', calculator);
  else calculator();
})();
