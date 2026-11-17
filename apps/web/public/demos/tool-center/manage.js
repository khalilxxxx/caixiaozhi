const MAX_FILE_SIZE = 200 * 1024;
const UPLOAD_DRAFT_PREFIX = 'caixiaozhi-tool-upload-draft-v1:';
function uploadDraftStorageKey(key) { return UPLOAD_DRAFT_PREFIX + encodeURIComponent(key); }
export function readUploadDraft(key, storage = sessionStorage) {
  const raw = storage.getItem(uploadDraftStorageKey(key));
  if (raw === null) return null;
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('上传草稿无法读取，已保留原始数据，请刷新后重试。'); }
  if (!data || Array.isArray(data) || typeof data !== 'object' || Object.values(data).some(value => typeof value !== 'string' && typeof value !== 'boolean')) throw new Error('上传草稿格式异常，已保留原始数据，请刷新后重试。');
  return data;
}
export function writeUploadDraft(key, draft, storage = sessionStorage) {
  storage.setItem(uploadDraftStorageKey(key), JSON.stringify(draft));
}
export function removeUploadDraft(key, storage = sessionStorage) {
  storage.removeItem(uploadDraftStorageKey(key));
}
export function clearManageDrafts(storage = sessionStorage) {
  const keys = Array.from({length:storage.length}, (_,index) => storage.key(index)).filter(key => key?.startsWith(UPLOAD_DRAFT_PREFIX));
  keys.forEach(key => storage.removeItem(key));
}
const PEOPLE = [
  { id: 'finance', name: '林晓', department: '财务共享中心' },
  { id: 'employee', name: '王晨', department: '业务运营部' },
  { id: 'business', name: '周敏', department: '财务共享中心' },
  { id: 'technical', name: '陈屿', department: '信息技术中心' },
  { id: 'admin', name: '许宁', department: '平台运营' },
];
const REVIEW_CHECKS = {
  business: ['输入字段、适用范围与实际业务一致', '样例结果、异常情况与计算口径已核对', '输出内容与使用限制已确认'],
  technical: ['代码内容与依赖来源已人工核对', '网络访问、文件处理与权限范围已核对', '隔离预览及异常输入已检查'],
};
const REVIEW_NAMES = { business: '业务审核', technical: '技术审核' };
const STATUS_NAMES = { draft: '草稿', review: '审核中', rejected: '已驳回', published: '已发布', disabled: '已停用' };

export const SAMPLE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>金额分摊</title><style>body{font:14px/1.6 system-ui,sans-serif;color:#263752;padding:24px;max-width:600px;margin:auto}h1{font-size:22px}label{display:block;margin:16px 0 6px}input,button{font:inherit;padding:10px;border:1px solid #d5deeb;border-radius:7px}input{width:calc(100% - 22px)}button{margin-top:20px;background:#2965db;color:white;cursor:pointer}#result{margin-top:18px;white-space:pre-line}small{color:#5c6f87}</style></head><body><h1>金额分摊</h1><label for="amount">分摊金额（元）</label><input id="amount" inputmode="decimal" value="100.00"><label for="count">分摊份数</label><input id="count" type="number" min="1" max="10000" value="3"><button id="calculate">计算</button><div id="result" role="status"></div><script>document.getElementById('calculate').onclick=function(){const raw=document.getElementById('amount').value.trim();const n=Number(document.getElementById('count').value);const out=document.getElementById('result');if(!/^\\d+(\\.\\d{1,2})?$/.test(raw)||!Number.isInteger(n)||n<1||n>10000){out.textContent='请输入非负金额和 1 至 10000 的整数份数。';return;}const p=raw.split('.');const cents=Number(p[0])*100+Number((p[1]||'').padEnd(2,'0'));if(!Number.isSafeInteger(cents)||cents>100000000000){out.textContent='金额超出支持范围。';return;}const each=Math.floor(cents/n);const remainder=cents-each*n;out.textContent='每份基础金额：'+(each/100).toFixed(2)+' 元\\n前 '+remainder+' 份各增加 0.01 元\\n合计：'+(cents/100).toFixed(2)+' 元';};<\/script></body></html>`;

function currentRevision(app) { return app.pendingRevision || app; }
function isOwner(app, user) { return app.ownerId ? app.ownerId === user.id : app.owner === user.name; }
function canEdit(app, user) { return user.role === 'admin' || isOwner(app, user); }
function approved(revision) { return revision.reviews?.business === 'approved' && revision.reviews?.technical === 'approved'; }
function rejected(revision) { return revision.status === 'rejected' || Object.values(revision.reviews || {}).includes('rejected'); }
function statusName(app) { return app.status === 'review' && approved(app) ? '待发布' : (STATUS_NAMES[app.status] || '草稿'); }
function statusBadge(app, esc) { return `<span class="badge mg-state mg-state-${esc(app.status)}">${esc(statusName(app))}</span>`; }
function reviewLabel(value) { return ({ pending: '待审核', approved: '已通过', rejected: '已驳回' })[value] || '待审核'; }
function displayDate(value) { return value ? new Date(value).toLocaleDateString('zh-CN') : '—'; }
function cleanVersion(value) { return String(value || '').trim().replace(/^v/i, ''); }
function versionParts(value) { return cleanVersion(value).split('.').map(Number); }
function compareVersions(a, b) { const x = versionParts(a), y = versionParts(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; }
function nextVersion(value) { const p = versionParts(value); return `${p[0] || 1}.${p[1] || 0}.${(p[2] || 0) + 1}`; }
function scopeName(scope) { return ({ all: '全体成员', finance: '财务共享中心', selected: '指定成员' })[scope] || '财务共享中心'; }
function scopePeople(scope, ids = []) { return PEOPLE.filter(person => scope === 'all' || (scope === 'finance' && person.department === '财务共享中心') || (scope === 'selected' && ids.includes(person.id))); }
function sameIds(a = [], b = []) { return [...new Set(a)].sort().join('|') === [...new Set(b)].sort().join('|'); }
function normalizedScope(scope, ids = []) {
  return { scope, ids: scope === 'selected' ? [...new Set(ids)] : [] };
}

export function sharingFormState(app) {
  const view = normalizedScope(app.visibility || 'finance', app.userIds || []);
  const use = normalizedScope(app.useScope || app.visibility || 'finance', app.useUserIds || app.userIds || []);
  const useMode = view.scope === use.scope && sameIds(view.ids, use.ids) ? 'inherit' : use.scope;
  return { visibility: view.scope, viewIds: view.ids, useMode, useIds: use.ids };
}

export function permissionTransition(input, selection, actor) {
  if (!canEdit(input, actor)) throw new Error('当前身份没有权限修改授权。');
  const { visibility, useMode } = selection;
  if (!['all','finance','selected'].includes(visibility) || !['inherit','all','finance','selected'].includes(useMode)) throw new Error('授权范围无效。');
  const viewIds = visibility === 'selected' ? [...new Set(selection.viewIds || [])] : [];
  const useScope = useMode === 'inherit' ? visibility : useMode;
  const useUserIds = useScope === 'selected' ? (useMode === 'inherit' ? viewIds : [...new Set(selection.useIds || [])]) : [];
  if (visibility === 'selected' && !viewIds.length) throw new Error('请至少选择一位可查看成员。');
  if (useScope === 'selected' && !useUserIds.length) throw new Error('请至少选择一位可使用成员。');
  if ([...viewIds, ...useUserIds].some(id => !PEOPLE.some(person => person.id === id))) throw new Error('成员不存在，请重新选择。');
  const visibleIds = scopePeople(visibility, viewIds).map(person => person.id);
  if (scopePeople(useScope, useUserIds).some(person => !visibleIds.includes(person.id))) throw new Error('可使用成员必须包含在可查看范围内，请调整授权。');
  return { ...clone(input), visibility, userIds: viewIds, useScope, useUserIds };
}
function findApp(ctx, id) { return ctx.getApps().find(app => app.id === id); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function saveApp(ctx, app) { const state = ctx.getState(); const i = state.apps.findIndex(item => item.id === app.id); if (i === -1) state.apps.unshift(app); else state.apps[i] = app; return ctx.saveState(state); }
function record(ctx, app, title, detail = '') { ctx.addActivity({ appId: app.id, title, detail }); }
function errorBox(root, message) { const node = root.querySelector('[data-mg-error]'); if (node) { node.hidden = !message; node.textContent = message; if (message) node.focus(); } }
function download(content, name, type = 'text/html;charset=utf-8') { const url = URL.createObjectURL(new Blob([content], { type })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

export function reviewTransition(input, track, verdict, note, actor) {
  const app = clone(input), revision = currentRevision(app);
  if (!['business', 'technical'].includes(track) || actor.role !== track) throw new Error('当前身份没有此项审核权限。');
  if (isOwner(app, actor)) throw new Error('提交人不能审核自己的工具。');
  if (revision.status !== 'review' || rejected(revision)) throw new Error('该版本已结束审核，请提交修订版本。');
  if ((revision.reviews?.[track] || 'pending') !== 'pending') throw new Error('本项审核已完成。');
  if (!['approved', 'rejected'].includes(verdict)) throw new Error('审核结论无效。');
  if (verdict === 'rejected' && !String(note || '').trim()) throw new Error('请填写驳回原因。');
  revision.reviews = { business: 'pending', technical: 'pending', ...revision.reviews, [track]: verdict };
  revision.reviewNotes = { ...revision.reviewNotes, [track]: String(note || '').trim() };
  revision.reviewedBy = { ...revision.reviewedBy, [track]: actor.name };
  revision.reviewedAt = { ...revision.reviewedAt, [track]: new Date().toISOString() };
  if (verdict === 'rejected') revision.status = 'rejected';
  return app;
}

export function publishTransition(input, actor) {
  if (actor.role !== 'admin') throw new Error('仅平台管理员可以发布工具。');
  const app = clone(input), revision = currentRevision(app);
  if (revision.status !== 'review' || rejected(revision) || !approved(revision)) throw new Error('业务与技术审核均通过后才能发布。');
  if (app.pendingRevision) {
    const previous = { ...app }; delete previous.pendingRevision; delete previous.history;
    const history = [{ ...previous, archivedAt: new Date().toISOString() }, ...(app.history || [])].slice(0,5);
    const currentPermissions = { visibility: app.visibility, userIds: app.userIds, useScope: app.useScope, useUserIds: app.useUserIds };
    return { ...app, ...revision, ...currentPermissions, builtIn: revision.code ? false : Boolean(revision.builtIn), id: app.id, status: 'published', pendingRevision: null, history, publishedAt: new Date().toISOString() };
  }
  return { ...app, status: 'published', publishedAt: new Date().toISOString() };
}

function previewDocument(code) {
  const parsed = new DOMParser().parseFromString(code, 'text/html');
  parsed.querySelectorAll('base').forEach(node => node.remove());
  parsed.querySelectorAll('meta[http-equiv]').forEach(node => { if (node.httpEquiv.toLowerCase() === 'refresh') node.remove(); });
  const meta = parsed.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  meta.content = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'";
  parsed.head.prepend(meta);
  return `<!doctype html>${parsed.documentElement.outerHTML}`;
}

function previewCode(ctx, app, code) {
  const esc = ctx.esc;
  ctx.openPanel(`${app.name} · 预览`, `<div class="mg-preview-meta"><span class="badge">v${esc(app.version)}</span><span class="muted">隔离预览 · 外部资源受限</span></div><iframe class="mg-preview-frame" title="${esc(app.name)}预览" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>`, root => {
    root.querySelector('iframe').srcdoc = previewDocument(code);
  }, { wide: true });
}

export function mountManage(root, view, ctx) {
  const esc = ctx.esc, user = ctx.getCurrentUser();
  const isReviews = view === 'reviews';
  if (isReviews && !['business', 'technical', 'admin'].includes(user.role)) {
    root.innerHTML = '<div class="page-heading"><h1>审核管理</h1></div><div class="empty"><h2>没有审核权限</h2><p>当前身份可在“我创建的”中查看提交进度。</p><button class="btn secondary" data-mg-mine>我创建的</button></div>';
    root.querySelector('[data-mg-mine]').onclick = () => ctx.navigate('#mine');
    return;
  }
  let filter = 'all', query = '';
  const all = ctx.getApps().filter(app => isReviews ? currentRevision(app).status !== 'draft' : canEdit(app, user));
  root.innerHTML = `<div class="page-heading"><h1>${isReviews ? '审核管理' : '我创建的'}</h1><div class="page-actions">${!isReviews && ['author', 'admin'].includes(user.role) ? `<button class="btn primary" data-mg-upload>${ctx.icon('plus')}上传工具</button>` : ''}</div></div><div class="mg-toolbar"><div class="tabs mg-filter" role="group" aria-label="状态筛选">${(isReviews ? [['all','全部'],['review','待处理'],['published','已发布'],['rejected','已驳回']] : [['all','全部'],['published','已发布'],['review','审核中'],['draft','草稿']]).map(([value,label]) => `<button class="${value === 'all' ? 'active' : ''}" data-filter="${value}">${label}</button>`).join('')}</div><label class="mg-search">${ctx.icon('search')}<input type="search" placeholder="搜索工具" aria-label="搜索工具"></label></div><div data-mg-list></div>`;
  function renderList() {
    const list = all.filter(app => {
      const revision = currentRevision(app);
      const status = isReviews || app.pendingRevision ? revision.status : app.status;
      return (filter === 'all' || status === filter) && `${app.name} ${revision.name || ''} ${app.owner}`.toLowerCase().includes(query.toLowerCase());
    });
    const target = root.querySelector('[data-mg-list]');
    if (!list.length) { target.innerHTML = `<div class="empty"><h2>${query || filter !== 'all' ? '没有符合条件的工具' : '暂无工具'}</h2><p>${query || filter !== 'all' ? '调整筛选条件后重试。' : isReviews ? '新的审核申请将在这里显示。' : '上传 HTML 文件，创建你的第一个工具。'}</p></div>`; return; }
    target.innerHTML = `<div class="table-wrap panel mg-table-panel"><table class="data-table mg-table"><thead><tr><th>工具</th><th>版本与状态</th><th>业务审核</th><th>技术审核</th><th>${isReviews ? '提交人' : '可见范围'}</th><th class="mg-align-right">操作</th></tr></thead><tbody>${list.map(app => {
      const revision = currentRevision(app), display = app.pendingRevision ? revision : app;
      return `<tr><td><button class="mg-tool-name" data-detail="${esc(app.id)}">${esc(display.name || app.name)}</button><div class="mg-subline">${esc(display.category || app.category || '财务工具')}</div></td><td><div class="mg-version"><span>v${esc(display.version)}</span>${statusBadge(display, esc)}</div>${app.pendingRevision ? `<div class="mg-subline">当前发布 v${esc(app.version)}</div>` : ''}</td><td><span class="mg-review-dot mg-${esc(revision.reviews?.business || 'pending')}"></span>${revision.status === 'draft' ? '—' : reviewLabel(revision.reviews?.business)}</td><td><span class="mg-review-dot mg-${esc(revision.reviews?.technical || 'pending')}"></span>${revision.status === 'draft' ? '—' : reviewLabel(revision.reviews?.technical)}</td><td>${esc(isReviews ? app.owner : scopeName(app.visibility))}</td><td class="mg-align-right"><div class="mg-row-actions">${rowActions(app, isReviews, user, esc)}</div></td></tr>`;
    }).join('')}</tbody></table></div><div class="mg-count">共 ${list.length} 项</div>`;
    target.querySelectorAll('[data-detail]').forEach(button => button.onclick = () => showAppDetails(button.dataset.detail, ctx));
    target.querySelectorAll('[data-review]').forEach(button => button.onclick = () => showReview(button.dataset.review, ctx));
    target.querySelectorAll('[data-edit]').forEach(button => button.onclick = () => showUpload(ctx, button.dataset.edit));
    target.querySelectorAll('[data-share]').forEach(button => button.onclick = () => showShare(button.dataset.share, ctx));
  }
  root.querySelectorAll('[data-filter]').forEach(button => button.onclick = () => {
    filter = button.dataset.filter;
    root.querySelectorAll('[data-filter]').forEach(item => item.classList.toggle('active', item === button));
    renderList();
  });
  root.querySelector('input[type="search"]').oninput = event => { query = event.target.value.trim(); renderList(); };
  root.querySelector('[data-mg-upload]')?.addEventListener('click', () => showUpload(ctx));
  renderList();
}

function rowActions(app, isReviews, user, esc) {
  const revision = currentRevision(app);
  if (isReviews) return `<button class="btn ghost" data-review="${esc(app.id)}">${revision.status === 'review' ? approved(revision) ? '发布审核' : '审核' : '查看记录'}</button>`;
  if (['draft', 'rejected'].includes(revision.status)) return `<button class="btn ghost" data-edit="${esc(app.id)}">${revision.status === 'draft' ? '继续编辑' : '提交修订'}</button>`;
  if (app.status === 'published') return `<button class="btn ghost" data-share="${esc(app.id)}">分享</button><button class="btn ghost" data-detail="${esc(app.id)}">管理</button>`;
  return `<button class="btn ghost" data-detail="${esc(app.id)}">查看</button>`;
}

export function showUpload(ctx, editId = null) {
  const user = ctx.getCurrentUser(), existing = editId ? findApp(ctx, editId) : null;
  if (!['author', 'admin'].includes(user.role) || (existing && !canEdit(existing, user))) { ctx.toast('当前身份不能上传或修改工具。'); return; }
  const prior = existing ? currentRevision(existing) : null;
  if (prior?.status === 'review') { ctx.toast('该版本正在审核，请等待审核结果。'); return; }
  const isRevision = existing && prior.status !== 'draft';
  const draftKey = `${user.id}:${editId || 'new'}:${prior?.version || ''}:${prior?.status || ''}`;
  let cached;
  try { cached = readUploadDraft(draftKey); } catch(error) { ctx.toast(error.message || '上传草稿无法读取，已保留原始数据，请刷新后重试。'); return; }
  const base = { ...(prior || {}), ...(cached || {}) };
  let code = base.code || '', filename = base.filename || '', sample = Boolean(base.sample), loadingFile = false;
  const esc = ctx.esc;
  const proposedVersion = cached?.version || (isRevision ? nextVersion(base.version) : (base.version || '1.0.0'));
  ctx.openPanel(existing ? isRevision ? '提交修订版本' : '编辑工具' : '上传工具', `<form class="mg-form" novalidate><div data-mg-error class="notice mg-error" role="alert" tabindex="-1" hidden></div>${isRevision ? `<div class="notice">${existing.status === 'published' ? `当前发布版本 v${esc(existing.version)} 将继续可用，修订版审核通过后发布。` : `v${esc(base.version)} 已结束审核，请提交新版本。`}</div>` : ''}<div class="mg-filebox"><div class="mg-fileicon">${ctx.icon('upload')}</div><div><strong data-mg-filename>${esc(filename || '选择工具文件')}</strong><div class="mg-subline">HTML 文件，最大 200 KB</div></div><label class="btn secondary mg-file-button">选择文件<input type="file" accept=".html,.htm,text/html" data-mg-file aria-label="选择HTML文件"></label></div><div class="form-grid mg-two"><label class="field mg-span-2">工具名称<input name="name" maxlength="40" required value="${esc(base.name || '')}"></label><label class="field">版本<input name="version" required maxlength="30" value="${esc(proposedVersion)}" placeholder="1.0.0"></label><label class="field">分类<select name="category">${['数据核对','表格处理','分析报告','办公效率'].map(value => `<option ${value === base.category ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label class="field mg-span-2">用途<textarea name="description" required maxlength="160" rows="3" placeholder="说明处理哪些数据、输出什么结果">${esc(base.description || '')}</textarea></label><label class="field">维护人<input name="maintainer" required maxlength="30" value="${esc(base.maintainer || user.name)}"></label><label class="field">可见范围<select name="visibility"><option value="finance" ${!['all','selected'].includes(base.visibility) ? 'selected' : ''}>财务共享中心</option><option value="all" ${base.visibility === 'all' ? 'selected' : ''}>全体成员</option>${base.visibility === 'selected' ? '<option value="selected" selected>沿用指定成员</option>' : ''}</select></label></div><fieldset class="mg-fieldset"><legend>运行方式</legend><label class="mg-radio"><input type="radio" checked disabled>浏览器内处理</label><p class="mg-helper">外部资源访问受限。</p></fieldset><div class="mg-form-footer"><button type="button" class="btn secondary" data-mg-save>保存草稿</button><button type="submit" class="btn primary">提交审核</button></div></form>`, panel => {
    const form = panel.querySelector('form'), fileInput = panel.querySelector('[data-mg-file]');
    const remember = () => {
      try { writeUploadDraft(draftKey, { ...Object.fromEntries(new FormData(form)), code, filename, sample }); }
      catch { errorBox(panel, '草稿暂存失败，关闭页面前请保存草稿。'); }
    };
    form.addEventListener('input', remember);
    form.addEventListener('change', remember);
    const updateFileName = () => panel.querySelector('[data-mg-filename]').textContent = filename ? `${filename}${sample ? ' · 示例文件' : ''}` : '选择工具文件';
    updateFileName();
    fileInput.onchange = async () => {
      const file = fileInput.files?.[0]; if (!file) return;
      if (!/\.(html?|HTML?)$/i.test(file.name)) { errorBox(panel, '文件格式不支持，请选择 .html 或 .htm 文件。'); fileInput.value = ''; return; }
      if (!file.size || file.size > MAX_FILE_SIZE) { errorBox(panel, file.size ? '文件超过 200 KB，请精简后重新上传。' : '文件为空，请重新选择。'); fileInput.value = ''; return; }
      loadingFile = true; errorBox(panel, '');
      try {
        const content = await file.text();
        if (!/<(?:!doctype|html|head|body|div|main|section|form|p|h[1-6])\b/i.test(content)) throw new Error('未识别到 HTML 内容，请检查文件。');
        code = content; filename = file.name; sample = false; updateFileName();
        if (!form.elements.name.value) form.elements.name.value = file.name.replace(/\.html?$/i, '').slice(0,40);
        remember();
      } catch (error) { errorBox(panel, error.message || '读取文件失败，请重新选择。'); }
      finally { loadingFile = false; }
    };
    panel.__uploadGuideAction = action => { if(action === 'download-upload-sample'){ download(SAMPLE_HTML, '金额分摊.html'); ctx.toast('示例文件已下载。'); return true; } if(action !== 'upload-sample' || loadingFile) return false; code = SAMPLE_HTML; filename = '金额分摊.html'; sample = true; updateFileName(); if (!form.elements.name.value) form.elements.name.value = '金额分摊'; if (!form.elements.description.value) form.elements.description.value = '按份数分摊金额，将尾差分配至前若干份，输出可核对的分摊结果。'; errorBox(panel, ''); remember(); return true; };
    function submit(status) {
      const liveUser = ctx.getCurrentUser();
      if (!['author', 'admin'].includes(liveUser.role) || (existing && !canEdit(existing, liveUser))) { errorBox(panel, '当前身份没有编辑权限。'); return; }
      if (loadingFile) { errorBox(panel, '文件正在读取，请稍后提交。'); return; }
      const data = Object.fromEntries(new FormData(form));
      for (const key of ['name','description','maintainer','version']) data[key] = String(data[key] || '').trim();
      data.version = cleanVersion(data.version);
      if (!code) { errorBox(panel, '请选择工具文件。'); fileInput.focus(); return; }
      if (!data.name || !data.description || !data.maintainer) { errorBox(panel, '请填写工具名称、用途和维护人。'); return; }
      if (!/^\d{1,5}\.\d{1,5}(?:\.\d{1,5})?$/.test(data.version)) { errorBox(panel, '版本格式应为 1.0 或 1.0.0。'); form.elements.version.focus(); return; }
      if (isRevision && compareVersions(data.version, prior.version) <= 0) { errorBox(panel, `修订版本必须高于 v${prior.version}。`); return; }
      if (existing && ['published','disabled'].includes(existing.status) && compareVersions(data.version, existing.version) <= 0) { errorBox(panel, `新版本必须高于当前发布版本 v${existing.version}。`); return; }
      const duplicate = ctx.getApps().some(app => [app, app.pendingRevision, ...(app.history || [])].filter(Boolean).some(item => item.name?.trim() === data.name && compareVersions(item.version, data.version) === 0 && !(existing?.id === app.id && prior?.status === 'draft' && item.version === prior.version)));
      if (duplicate) { errorBox(panel, '同名工具的该版本已存在，请使用新的版本号。'); return; }
      if (existing) {
        const live = findApp(ctx, existing.id);
        if (currentRevision(live).status === 'review' || currentRevision(live).version !== prior.version) { errorBox(panel, '工具版本已变更，请关闭后重新打开。'); return; }
      }
      const newData = { ...data, builtIn: false, kind: 'browser', icon: 'code', code, filename, sample, status, owner: existing?.owner || liveUser.name, ownerId: existing?.ownerId || liveUser.id, department: existing?.department || liveUser.department, useScope: data.visibility === base.visibility ? (base.useScope || data.visibility) : data.visibility, userIds: data.visibility === 'selected' ? (base.userIds || []) : [], useUserIds: data.visibility === base.visibility ? (base.useUserIds || []) : [], reviews: { business:'pending',technical:'pending' }, reviewNotes: {}, reviewedBy:{},reviewedAt:{}, createdAt: base.createdAt || new Date().toISOString(), submittedAt: status === 'review' ? new Date().toISOString() : null };
      let result;
      const history = [...(existing?.history || [])];
      if (prior?.status === 'rejected') { const archived = { ...prior, archivedAt: new Date().toISOString() }; delete archived.history; delete archived.pendingRevision; history.unshift(archived); }
      if (existing?.status === 'published' || existing?.status === 'disabled') result = { ...findApp(ctx, existing.id), pendingRevision: newData, history: history.slice(0,5) };
      else result = { ...(existing || {}), ...newData, id: existing?.id || `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`, history: history.slice(0,5) };
      try { if (saveApp(ctx, result) === false) return; } catch (error) { errorBox(panel, '保存失败，浏览器存储空间可能不足。'); return; }
      record(ctx, result, status === 'review' ? '提交工具审核' : '保存工具草稿', `v${data.version}`);
      removeUploadDraft(draftKey);
      ctx.closePanel(); ctx.toast(status === 'review' ? '已提交业务与技术审核。' : '草稿已保存。'); ctx.navigate('#mine'); ctx.refresh();
    }
    form.onsubmit = event => { event.preventDefault(); submit('review'); };
    panel.querySelector('[data-mg-save]').onclick = () => submit('draft');
  }, { mode: 'modal', wide: true, kind:'upload', toolId:editId });
}

function reviewSummary(revision, esc) {
  return `<div class="mg-review-grid">${['business','technical'].map(track => `<section class="mg-review-summary"><div class="mg-review-title"><strong>${REVIEW_NAMES[track]}</strong><span class="badge mg-${esc(revision.reviews?.[track] || 'pending')}">${reviewLabel(revision.reviews?.[track])}</span></div><p>${esc(revision.reviewNotes?.[track] || (revision.reviews?.[track] === 'approved' ? '审核通过。' : '尚未填写审核意见。'))}</p><span class="mg-subline">${esc(revision.reviewedBy?.[track] || '待分配')} ${displayDate(revision.reviewedAt?.[track])}</span></section>`).join('')}</div>`;
}

export function showReview(appId, ctx) {
  const app = findApp(ctx, appId); if (!app) return;
  const user = ctx.getCurrentUser(), revision = currentRevision(app), esc = ctx.esc;
  if (!['business','technical','admin'].includes(user.role)) { ctx.toast('当前身份没有审核权限。'); return; }
  const track = user.role, actionable = ['business','technical'].includes(track) && revision.status === 'review' && !rejected(revision) && (revision.reviews?.[track] || 'pending') === 'pending' && !isOwner(app,user);
  ctx.openPanel('工具审核', `<div class="mg-detail-heading"><div><h2>${esc(revision.name || app.name)}</h2><div class="mg-meta"><span>v${esc(revision.version)}</span>${statusBadge(revision,esc)}<span>${esc(app.owner)}</span></div></div></div><p class="mg-description">${esc(revision.description || app.description)}</p><dl class="mg-metadata"><div><dt>申请范围</dt><dd>${scopeName(revision.visibility || app.visibility)}</dd></div><div><dt>运行方式</dt><dd>${revision.kind === 'ai' ? '平台 AI 服务' : '浏览器内处理'}</dd></div></dl><div class="mg-inline-actions"><button class="btn secondary" data-mg-preview ${!revision.code ? 'disabled' : ''}>预览工具</button><button class="btn secondary" data-mg-source ${!revision.code ? 'disabled' : ''}>下载源文件</button></div>${reviewSummary(revision,esc)}<div data-mg-error class="notice mg-error" role="alert" tabindex="-1" hidden></div>${rejected(revision) ? '<div class="notice mg-error">该版本已驳回，审核记录已锁定。提交人需提交修订版本。</div>' : ''}${actionable ? `<form class="mg-review-form"><h3>${REVIEW_NAMES[track]}</h3><div class="mg-checklist">${REVIEW_CHECKS[track].map((text,i) => `<label><input type="checkbox" name="check${i}"><span>${text}</span></label>`).join('')}</div><label class="field">审核意见<textarea name="note" rows="3" maxlength="500" placeholder="填写处理口径、检查结果或需要修改的内容"></textarea></label><div class="mg-form-footer"><button type="button" class="btn mg-danger" data-mg-reject>驳回</button><button type="submit" class="btn primary">审核通过</button></div></form>` : ''}${user.role === 'admin' && revision.status === 'review' ? `<div class="mg-publish-footer">${!approved(revision) ? '<p class="muted">业务与技术审核均通过后可发布。</p>' : ''}<button class="btn primary" data-mg-publish ${!approved(revision) ? 'disabled' : ''}>发布 ${app.pendingRevision ? '新版本' : '工具'}</button></div>` : ''}`, panel => {
    panel.querySelector('[data-mg-preview]').onclick = () => previewCode(ctx,{ ...revision,name:revision.name || app.name },revision.code);
    panel.querySelector('[data-mg-source]').onclick = () => { download(revision.code, `${app.id}-v${revision.version}.html`); ctx.toast('源文件已下载。'); };
    const form = panel.querySelector('form');
    function decide(verdict) {
      if (verdict === 'approved' && [...form.querySelectorAll('input[type="checkbox"]')].some(input => !input.checked)) { errorBox(panel,'请完成全部检查项后通过审核。'); return; }
      try {
        const result = reviewTransition(findApp(ctx,appId),track,verdict,form.elements.note.value,ctx.getCurrentUser());
        if (saveApp(ctx,result) === false) return;
        record(ctx,result,`${REVIEW_NAMES[track]}${verdict === 'approved' ? '通过' : '驳回'}`,`v${revision.version}`);
        ctx.toast(verdict === 'approved' ? '审核意见已保存。' : '已驳回该版本。'); ctx.refresh(); showReview(appId,ctx);
      } catch (error) { errorBox(panel,error.message); }
    }
    if (form) { form.onsubmit = event => { event.preventDefault(); decide('approved'); }; panel.querySelector('[data-mg-reject]').onclick = () => decide('rejected'); }
    panel.querySelector('[data-mg-publish]')?.addEventListener('click', () => {
      try {
        const result = publishTransition(findApp(ctx,appId),ctx.getCurrentUser());
        if (saveApp(ctx,result) === false) return;
        record(ctx,result,'发布工具',`v${result.version}`); ctx.closePanel(); ctx.refresh(); ctx.toast('工具已发布，可在工具中心使用。');
      } catch (error) { errorBox(panel,error.message); }
    });
  });
}

export function showShare(appId, ctx) {
  const app = findApp(ctx,appId); if (!app) return;
  const user = ctx.getCurrentUser(), editable = canEdit(app,user), esc = ctx.esc;
  if (!['published','disabled'].includes(app.status)) { ctx.toast('工具发布后可以分享。'); return; }
  const url = new URL(ctx.getToolUrl?.(app.id) || location.href); if (!ctx.getToolUrl) url.hash = `tool/${app.id}`;
  const permissions = sharingFormState(app);
  ctx.openPanel('分享与权限', `<div class="mg-detail-heading"><div><h2>${esc(app.name)}</h2><div class="mg-meta"><span>v${esc(app.version)}</span>${statusBadge(app,esc)}</div></div></div><form class="mg-share-form"><div data-mg-error class="notice mg-error" role="alert" tabindex="-1" hidden></div><fieldset ${editable ? '' : 'disabled'}><label class="field">可查看<select name="visibility">${[['all','全体成员'],['finance','财务共享中心'],['selected','指定成员']].map(([id,label]) => `<option value="${id}" ${id === permissions.visibility ? 'selected' : ''}>${label}</option>`).join('')}</select></label><div class="mg-member-picker" data-mg-view-members ${permissions.visibility !== 'selected' ? 'hidden' : ''}>${memberOptions('view',permissions.viewIds,esc)}</div><label class="field">可使用<select name="useScope"><option value="inherit" ${permissions.useMode === 'inherit' ? 'selected' : ''}>与可查看范围相同</option><option value="selected" ${permissions.useMode === 'selected' ? 'selected' : ''}>指定成员</option><option value="finance" ${permissions.useMode === 'finance' ? 'selected' : ''}>财务共享中心</option>${permissions.useMode === 'all' ? '<option value="all" selected>全体成员</option>' : ''}</select></label><div class="mg-member-picker" data-mg-use-members ${permissions.useMode !== 'selected' ? 'hidden' : ''}>${memberOptions('use',permissions.useIds,esc)}</div></fieldset><p class="mg-helper">使用范围不能超过查看范围。分享链接不会自动授予权限。</p>${editable ? '<div class="mg-form-footer"><button type="submit" class="btn primary">保存权限</button></div>' : '<div class="notice">仅维护者与管理员可以修改权限。</div>'}</form><section class="mg-share-link"><h3>访问链接</h3><div class="mg-copy-row"><input readonly aria-label="工具访问链接" value="${esc(url.href)}"><button class="btn secondary" data-mg-copy>复制链接</button></div><p class="mg-helper">本地地址仅能在本机访问。</p></section>`, panel => {
    const form = panel.querySelector('form'), visibility = form.elements.visibility, useScope = form.elements.useScope;
    function updatePickers() { panel.querySelector('[data-mg-view-members]').hidden = visibility.value !== 'selected'; panel.querySelector('[data-mg-use-members]').hidden = useScope.value !== 'selected'; }
    visibility.onchange = updatePickers; useScope.onchange = updatePickers; updatePickers();
    form.onsubmit = event => {
      event.preventDefault();
      const latest = findApp(ctx,appId); if (!canEdit(latest,ctx.getCurrentUser())) { errorBox(panel,'当前身份没有权限修改授权。'); return; }
      const viewIds = [...panel.querySelectorAll('input[name="view"]:checked')].map(input => input.value), useIds = [...panel.querySelectorAll('input[name="use"]:checked')].map(input => input.value);
      let result;
      try { result = permissionTransition(latest, { visibility: visibility.value, viewIds, useMode: useScope.value, useIds }, ctx.getCurrentUser()); }
      catch (error) { errorBox(panel,error.message); return; }
      if (saveApp(ctx,result) === false) return;
      record(ctx,result,'更新工具权限',`${scopeName(result.visibility)}可查看`); ctx.toast('权限已保存。'); ctx.refresh(); showShare(appId,ctx);
    };
    panel.querySelector('[data-mg-copy]').onclick = async () => {
      try { await navigator.clipboard.writeText(url.href); ctx.toast('访问链接已复制。'); }
      catch { panel.querySelector('.mg-copy-row input').select(); ctx.toast('请复制已选中的访问链接。'); }
    };
  });
}

function memberOptions(name, selected = [], esc) {
  return PEOPLE.map(person => `<label><input type="checkbox" name="${name}" value="${person.id}" ${(selected || []).includes(person.id) ? 'checked' : ''}><span>${esc(person.name)}<small>${esc(person.department)}</small></span></label>`).join('');
}

export function showAppDetails(appId, ctx) {
  const app = findApp(ctx,appId); if (!app) return;
  const esc = ctx.esc, user = ctx.getCurrentUser(), editable = canEdit(app,user), revision = currentRevision(app);
  const isRevision = Boolean(app.pendingRevision);
  ctx.openPanel('工具详情', `<div class="mg-detail-heading"><div class="mg-app-icon">${ctx.icon(app.icon || 'code')}</div><div><h2>${esc(app.name)}</h2><div class="mg-meta"><span>v${esc(app.version)}</span>${statusBadge(app,esc)}</div></div></div><p class="mg-description">${esc(app.description)}</p><dl class="mg-metadata"><div><dt>维护人</dt><dd>${esc(app.maintainer || app.owner)}</dd></div><div><dt>分类</dt><dd>${esc(app.category || '财务工具')}</dd></div><div><dt>可查看</dt><dd>${scopeName(app.visibility)}</dd></div><div><dt>可使用</dt><dd>${scopeName(app.useScope || app.visibility)}</dd></div><div><dt>运行方式</dt><dd>${app.kind === 'ai' ? '平台 AI 服务' : '浏览器内处理'}</dd></div><div><dt>更新时间</dt><dd>${displayDate(app.publishedAt || app.submittedAt || app.createdAt)}</dd></div></dl><div class="mg-inline-actions">${app.status === 'published' ? `<button class="btn primary" data-mg-open ${!ctx.canUse(app) ? 'disabled' : ''}>打开工具</button><button class="btn secondary" data-mg-share>分享</button>` : ''}${app.code && (editable || ['business','technical','admin'].includes(user.role)) ? '<button class="btn secondary" data-mg-preview>预览</button>' : ''}</div>${app.status === 'published' && !ctx.canUse(app) ? '<div class="notice">当前身份没有使用权限，可向维护人申请。</div>' : ''}${isRevision ? `<section class="mg-revision"><div class="mg-review-title"><h3>修订版本 v${esc(revision.version)}</h3>${statusBadge(revision,esc)}</div>${reviewSummary(revision,esc)}</section>` : app.status !== 'draft' ? reviewSummary(app,esc) : ''}${editable ? `<section class="mg-management"><h3>版本管理</h3><div class="mg-inline-actions">${['draft','rejected'].includes(revision.status) ? `<button class="btn secondary" data-mg-edit>${revision.status === 'draft' ? '继续编辑' : '提交修订版本'}</button>` : !isRevision && ['published','disabled'].includes(app.status) ? '<button class="btn secondary" data-mg-edit>上传新版本</button>' : ''}${app.code ? '<button class="btn secondary" data-mg-download>下载源文件</button>' : ''}${user.role === 'admin' && ['published','disabled'].includes(app.status) ? `<button class="btn ${app.status === 'published' ? 'mg-danger' : 'secondary'}" data-mg-toggle>${app.status === 'published' ? '停用工具' : '恢复使用'}</button>` : ''}</div>${app.code ? '<p class="mg-helper">纯前端工具的代码会加载到浏览器，下载权限不构成源码保密措施。</p>' : ''}${app.history?.length ? `<div class="mg-history">${app.history.map(item => `<div><span>v${esc(item.version)}</span><span class="muted">${displayDate(item.archivedAt)} 已归档</span></div>`).join('')}</div>` : ''}</section>` : ''}${['business','technical','admin'].includes(user.role) && revision.status !== 'draft' ? '<div class="mg-form-footer"><button class="btn secondary" data-mg-review>查看审核</button></div>' : ''}`, panel => {
    panel.querySelector('[data-mg-open]')?.addEventListener('click', () => { const latest = findApp(ctx,appId); if (!ctx.canUse(latest)) { ctx.toast('工具状态或权限已变更。'); return; } ctx.closePanel(); ctx.navigate(`#tool/${appId}`); });
    panel.querySelector('[data-mg-share]')?.addEventListener('click', () => showShare(appId,ctx));
    panel.querySelector('[data-mg-preview]')?.addEventListener('click', () => previewCode(ctx,app,app.code));
    panel.querySelector('[data-mg-edit]')?.addEventListener('click', () => showUpload(ctx,appId));
    panel.querySelector('[data-mg-review]')?.addEventListener('click', () => showReview(appId,ctx));
    panel.querySelector('[data-mg-download]')?.addEventListener('click', () => { download(app.code,`${app.id}-v${app.version}.html`); ctx.toast('源文件已下载。'); });
    panel.querySelector('[data-mg-toggle]')?.addEventListener('click', () => {
      if (ctx.getCurrentUser().role !== 'admin') { ctx.toast('仅管理员可以变更发布状态。'); return; }
      if (app.status === 'published') {
        ctx.openPanel('停用工具', `<div class="notice">停用后，所有成员将无法运行“${esc(app.name)}”。已有导出文件不会被删除。</div><div class="mg-form-footer"><button class="btn secondary" data-mg-cancel>取消</button><button class="btn mg-danger" data-mg-confirm>确认停用</button></div>`, confirmPanel => {
          confirmPanel.querySelector('[data-mg-cancel]').onclick = () => showAppDetails(appId,ctx);
          confirmPanel.querySelector('[data-mg-confirm]').onclick = () => { if (ctx.getCurrentUser().role !== 'admin') return; const latest = findApp(ctx,appId); if (saveApp(ctx,{...latest,status:'disabled'}) === false) return; record(ctx,latest,'停用工具'); ctx.closePanel(); ctx.refresh(); ctx.toast('工具已停用。'); };
        });
      } else { const latest = findApp(ctx,appId); if (saveApp(ctx,{...latest,status:'published'}) === false) return; record(ctx,latest,'恢复工具'); ctx.closePanel(); ctx.refresh(); ctx.toast('工具已恢复使用。'); }
    });
  });
}
