export const USERS = {
  finance: {id:'finance',name:'林晓',department:'财务共享中心',role:'author',label:'工具创建者'},
  employee: {id:'employee',name:'王晨',department:'业务运营部',role:'employee',label:'普通员工'},
  business: {id:'business',name:'周敏',department:'财务共享中心',role:'business',label:'业务审核人'},
  technical: {id:'technical',name:'陈屿',department:'信息技术中心',role:'technical',label:'技术审核人'},
  admin: {id:'admin',name:'许宁',department:'平台运营',role:'admin',label:'平台管理员'},
};

export const SAMPLE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>月份检查</title><style>body{font:14px/1.6 system-ui,sans-serif;color:#1c2d49;background:#fff;margin:0;padding:32px}h1{font-size:22px}label{display:block;margin:22px 0 8px}input,button{font:inherit;padding:9px 12px;border:1px solid #cdd7e7;border-radius:7px}button{background:#3667df;color:white;border-color:#3667df;cursor:pointer;margin-left:8px}output{display:block;margin-top:20px;background:#f4f7fc;border-radius:8px;padding:16px}</style></head><body><h1>月份检查</h1><label for="month">选择月份</label><input id="month" type="month" value="2026-11"><button id="check" type="button">检查</button><output id="result">尚未检查</output><script>document.getElementById('check').onclick=function(){const value=document.getElementById('month').value;if(!value){document.getElementById('result').textContent='请选择有效月份';return;}const parts=value.split('-').map(Number);const days=new Date(parts[0],parts[1],0).getDate();document.getElementById('result').textContent=value+' 共 '+days+' 天';};<\/script></body></html>`;

export function createSeed(){
 const common={owner:'林晓',maintainer:'林晓',department:'财务共享中心',version:'1.0.0',kind:'browser',status:'published',visibility:'all',userIds:[],useScope:'finance',useUserIds:[],reviews:{business:'approved',technical:'approved'},reviewNotes:{business:'示例审查记录：口径与样例已确认。',technical:'示例审查记录：限定浏览器内处理。'},createdAt:'2026-11-16T09:00:00+08:00',updatedAt:'2026-11-16T09:00:00+08:00'};
 const make=(fields)=>({...structuredClone(common),...fields});
 return {schema:1,persona:'finance',favorites:['reconcile'],activities:[],requests:[],apps:[
 make({id:'reconcile',name:'两表核对',description:'核对流水与台账，定位金额差异和未匹配记录。',category:'数据核对',icon:'compare',version:'1.2.0',builtIn:true}),
 make({id:'convert',name:'台账模板转换',description:'映射表格字段，校验后导出统一台账。',category:'表格处理',icon:'table',version:'1.1.0',useScope:'all',builtIn:true}),
 make({id:'report',name:'费用分析报告',description:'按部门与费用类别汇总，查看并导出基础报告。',category:'分析报告',icon:'chart',version:'1.0.0',skill:'月度费用分析',skillVersion:'1.2',builtIn:true}),
 make({id:'month-end-check',name:'月末日期检查',description:'检查所选月份的天数。',category:'表格处理',icon:'calendar',status:'draft',visibility:'finance',code:SAMPLE_HTML,reviews:{business:'pending',technical:'pending'},reviewNotes:{business:'',technical:''}}),
 make({id:'reimbursement-check',name:'结账月份校验',description:'查看结账月份的日历天数。',category:'数据核对',icon:'calendar',status:'review',visibility:'finance',code:SAMPLE_HTML,reviews:{business:'pending',technical:'pending'},reviewNotes:{business:'',technical:''}}),
 ]};
}
export function allowedByScope(scope,ids,user){
 return scope==='all'||(scope==='finance'&&user.department==='财务共享中心')||(scope==='selected'&&Array.isArray(ids)&&ids.includes(user.id));
}
export function canDiscover(app,user){
 if(!app||!user)return false;
 if(user.role==='admin'||app.owner===user.name)return true;
 return allowedByScope(app.visibility||'finance',app.userIds,user);
}
export function canUse(app,user){
 if(!app||app.status!=='published'||!canDiscover(app,user))return false;
 if(user.role==='admin'||app.owner===user.name)return true;
 return allowedByScope(app.useScope||app.visibility,app.useUserIds||app.userIds,user);
}
export function canManage(app,user){return !!app&&!!user&&(user.role==='admin'||app.owner===user.name);}
export function safeState(raw){
 if(!raw||raw.schema!==1||!Array.isArray(raw.apps)||!raw.apps.length) return createSeed();
 if(!USERS[raw.persona])raw.persona='finance';
 for(const key of ['favorites','activities','requests'])if(!Array.isArray(raw[key]))raw[key]=[];
 raw.apps=raw.apps.filter(a=>a&&typeof a.id==='string'&&typeof a.name==='string');
 return raw.apps.length?raw:createSeed();
}

// The React catalog and standalone workspace share this state and permission source.
export const TOOL_STORE = 'caixiaozhi-tool-center-v1';
export const TOOL_CHANGE_EVENT = 'caixiaozhi-tool-catalog-change';
export function readToolState(storage = localStorage) {
  const text = storage.getItem(TOOL_STORE);
  if (!text) return createSeed();
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error('工具数据无法读取，请保留浏览器数据后重试。'); }
  return safeState(raw);
}
export function writeToolState(state, storage = localStorage) {
  storage.setItem(TOOL_STORE, JSON.stringify(state));
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(TOOL_CHANGE_EVENT));
}
export function canReviewTool(app, user) {
  return !!app && !!user && ['business','technical','admin'].includes(user.role) && (app.pendingRevision || app).status !== 'draft';
}
export function getToolCatalog(state) {
  const identity = USERS[state.persona] || USERS.finance;
  const items = state.apps.filter(app => canDiscover(app,identity) && (app.status === 'published' || canManage(app,identity)) || canReviewTool(app,identity)).map(app => ({
    id:app.id, name:app.name, description:app.description || '', category:app.category || '办公效率', icon:app.icon || 'code',
    version:app.version || '—', owner:app.maintainer || app.owner || '—', status:app.status,
    latestVersion:app.pendingRevision?.version || app.version || '—', latestStatus:app.pendingRevision?.status || app.status,
    favorite:state.favorites.includes(app.id), canUse:canUse(app,identity), canManage:canManage(app,identity), canReview:canReviewTool(app,identity), canView:canDiscover(app,identity),
    updatedAt:app.pendingRevision?.submittedAt || app.updatedAt || app.publishedAt || app.submittedAt || app.createdAt || '', sourceLabel:'演示权限 · 浏览器本地保存',
  }));
  items.unshift({id:'expense-summary',name:'CSV 费用汇总',description:'按费用类别汇总 CSV 明细，保存结果并导出汇总表。',category:'分析报告',icon:'chart',version:'1.0',owner:'财小智',status:'published',latestVersion:'1.0',latestStatus:'published',favorite:state.favorites.includes('expense-summary'),canUse:true,canManage:false,canReview:false,canView:true,updatedAt:'',sourceLabel:'服务端工具'});
  return {items,identity,canUpload:['author','admin'].includes(identity.role),canReview:['business','technical','admin'].includes(identity.role)};
}
export function toggleToolFavorite(id, storage = localStorage) {
  const state = readToolState(storage);
  if (!getToolCatalog(state).items.some(item => item.id === id && item.canView)) throw new Error('工具不存在或没有查看权限。');
  state.favorites = state.favorites.includes(id) ? state.favorites.filter(value => value !== id) : [...state.favorites,id];
  writeToolState(state, storage);
}
export function setToolPersona(id, storage = localStorage) {
  if (!USERS[id]) throw new Error('演示身份不存在。');
  const state = readToolState(storage); state.persona = id; writeToolState(state, storage);
}
export function getToolDetail(state, id) {
  const item = getToolCatalog(state).items.find(value => value.id === id && value.canView);
  if (!item) return null;
  if (id === 'expense-summary') return {...item,execution:'服务端处理，可在对话中调用',input:'CSV 费用明细',output:'按费用类别汇总的结果与 CSV 文件',visibilityLabel:'当前工作区',useScopeLabel:'当前工作区',resultLabel:'完整结果保存在服务端，可重新打开和下载。',history:[]};
  const app = state.apps.find(value => value.id === id);
  const scope = value => ({all:'全体员工',finance:'财务共享中心',selected:'指定人员'})[value] || '财务共享中心';
  return {...item,execution:app.builtIn ? '浏览器内处理' : '隔离 HTML 工具',input:app.builtIn ? 'UTF-8 CSV 文件' : '由工具表单定义',output:app.builtIn ? (id === 'report' ? '基础费用报告与 HTML 导出' : '计算结果与 CSV 导出') : '由工具本身提供',visibilityLabel:scope(app.visibility),useScopeLabel:scope(app.useScope || app.visibility),resultLabel:app.builtIn ? '活动记录仅保存摘要；重新打开需重新处理文件。' : '结果与导出能力由工具本身提供。',history:(app.history || []).map(value => ({version:value.version,status:value.status,archivedAt:value.archivedAt || ''}))};
}
