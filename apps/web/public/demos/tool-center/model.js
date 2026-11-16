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
