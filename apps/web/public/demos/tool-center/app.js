import {createSeed,safeState,USERS,canDiscover as discover,canUse as use,canManage,canReviewTool,writeToolState,readToolState,TOOL_STORE} from './model.js';
import {mountTool,clearToolCache} from './tools.js';
import {mountManage,showUpload,showShare,showAppDetails,showReview,clearManageDrafts} from './manage.js';

const STORE=TOOL_STORE;
const embedded=new URLSearchParams(location.search).get('embed')==='agent'&&window.parent!==window;
if(embedded)document.body.classList.add('embedded');
let state;
try{state=safeState(JSON.parse(localStorage.getItem(STORE)));}catch{state=createSeed();}
let persistedState=structuredClone(state);
const main=document.getElementById('main'),drawer=document.getElementById('drawer'),panel=document.getElementById('drawer-content');
let leaving=false,panelKind=null;
let panelTrigger=null,lastRoute='',catalogQuery='',catalogFilter='全部',catalogTab='tools';
let chatDraft='',selectedTool='',chatMessages=[];
const esc=(value='')=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths={
 plus:'<path d="M12 5v14M5 12h14"/>',grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',folder:'<path d="M3 7V4h6l3 3h9v13H3Z"/>',shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',book:'<path d="M12 5s-4-3-9-1v15c5-2 9 1 9 1s4-3 9-1V4c-5-2-9 1-9 1ZM12 5v15"/>',external:'<path d="M14 3h7v7m0-7-11 11M10 3H3v18h18v-7"/>',back:'<path d="m11 5-7 7 7 7M4 12h16"/>',chevron:'<path d="m9 5 7 7-7 7"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',help:'<circle cx="12" cy="12" r="9"/><path d="M9 8a3 3 0 0 1 6 0c0 2-3 2-3 4m0 4h.01"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',compare:'<rect x="3" y="4" width="7" height="16" rx="1.5"/><rect x="14" y="4" width="7" height="16" rx="1.5"/><path d="M6 8h1m-1 4h1m10-4h1m-1 4h1M6 16h1m10 0h1"/>',table:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11M9 14h12"/>',chart:'<path d="M4 3v17h17M8 15v-4m5 4V7m5 8V4"/>',calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18m-13 5h2m4 0h2"/>',star:'<path d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1 6.2L12 17.3l-5.6 2.9 1-6.2L3 9.6l6.2-.9Z"/>',file:'<path d="M14 3H5v18h14V8Z"/><path d="M14 3v6h5M8 13h8M8 17h5"/>',upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/>',download:'<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>',more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',check:'<path d="m4 12 5 5L20 6"/>',lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',link:'<path d="m10 14 4-4m-5 7-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2-2 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',send:'<path d="M12 20V4m-7 7 7-7 7 7"/>',chat:'<path d="M21 11a8 8 0 0 1-8 8H4l-1 2V10a9 9 0 0 1 18 1Z"/><path d="M7 9h10M7 13h6"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',users:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v3"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',refresh:'<path d="M20 7V3l-3 3a8 8 0 1 0 3 9m0-8h-5"/>',edit:'<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14Z"/>',trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',code:'<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>'
};
function icon(name){return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name]||paths.file}</svg>`;}
function hydrateIcons(root=document){root.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));}
function user(){return USERS[state.persona]||USERS.finance;}
function saveState(next){try{writeToolState(next);state=next;persistedState=structuredClone(next);updateSidebar();hostMessage({type:'state-change'});return true;}catch{state=structuredClone(persistedState);updateSidebar();toast('保存失败：浏览器存储不可用或空间不足，请保留当前内容后重试');return false;}}
function toast(message){const item=document.createElement('div');item.className='toast';item.textContent=message;document.getElementById('toasts').append(item);setTimeout(()=>item.remove(),3800);}
function hostMessage(data){if(embedded)window.parent.postMessage({source:'caixiaozhi-tool-center',...data},location.origin);}
function openPanel(title,html,onMount,options={}){
 if(!drawer.open)panelTrigger=document.activeElement;
 document.getElementById('drawer-title').textContent=title;
 panel.__uploadGuideAction=null; panelKind=options.kind||null;
 panel.innerHTML=html;drawer.classList.toggle('wide',!!options.wide);drawer.classList.toggle('centered',options.mode==='modal');
 if(!drawer.open)drawer.showModal();panel.scrollTop=0;onMount?.(panel);
 if(!embedded)drawer.append(document.getElementById('guide-button'));
 hostMessage({type:'panel-state',kind:panelKind,toolId:options.toolId||undefined});
 return panel;
}
function closePanel(){if(drawer.open)drawer.close();}
drawer.addEventListener('close',()=>{if(drawer.open)return;panel.innerHTML='';panel.__uploadGuideAction=null;panelKind=null;if(!embedded)document.body.append(document.getElementById('guide-button'));hostMessage({type:'panel-state',kind:null});if(embedded&&['manage','review','edit','share','request','upload','requests'].includes(location.hash.slice(1).split('/')[0]))hostMessage({type:'back'});if(panelTrigger?.isConnected)panelTrigger.focus();panelTrigger=null;});
drawer.addEventListener('click',e=>{if(e.target!==drawer)return;const r=drawer.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closePanel();});
document.getElementById('drawer-close').onclick=closePanel;
function openNativeSkills(){window.parent.postMessage({source:'caixiaozhi-tool-center',type:'open-skills'},location.origin);}
function getToolUrl(id){const url=embedded?new URL('/agent.html',location.origin):new URL(location.href);url.hash=embedded?'light-apps?'+new URLSearchParams({tool:id}).toString():'tool/'+encodeURIComponent(id);return url.href;}
function setupEmbed(){
 if(!embedded)return;
 document.addEventListener('click',event=>{
   const target=event.target instanceof Element?event.target.closest('a[href]'):null;
   if(!target)return;
   const url=new URL(target.href,location.href);
   if(url.origin===location.origin&&url.pathname===location.pathname&&/^#(?:catalog|mine|reviews)$/.test(url.hash)){event.preventDefault();navigate(url.hash);}
   else if(url.pathname.includes('/demos/skills-hub/')){event.preventDefault();openNativeSkills();}
 });
 const notifyHeight=()=>hostMessage({type:'height',height:Math.ceil(main.getBoundingClientRect().height)+8});
 new ResizeObserver(notifyHeight).observe(main);
 window.addEventListener('message',event=>{
   if(event.origin!==location.origin||event.source!==window.parent||event.data?.source!=='caixiaozhi-tool-host')return;
   if(event.data.type==='viewport'&&Number.isFinite(event.data.top)&&Number.isFinite(event.data.height)){
     document.documentElement.style.setProperty('--host-visible-top',`${Math.max(0,event.data.top)}px`);
     document.documentElement.style.setProperty('--host-visible-height',`${Math.max(200,event.data.height)}px`);
   }
   if(event.data.type!=='guide-action')return;
   const [route,encodedId]=location.hash.slice(1).split('/');let id;try{id=decodeURIComponent(encodedId||'');}catch{return;}
   if(event.data.toolId&&event.data.toolId!==id)return;
   if(event.data.action==='load-sample'&&route==='tool'&&!drawer.open)main.__toolGuideAction?.('load-sample');
   if(['upload-sample','download-upload-sample'].includes(event.data.action)&&drawer.open&&panelKind==='upload')panel.__uploadGuideAction?.(event.data.action);
 });
 hostMessage({type:'ready'});notifyHeight();
}
function navigate(route){
 const value=String(route).replace(/^#/,'');
 if(embedded&&['catalog','mine','reviews'].includes(value)){leaving=true;hostMessage({type:'back'});return;}
 if(embedded)hostMessage({type:'navigate',route:value});
 if(location.hash.slice(1)===value)render();else location.hash=value;
}
function addActivity(item){state.activities.unshift({...item,id:crypto.randomUUID(),userId:user().id,time:new Date().toISOString()});state.activities=state.activities.slice(0,60);saveState(state);}
const ctx={esc,icon,toast,navigate,openPanel,closePanel,getState:()=>structuredClone(state),saveState,refresh:()=>render(),getCurrentUser:user,getApps:()=>state.apps,canUse:app=>use(app,user()),addActivity,getToolUrl};
function findApp(id){return state.apps.find(a=>a.id===id);}
function appVisible(app){return discover(app,user());}
function usable(app){return use(app,user());}
function scopeText(scope){return scope==='all'?'全体员工':scope==='finance'?'财务共享中心':'指定人员';}
function statusText(app){return ({published:'已发布',draft:'草稿',review:app.reviews?.business==='approved'&&app.reviews?.technical==='approved'?'待发布':'审核中',rejected:'已退回',disabled:'已停用'})[app.status]||'草稿';}
function relativeTime(time){const mins=Math.floor((Date.now()-new Date(time).getTime())/60000);if(!Number.isFinite(mins))return '';if(mins<1)return '刚刚';if(mins<60)return `${mins} 分钟前`;if(mins<1440)return `${Math.floor(mins/60)} 小时前`;return new Date(time).toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'});}
function updateSidebar(){document.getElementById('profile-name').textContent=user().name;document.getElementById('profile-dept').textContent=user().department;document.getElementById('profile-avatar').textContent=user().name[0];document.querySelector('.workspace-context').textContent=user().department;const pending=state.apps.filter(a=>a.status==='review'||a.pendingRevision?.status==='review').length;document.getElementById('review-count').textContent=pending||'';const recent=[...new Set(state.activities.filter(a=>a.userId===user().id).map(a=>a.appId))].slice(0,4).map(findApp).filter(a=>a&&appVisible(a));document.getElementById('recent-nav').innerHTML=recent.length?recent.map(a=>`<a class="recent-link" href="#tool/${encodeURIComponent(a.id)}">${icon(a.icon)}${esc(a.name)}</a>`).join(''):'<div class="sidebar-label">暂无使用记录</div>';}
function toggleFavorite(id){const at=state.favorites.indexOf(id);if(at<0)state.favorites.push(id);else state.favorites.splice(at,1);saveState(state);renderCatalog();}
function catalogCards(apps){return apps.map(a=>`<article class="tool-card"><div class="card-top"><div class="card-heading"><span class="tool-symbol ${a.id==='convert'?'teal':a.id==='report'?'amber':'slate'}">${icon(a.icon)}</span><h2><button class="card-title" data-detail="${esc(a.id)}">${esc(a.name)}</button></h2></div><button class="icon-button ${state.favorites.includes(a.id)?'favorited':''}" data-favorite="${esc(a.id)}" aria-label="${state.favorites.includes(a.id)?'取消收藏':'收藏'}${esc(a.name)}" aria-pressed="${state.favorites.includes(a.id)}">${icon('star')}</button></div><p>${esc(a.description)}</p><div class="card-tags"><span class="badge">${esc(a.category)}</span><span class="badge ${a.skill?'blue':'green'}">${a.skill?'关联 Skill':icon('lock')+'浏览器处理'}</span>${!usable(a)?'<span class="badge amber">需申请使用</span>':''}</div><div class="card-bottom"><span class="maintainer"><span class="mini-avatar">${esc((a.maintainer||a.owner||'林')[0])}</span>${esc(a.maintainer||a.owner)}<small>v${esc(a.version)}</small></span><div class="card-buttons"><button class="icon-button" data-share="${esc(a.id)}" aria-label="分享${esc(a.name)}">${icon('link')}</button><button class="btn ${usable(a)?'primary':'secondary'} small" data-open="${esc(a.id)}">${usable(a)?'打开工具':'申请使用'}${icon(usable(a)?'arrow':'lock')}</button></div></div></article>`).join('');}
function renderCatalog(){
 const available=state.apps.filter(a=>a.status==='published'&&appVisible(a));
 const apps=available.filter(a=>(catalogFilter==='全部'||(catalogFilter==='已收藏'?state.favorites.includes(a.id):a.category===catalogFilter))&&(`${a.name} ${a.description} ${a.maintainer||''}`).toLowerCase().includes(catalogQuery.toLowerCase()));
 const isCreator=['author','admin'].includes(user().role),requestCount=state.requests.filter(r=>r.status==='pending').length;
 main.innerHTML=`<div class="page-heading"><h1>工具中心</h1><div class="page-actions">${user().role==='admin'?`<button class="btn secondary" id="requests-button">${icon('users')}访问申请${requestCount?` (${requestCount})`:''}</button>`:''}${isCreator?`<button class="btn primary" id="upload-button">${icon('plus')}上传工具</button>`:''}</div></div><div class="tabs"><button class="${catalogTab==='tools'?'active':''}" data-tab="tools">小工具<span class="tab-count">${available.length}</span></button><button class="${catalogTab==='skills'?'active':''}" data-tab="skills">Skills</button></div>${catalogTab==='skills'?skillList():`<div class="toolbar"><div class="filters">${['全部','数据核对','表格处理','分析报告','办公效率','已收藏'].map(f=>`<button class="filter ${catalogFilter===f?'active':''}" data-filter="${f}">${f}</button>`).join('')}</div><label class="search">${icon('search')}<input id="catalog-search" placeholder="搜索工具、用途或维护人" aria-label="搜索工具" value="${esc(catalogQuery)}"></label></div><div class="catalog-grid" id="catalog-grid">${apps.length?catalogCards(apps):'<div class="empty catalog-empty"><h2>没有找到工具</h2><p>调整搜索条件或查看全部工具。</p><button class="btn" id="clear-search">清除筛选</button></div>'}</div>${catalogLower()}`}`;
 main.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{if(embedded&&b.dataset.tab==='skills'){openNativeSkills();return;}catalogTab=b.dataset.tab;renderCatalog();});
 main.querySelector('#upload-button')?.addEventListener('click',()=>showUpload(ctx));main.querySelector('#requests-button')?.addEventListener('click',showRequests);
 main.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{catalogFilter=b.dataset.filter;renderCatalog();});
 main.querySelector('#catalog-search')?.addEventListener('input',e=>{const pos=e.target.selectionStart;catalogQuery=e.target.value;renderCatalog();const field=main.querySelector('#catalog-search');field.focus();field.setSelectionRange(pos,pos);});
 main.querySelector('#clear-search')?.addEventListener('click',()=>{catalogQuery='';catalogFilter='全部';renderCatalog();});
 bindAppActions(main);
}
function skillList(){return `<div class="table-wrap"><table class="data-table"><thead><tr><th>技能</th><th>使用方式</th><th>版本</th><th>关联工具</th><th></th></tr></thead><tbody><tr><td><b>月度费用分析</b><br><small class="muted">费用口径、异常解释与报告结构</small></td><td><span class="badge green">可在对话引用</span></td><td>1.2</td><td><a class="inline-link" href="#tool/report">费用分析报告</a></td><td><a class="btn small" href="../skills-hub/chat.html?skill=monthly-expense">在对话中使用</a></td></tr><tr><td><b>票据一致性检查</b><br><small class="muted">检查票据要素与单据的一致性</small></td><td><span class="badge green">可在对话引用</span></td><td>1.2.0</td><td>—</td><td><a class="btn small" href="../skills-hub/catalog.html">查看详情</a></td></tr><tr><td><b>英文报告风格</b><br><small class="muted">英文财务报告的表达规范</small></td><td><span class="badge">仅存储</span></td><td>2.1.0</td><td>—</td><td><a class="btn small" href="../skills-hub/catalog.html">查看详情</a></td></tr></tbody></table></div>`;}
function catalogLower(){
 const recent=state.activities.filter(a=>a.userId===user().id&&appVisible(findApp(a.appId))).slice(0,4);
 const mine=state.apps.filter(a=>a.owner===user().name&&(a.status!=='published'||a.pendingRevision));
 let html='';
 if(recent.length)html+=`<section class="catalog-section"><div class="section-title"><h2>最近使用</h2><small>仅本人可见</small></div><div class="activity-table">${recent.map(r=>`<div class="activity-row"><span class="activity-name">${icon(findApp(r.appId)?.icon)}${esc(findApp(r.appId)?.name||r.title)}</span><span class="muted">${esc(r.detail||r.title)}</span><small>${relativeTime(r.time)}</small><a class="activity-open" href="#tool/${encodeURIComponent(r.appId)}">再次打开</a></div>`).join('')}</div></section>`;
 if(mine.length)html+=`<section class="catalog-section"><div class="section-title"><h2>我的提交</h2><a class="text-button" href="#mine">查看全部${icon('chevron')}</a></div><div class="activity-table">${mine.slice(0,3).map(a=>`<div class="activity-row"><span class="activity-name">${icon(a.icon)}${esc(a.name)}</span><span class="muted">${a.pendingRevision?'新版本审核中':statusText(a)}</span><small>v${esc(a.pendingRevision?.version||a.version)}</small><a class="activity-open" href="#mine">查看</a></div>`).join('')}</div></section>`;
 if(!recent.length&&!mine.length)html+=`<section class="catalog-section"><div class="section-title"><h2>最近使用</h2></div><div class="activity-table"><div class="empty">使用工具后，记录会显示在这里。</div></div></section>`;
 return html;
}
function bindAppActions(root){root.querySelectorAll('[data-detail]').forEach(b=>b.onclick=()=>details(b.dataset.detail));root.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>{const a=findApp(b.dataset.open);if(usable(a))navigate('tool/'+a.id);else requestAccess(a);});root.querySelectorAll('[data-favorite]').forEach(b=>b.onclick=()=>toggleFavorite(b.dataset.favorite));root.querySelectorAll('[data-share]').forEach(b=>b.onclick=()=>share(b.dataset.share));}
function details(id){const a=findApp(id);if(!a||!appVisible(a))return toast('你没有查看此工具的权限');openPanel('工具详情',`<div class="detail-head"><span class="tool-symbol">${icon(a.icon)}</span><div><h3>${esc(a.name)}</h3><span class="badge ${a.status==='published'?'green':'amber'}">${statusText(a)}</span> <span class="badge">v${esc(a.version)}</span></div></div><p class="muted">${esc(a.description)}</p><dl class="detail-grid"><dt>维护人</dt><dd>${esc(a.maintainer||a.owner)} · ${esc(a.department)}</dd><dt>运行方式</dt><dd>${a.kind==='ai'?'平台服务':a.builtIn?'浏览器内处理':'隔离预览'}</dd><dt>可见范围</dt><dd>${scopeText(a.visibility)}</dd><dt>使用范围</dt><dd>${scopeText(a.useScope||a.visibility)}</dd><dt>文件格式</dt><dd>${a.builtIn?'CSV（UTF-8）':'HTML'}</dd>${a.skill?`<dt>关联技能</dt><dd>${esc(a.skill)} v${esc(a.skillVersion)}<br><small class="muted">当前只生成基础报告，AI 解读未连接。</small></dd>`:''}</dl>${a.builtIn?'<div class="notice">所选文件在当前浏览器处理，不上传服务器。</div>':'<div class="notice">HTML 在隔离区域预览，外部资源访问受限。</div>'}<div class="detail-actions"><button class="btn primary" id="detail-open">${usable(a)?'打开工具':'申请使用'}</button><button class="btn" id="detail-share">${icon('link')}分享</button>${embedded?'':`<button class="btn ghost" id="detail-chat">${icon('chat')}带入对话</button>`}</div>`,root=>{root.querySelector('#detail-open').onclick=()=>{if(usable(a)){closePanel();navigate('tool/'+a.id);}else requestAccess(a);};root.querySelector('#detail-share').onclick=()=>share(a.id);if(!embedded)root.querySelector('#detail-chat').onclick=()=>{selectedTool=a.id;closePanel();navigate('chat');};});}
function share(id){const a=findApp(id);if(!a||!appVisible(a))return toast('你没有查看此工具的权限');if(canManage(a,user()))return showShare(id,ctx);const link=new URL(getToolUrl(id));openPanel('分享工具',`<h3>${esc(a.name)}</h3><div class="field"><label for="share-url">访问链接</label><div class="link-field"><input id="share-url" readonly value="${esc(link.href)}"><button class="btn" id="copy-share">复制链接</button></div></div><div class="notice">接收者仍需拥有工具使用权限。此链接为本机地址。</div>`,root=>root.querySelector('#copy-share').onclick=()=>copy(link.href));}
async function copy(text){try{await navigator.clipboard.writeText(text);toast('链接已复制');}catch{toast('无法自动复制，请选中链接手动复制');}}
function requestAccess(a){if(!a||!appVisible(a))return toast('工具不存在或你没有查看权限');const existing=state.requests.find(r=>r.appId===a.id&&r.userId===user().id&&r.status==='pending');openPanel('申请使用',`<h3>${esc(a.name)}</h3><dl class="detail-grid"><dt>申请人</dt><dd>${esc(user().name)} · ${esc(user().department)}</dd><dt>权限</dt><dd>使用工具</dd></dl>${existing?'<div class="notice">申请已提交，等待平台管理员处理。</div>':'<form id="access-form"><div class="field"><label for="reason">申请原因</label><textarea id="reason" required maxlength="300" rows="4" placeholder="填写业务用途"></textarea></div><div class="drawer-footer"><button class="btn primary" type="submit">提交申请</button></div></form>'}`,root=>root.querySelector('#access-form')?.addEventListener('submit',e=>{e.preventDefault();const reason=root.querySelector('#reason').value.trim();if(!reason)return;state.requests.push({id:crypto.randomUUID(),appId:a.id,userId:user().id,reason,status:'pending',time:new Date().toISOString()});if(!saveState(state))return;closePanel();toast('使用申请已提交');}));}
function showRequests(){if(user().role!=='admin')return toast('仅平台管理员可处理申请');const pending=state.requests.filter(r=>r.status==='pending');openPanel('访问申请',pending.length?pending.map(r=>`<div class="request-row"><h3>${esc(findApp(r.appId)?.name||'工具已移除')}</h3><p>${esc(USERS[r.userId]?.name)} · ${esc(USERS[r.userId]?.department)}</p><p>${esc(r.reason)}</p><div class="request-actions"><button class="btn primary small" data-approve="${esc(r.id)}">同意</button><button class="btn small" data-reject="${esc(r.id)}">拒绝</button></div></div>`).join(''):'<div class="empty">暂无待处理申请</div>',root=>{root.querySelectorAll('[data-approve],[data-reject]').forEach(b=>b.onclick=()=>{const request=state.requests.find(r=>r.id===(b.dataset.approve||b.dataset.reject));if(!request||request.status!=='pending')return;const a=findApp(request.appId);if(!a)return toast('该工具已不存在');request.status=b.dataset.approve?'approved':'rejected';if(b.dataset.approve){a.useUserIds=[...new Set([...Object.values(USERS).filter(u=>use(a,u)).map(u=>u.id),request.userId])];a.useScope='selected';if(!discover(a,USERS[request.userId])){a.userIds=[...new Set([...Object.values(USERS).filter(u=>discover(a,u)).map(u=>u.id),request.userId])];a.visibility='selected';}}if(!saveState(state))return;toast(b.dataset.approve?'已授予使用权限':'已拒绝申请');showRequests();});});}
function deniedTool(a){main.innerHTML=`<div class="panel access-card">${icon('lock')}<h1>${!a||!appVisible(a)?'工具不可访问':a.status!=='published'?'工具暂不可用':'需要使用权限'}</h1><p>${!a||!appVisible(a)?'工具不存在，或当前账号没有查看权限。':a.status!=='published'?`${esc(a.name)}当前为${statusText(a)}状态。`:`${esc(a.name)}尚未向当前账号开放。`}</p><div class="page-actions"><a class="btn" href="#catalog">返回目录</a>${a&&appVisible(a)&&a.status==='published'?'<button class="btn primary" id="denied-request">申请使用</button>':''}</div></div>`;main.querySelector('#denied-request')?.addEventListener('click',()=>requestAccess(a));}
function sandboxHtml(code){const doc=new DOMParser().parseFromString(String(code||''),'text/html');doc.querySelectorAll('base,meta[http-equiv=refresh]').forEach(el=>el.remove());const meta=doc.createElement('meta');meta.httpEquiv='Content-Security-Policy';meta.content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none';";doc.head.prepend(meta);return '<!doctype html>'+doc.documentElement.outerHTML;}
function uploadedTool(a){main.innerHTML=`<div class="page-heading"><div class="page-actions"><a class="icon-button" href="#catalog" aria-label="返回目录">${icon('back')}</a><h1>${esc(a.name)}</h1><span class="badge">v${esc(a.version)}</span></div><div class="page-actions"><button class="btn" id="uploaded-share">${icon('link')}分享</button></div></div><div class="preview-top"><span>${icon('shield')} 隔离运行 · 外部资源受限</span><span>${esc(a.maintainer||a.owner)}</span></div>${a.code?'<iframe id="uploaded-frame" class="tool-preview" sandbox="allow-scripts" referrerpolicy="no-referrer" title="工具运行区域"></iframe>':'<div class="empty">此版本没有可用的工具文件，请联系维护人。</div>'}`;const frame=main.querySelector('#uploaded-frame');if(frame)frame.srcdoc=sandboxHtml(a.code);main.querySelector('#uploaded-share').onclick=()=>share(a.id);}
function renderChat(){
 const available=state.apps.filter(a=>a.status==='published'&&appVisible(a));
 const a=findApp(selectedTool);if(!a||!appVisible(a))selectedTool='';
 main.innerHTML=`<div class="chat-page"><div class="page-heading chat-heading"><h1>财小智</h1><button class="btn ghost" id="clear-chat">${icon('plus')}新建对话</button></div>${!chatMessages.length?`<div class="chat-intro"><img class="assistant-mark" src="/agent-assets/caixiaozhi.png" alt=""><h2>今天要处理什么？</h2><div class="quick-tools">${available.map(t=>`<button class="quick-tool" data-select-tool="${esc(t.id)}">${icon(t.icon)}${esc(t.name)}</button>`).join('')}</div></div>`:`<div class="chat-messages">${chatMessages.map(messageHtml).join('')}</div>`}<form class="composer" id="chat-form"><textarea id="chat-input" rows="2" placeholder="描述要处理的表格或报告" aria-label="对话内容" maxlength="2000">${esc(chatDraft)}</textarea><div class="composer-bottom"><button type="button" class="composer-tool" id="tool-picker">${icon('grid')}<span>${selectedTool?esc(findApp(selectedTool)?.name):'选择工具'}</span>${icon('chevron')}</button>${selectedTool?`<button type="button" class="icon-button" id="remove-tool" aria-label="移除所选工具">${icon('close')}</button>`:''}<button class="send" aria-label="发送" type="submit">${icon('send')}</button></div></form><p class="chat-source">工具匹配采用本地规则，未连接大模型</p></div>`;
 main.querySelector('#chat-input').oninput=e=>chatDraft=e.target.value;main.querySelector('#chat-input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();sendMessage();}};main.querySelector('#chat-form').onsubmit=e=>{e.preventDefault();sendMessage();};main.querySelector('#clear-chat').onclick=()=>{chatMessages=[];chatDraft='';selectedTool='';renderChat();};main.querySelectorAll('[data-select-tool]').forEach(b=>b.onclick=()=>{selectedTool=b.dataset.selectTool;renderChat();main.querySelector('#chat-input').focus();});main.querySelector('#remove-tool')?.addEventListener('click',()=>{selectedTool='';renderChat();});main.querySelector('#tool-picker').onclick=()=>openPanel('选择工具',`<label class="search" style="width:100%;margin-bottom:16px">${icon('search')}<input id="picker-search" placeholder="搜索工具" aria-label="搜索工具"></label><div id="picker-items">${available.map(t=>`<button class="identity-option" data-pick="${esc(t.id)}"><span class="tool-symbol">${icon(t.icon)}</span><span><b>${esc(t.name)}</b><small>${usable(t)?'可使用':'需申请使用'}</small></span>${selectedTool===t.id?icon('check'):''}</button>`).join('')}</div>`,root=>{root.querySelectorAll('[data-pick]').forEach(b=>b.onclick=()=>{selectedTool=b.dataset.pick;closePanel();renderChat();main.querySelector('#chat-input').focus();});root.querySelector('#picker-search').oninput=e=>root.querySelectorAll('[data-pick]').forEach(b=>b.hidden=!findApp(b.dataset.pick).name.includes(e.target.value));});bindAppActions(main);
}
function messageHtml(m){if(m.type==='user')return `<div class="message user"><div class="user-bubble">${esc(m.text)}</div></div>`;const a=findApp(m.appId);const recent=a?state.activities.find(r=>r.appId===a.id&&r.userId===user().id):null;return `<div class="message assistant"><div class="assistant-label"><img src="/agent-assets/caixiaozhi.png" alt="">财小智<span class="badge">工具匹配</span></div><p class="assistant-text">${esc(m.text)}</p>${a&&appVisible(a)?`<div class="chat-result"><div class="chat-result-top"><span class="tool-symbol">${icon(a.icon)}</span><div><h3>${esc(a.name)}</h3><small>v${esc(a.version)} · ${a.kind==='ai'?'平台服务':'浏览器处理'}</small></div><button class="btn small ${usable(a)?'primary':''}" data-open="${esc(a.id)}">${usable(a)?'打开工具':'申请使用'}</button><button class="icon-button" data-detail="${esc(a.id)}" aria-label="查看工具详情">${icon('chevron')}</button></div>${recent?`<div class="chat-result-summary">最近结果：${esc(recent.detail||recent.title)}</div>`:''}</div>`:''}</div>`;}
function sendMessage(){const text=chatDraft.trim();if(!text&&!selectedTool){toast('请输入内容或选择工具');return;}chatMessages.push({type:'user',text:text||'打开'+findApp(selectedTool)?.name});const query=text.toLowerCase();let id=selectedTool;if(!id){if(/核对|对账|差异|流水/.test(query))id='reconcile';else if(/转换|模板|台账|字段/.test(query))id='convert';else if(/分析|报告|费用|汇总/.test(query))id='report';}const a=findApp(id);if(a&&appVisible(a)&&a.status==='published')chatMessages.push({type:'assistant',appId:id,text:usable(a)?'找到可用工具。打开后选择文件并确认处理参数。':'找到相关工具，当前账号需要先申请使用权限。'});else chatMessages.push({type:'assistant',text:'没有匹配到可用工具。可以从工具列表中选择，或换一个更具体的描述。'});chatDraft='';renderChat();main.querySelector('#chat-input').focus();main.querySelector('#chat-form').scrollIntoView({block:'nearest',behavior:'smooth'});}
function showIdentity(){openPanel('切换身份',`<div class="notice">仅切换当前浏览器的轻应用身份。</div>${Object.values(USERS).map(u=>`<button class="identity-option" data-user="${u.id}"><span class="avatar">${u.name[0]}</span><span><b>${u.name} · ${u.label}</b><small>${u.department}</small></span>${u.id===user().id?icon('check'):''}</button>`).join('')}`,root=>root.querySelectorAll('[data-user]').forEach(b=>b.onclick=()=>{state.persona=b.dataset.user;if(!saveState(state))return;chatMessages=[];selectedTool='';chatDraft='';closePanel();render();toast('已切换为'+user().name);}));}
function showGuide(){
 let guide=document.getElementById('tool-guide');
 if(!guide){guide=document.createElement('dialog');guide.id='tool-guide';guide.className='tool-guide';guide.setAttribute('aria-labelledby','tool-guide-title');document.body.append(guide);}
 const toolId=location.hash.startsWith('#tool/')?decodeURIComponent(location.hash.slice(6)):null;
 guide.innerHTML=`<header><h2 id="tool-guide-title">使用指引</h2><button class="icon-button" data-guide-close aria-label="关闭使用指引">${icon('close')}</button></header><h3>使用工具</h3><ol><li>选择 UTF-8 CSV 文件，核对字段映射后执行。</li><li>查看结果中的异常记录，再导出所需结果。</li></ol><p>浏览器工具仅保存活动摘要；结果在当前页面查看和导出，未接入对话执行。</p>${['reconcile','convert','report'].includes(toolId)&&!drawer.open?'<div class="tool-guide-actions"><button class="btn" data-guide-sample>使用示例数据</button></div>':''}${panelKind==='upload'?'<h3>工具文件</h3><p>上传单个 HTML 文件，最大 200 KB。上传本身不执行代码，预览使用隔离环境。</p><div class="tool-guide-actions"><button class="btn" data-guide-upload>使用示例文件</button><button class="btn" data-guide-download>下载示例文件</button></div>':''}<h3>上传、审核与发布</h3><ol><li>创建者保存草稿或提交审核。</li><li>业务审核人与技术审核人分别核对，管理员在两项通过后发布。</li><li>分享不会授予权限；平台管理员可以处理访问申请。</li></ol><h3>演示身份</h3><select data-guide-persona aria-label="切换工具演示身份" ${panelKind==='upload'?'disabled':''}>${Object.values(USERS).map(u=>`<option value="${u.id}" ${u.id===user().id?'selected':''}>${esc(u.name)} · ${esc(u.label)}</option>`).join('')}</select><p>工具权限及上传记录保存在当前浏览器，与主应用账号独立。</p><p><a class="inline-link" href="./README.md" target="_blank" rel="noopener">查看交付说明</a></p><button class="btn danger" data-guide-reset>重置演示数据</button>`;
 const close=()=>{guide.close();document.getElementById('guide-button').focus();};
 guide.querySelector('[data-guide-close]').onclick=close;
 guide.querySelector('[data-guide-sample]')?.addEventListener('click',()=>{close();main.__toolGuideAction?.('load-sample');});
 guide.querySelector('[data-guide-upload]')?.addEventListener('click',()=>{close();panel.__uploadGuideAction?.('upload-sample');});
 guide.querySelector('[data-guide-download]')?.addEventListener('click',()=>panel.__uploadGuideAction?.('download-upload-sample'));
 guide.querySelector('[data-guide-persona]').onchange=event=>{state.persona=event.target.value;if(!saveState(state))return;close();clearToolCache();chatMessages=[];selectedTool='';chatDraft='';render();};
 guide.querySelector('[data-guide-reset]').onclick=()=>{close();openPanel('重置演示数据','<p>将清除当前浏览器中的上传工具、审核记录、授权和活动记录，恢复初始示例。</p><div class="detail-actions"><button class="btn danger" id="confirm-reset">确认重置</button><button class="btn" id="cancel-reset">取消</button></div>',root=>{root.querySelector('#cancel-reset').onclick=closePanel;root.querySelector('#confirm-reset').onclick=()=>{state=createSeed();if(!saveState(state))return;clearToolCache();clearManageDrafts();closePanel();navigate('catalog');toast('演示数据已重置');};});};
 guide.showModal();
}
function render(){
 if(leaving)return;
 main.__toolGuideAction=null;
 const hash=location.hash.slice(1)||'catalog';
 if(drawer.open)closePanel();
 let parts=hash.split('/'),route=parts[0];
 if(embedded&&['catalog','mine','reviews','chat'].includes(route)){navigate('catalog');return;}
 document.body.dataset.route=route;
 document.querySelectorAll('[data-nav]').forEach(a=>a.classList.toggle('active',a.dataset.nav===(route==='tool'?'catalog':route)));
 updateSidebar();
 if(route==='catalog')renderCatalog();
 else if(route==='mine'||route==='reviews')mountManage(main,route,ctx);
 else if(route==='chat')renderChat();
 else if(['manage','review','edit','share','request','upload','requests'].includes(route)){
   let id;try{id=decodeURIComponent(parts.slice(1).join('/'));}catch{id='';}
   const app=findApp(id);
   const permitted=route==='upload'?['author','admin'].includes(user().role):route==='requests'?user().role==='admin':route==='review'?canReviewTool(app,user()):route==='manage'||route==='edit'?canManage(app,user()):appVisible(app)&&app.status==='published';
   if(!permitted){deniedTool(null);}
   else{
     main.innerHTML=`<div class="tool-operation"><button class="tool-back" data-operation-back>${icon('back')}返回${['manage','review','edit','upload','requests'].includes(route)?'管理':'目录'}</button></div>`;
     main.querySelector('[data-operation-back]').onclick=()=>navigate('catalog');
     if(route==='manage')showAppDetails(id,ctx);
     else if(route==='review')showReview(id,ctx);
     else if(route==='edit')showUpload(ctx,id);
     else if(route==='upload')showUpload(ctx);
     else if(route==='share')showShare(id,ctx);
     else if(route==='request')requestAccess(app);
     else showRequests();
   }
 }
 else if(route==='tool'){
   let id;try{id=decodeURIComponent(parts.slice(1).join('/'));}catch{id='';}const app=findApp(id);
   if(!app||!usable(app))deniedTool(app);else if(app.builtIn)mountTool(main,id,ctx);else uploadedTool(app);
 }else if(route==='main'){navigate('catalog');return;}else {navigate('catalog');return;}
 const titles={catalog:'工具中心',mine:'我创建的',reviews:'审核管理',chat:'对话',tool:'工具'};
 document.title=(titles[route]||'工具中心')+' · 财小智';
 if(lastRoute!==hash){window.scrollTo(0,0);main.scrollTop=0;if(!drawer.open)main.focus({preventScroll:true});lastRoute=hash;}
 hostMessage({type:'ready'});
}
document.getElementById('profile-button').onclick=showIdentity;document.getElementById('guide-button').onclick=showGuide;
window.addEventListener('hashchange',()=>{leaving=false;render();});
window.addEventListener('storage',event=>{
 if(event.key!==STORE&&event.key!==null)return;
 try{
   const previousPersona=state.persona;state=readToolState();persistedState=structuredClone(state);updateSidebar();
   if(previousPersona!==state.persona){clearToolCache();render();}
   else if(!drawer.open)render();
 }catch{toast('未能同步其他页面的修改，请刷新后重试');}
});
document.querySelector('.skip-link').onclick=event=>{event.preventDefault();main.focus();};
if(!embedded){const guideButton=document.getElementById('guide-button');guideButton.className='guide-floating';document.body.append(guideButton);}
setupEmbed();hydrateIcons();render();
