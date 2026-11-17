import { parseCSV, formatMoney, moneyForCSV, csvExport, reconcileTables, convertTable, analyzeExpenses } from './finance-core.js';

const cache = new Map();
export function clearToolCache(){cache.clear();}
const SVG = {
  back:'<path d="m14 5-7 7 7 7"/>', file:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5"/>', shield:'<path d="m12 3 8 3v6c0 4-8 9-8 9s-8-5-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  check:'<path d="m5 12 4 4L19 6"/>', chart:'<path d="M4 3v18h17M8 16v-5m5 5V6m5 10V9"/>', skill:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SVG[name] || SVG.file}</svg>`;
const sampleLeft='流水号,交易日期,对方名称,金额\nSK20261001,2026-10-03,华东设备,12800.00\nSK20261002,2026-10-07,云川科技,8600.00\nSK20261003,2026-10-10,启明制造,4500.00\nSK20261004,2026-10-14,星河服务,3200.00\nSK20261005,2026-10-18,远山供应链,1800.00\nSK20261005,2026-10-18,远山供应链,1800.00\nSK20261006,2026-10-23,青禾商贸,-650.00';
const sampleRight='收款单号,入账日期,客户,入账金额\nSK20261001,2026-10-03,华东设备,12800.00\nSK20261002,2026-10-07,云川科技,8500.00\nSK20261003,2026-10-10,启明制造,4500.00\nSK20261005,2026-10-18,远山供应链,1800.00\nSK20261006,2026-10-23,青禾商贸,-650.00\nSK20261007,2026-10-28,南屿文化,2400.00';
const sampleConvert='发生日期,费用说明,报销金额,成本部门\n2026/10/05,杭州客户拜访交通,286.50,销售部\n2026/10/08,研发设备配件,1280.00,研发部\n2026/10/12,办公耗材,468.00,综合管理部\n2026/10/32,区域业务会议,2400.00,销售部\n2026/10/17,项目差旅住宿,1860.00,\n2026/10/21,项目资料印刷,358.00,研发部\n2026/10/26,客户活动场地,3200.00,销售部';
const sampleReport='日期,部门,费用类别,金额\n2026-10-03,销售部,差旅费,18600.00\n2026-10-05,研发部,办公费,8400.00\n2026-10-08,销售部,业务招待费,6800.00\n2026-10-11,综合管理部,办公费,4200.00\n2026-10-13,研发部,差旅费,7600.00\n2026-10-16,销售部,市场活动费,12800.00\n2026-10-20,综合管理部,差旅费,3800.00\n2026-10-23,研发部,培训费,6400.00\n2026-10-25,销售部,差旅费,9200.00\n2026-10-28,综合管理部,办公费,-600.00';
const names = {reconcile:'两表核对',convert:'台账模板转换',report:'费用分析报告'};
const statusNames = {matched:'匹配一致',difference:'金额差异','left-only':'仅流水存在','right-only':'仅台账存在',duplicate:'重复待确认',invalid:'数据异常'};
const source = (text,name) => ({table:parseCSV(text),name,sample:true});
function sampleState(id){
  if(id==='reconcile') return {left:source(sampleLeft,'银行流水_2026年10月.csv'),right:source(sampleRight,'收款台账_2026年10月.csv'),mapping:{leftKey:0,leftAmount:3,rightKey:0,rightAmount:3},filter:'all',result:null,error:'',ran:false};
  if(id==='convert') return {input:source(sampleConvert,'费用台账_待转换.csv'),mapping:{date:0,description:1,amount:2,department:3},filter:'all',result:null,error:'',ran:false};
  return {input:source(sampleReport,'费用明细_2026年10月.csv'),mapping:{date:0,department:1,category:2,amount:3},result:null,error:'',ran:false};
}
function initial(id){
  const empty=()=>({table:{headers:[],rows:[]},name:'',sample:false});
  const common={result:null,error:'',ran:false,filter:'all'};
  if(id==='reconcile')return {...common,left:empty(),right:empty(),mapping:{leftKey:-1,leftAmount:-1,rightKey:-1,rightAmount:-1}};
  return {...common,input:empty(),mapping:id==='convert'?{date:-1,description:-1,amount:-1,department:-1}:{date:-1,department:-1,category:-1,amount:-1}};
}
function download(name,content,type='text/csv;charset=utf-8'){
  const url=URL.createObjectURL(new Blob([content],{type})); const link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function signed(n){return n===null||n===undefined?'—':`${n>0?'+':''}${formatMoney(n)}`;}
function tableValue(cents){return cents===null||cents===undefined?'—':formatMoney(cents);}
function pick(table,words,fallback=-1){return table.headers.findIndex(h=>words.includes(h.trim()))>=0?table.headers.findIndex(h=>words.includes(h.trim())):fallback;}
function remap(id,table,side){
  if(id==='reconcile') return {[side+'Key']:pick(table,['流水号','收款单号','单号','交易编号','关联编号'],0),[side+'Amount']:pick(table,['金额','入账金额','收款金额','交易金额'],table.headers.length-1)};
  if(id==='convert') return {date:pick(table,['日期','发生日期','交易日期','报销日期']),description:pick(table,['摘要','费用说明','说明','事由']),amount:pick(table,['金额','报销金额','费用金额']),department:pick(table,['部门','成本部门','所属部门'])};
  return {date:pick(table,['日期','发生日期','交易日期']),department:pick(table,['部门','成本部门','所属部门']),category:pick(table,['费用类别','类别','费用类型']),amount:pick(table,['金额','报销金额','费用金额'])};
}

export function mountTool(root,id,ctx){
  if(!names[id]){root.innerHTML='<div class="tool-empty">工具不存在。</div>';return;}
  const esc=ctx.esc || (v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
  const user=ctx.getCurrentUser?.()||{};const userId=String(user.id??'');const key=`${userId}:${id}`;
  const mountToken=Symbol(id);root.__financeToolMount=mountToken;
  const currentApp=()=>ctx.getApps?.().find(a=>a.id===id);
  const isAllowed=()=>{const app=currentApp();return !!userId&&String(ctx.getCurrentUser?.()?.id??'')===userId&&!!app&&typeof ctx.canUse==='function'&&ctx.canUse(app)===true;};
  const isCurrent=()=>root.__financeToolMount===mountToken&&String(ctx.getCurrentUser?.()?.id??'')===userId;
  if(!isAllowed()){root.innerHTML='<div class="tool-empty" role="alert">当前身份无权使用此工具。</div>';return;}
  if(!cache.has(key))cache.set(key,initial(id));const state=cache.get(key);
  function options(table,selected){return '<option value="-1">请选择字段</option>'+table.headers.map((h,i)=>`<option value="${i}" ${i===selected?'selected':''}>${esc(h)}</option>`).join('');}
  function field(label,name,table){return `<label class="tool-field"><span>${label}</span><select data-mapping="${name}" aria-label="${label}">${options(table,state.mapping[name])}</select></label>`;}
  function fileBox(which,label){const data=state[which];return `<div class="tool-source"><div class="tool-source-heading"><h2>${label}</h2><span>CSV · UTF-8</span></div><div class="tool-file-row"><span class="tool-file-symbol">${icon('file')}</span><div class="tool-file-info"><strong title="${esc(data.name)}">${esc(data.name||'未选择文件')}</strong><small>${data.name?`${data.table.rows.length} 行${data.sample?' · 示例数据':' · 自选文件'}`:'最大 2 MB · 最多 5,000 行'}</small></div><label class="tool-file-picker">${data.name?'更换文件':'选择文件'}<input type="file" accept=".csv,text/csv" data-file="${which}" aria-label="更换${label}，仅支持 UTF-8 CSV"></label></div>${id==='reconcile'?`<div class="tool-mapping">${field('关联字段',which+'Key',data.table)}${field('金额字段',which+'Amount',data.table)}</div>`:''}</div>`;}
  function render(){
    if(!isCurrent())return;
    const hasResult=!!state.result;root.innerHTML=`<div class="tool-workspace"><button class="tool-back" data-back>${icon('back')}返回目录</button><div class="page-heading tool-heading"><div class="tool-title-row"><h1>${names[id]}</h1><span class="tool-version">v${esc(currentApp()?.version||'—')}</span><span class="tool-data-stamp">${icon('shield')}浏览器内处理</span></div><div class="tool-heading-actions"><button class="btn" data-export ${!hasResult?'disabled':''}>${icon('download')}${id==='report'?'导出报告':'导出结果'}</button><button class="btn primary" data-run>${id==='reconcile'?'开始核对':id==='convert'?'转换台账':'生成基础报告'}</button></div></div>${state.error?`<div class="tool-error" role="alert">${esc(state.error)}</div>`:''}${id==='reconcile'?reconcileView():id==='convert'?convertView():reportView()}</div>`;
    bind();
  }
  function reconcileView(){
    const result=state.result;const records=result?.records||[];const counts=result?.counts||{};
    let shown=records.filter(r=>state.filter==='all'||(state.filter==='attention'&&['duplicate','invalid'].includes(r.status))||(state.filter==='unmatched'&&['left-only','right-only'].includes(r.status))||r.status===state.filter);
    const filters=[['all','全部'],['difference','金额差异'],['attention','待确认'],['unmatched','单边记录'],['matched','匹配一致']];
    return `<div class="tool-inputs">${fileBox('left','银行流水')}${fileBox('right','收款台账')}</div><div class="tool-section-head"><h2>核对结果</h2><small>按关联字段精确匹配 · 金额单位：元</small></div><div class="tool-result-surface"><div class="tool-result-bar"><div class="tool-filters">${filters.map(([key,label])=>`<button class="tool-filter" data-filter="${key}" aria-pressed="${state.filter===key}">${label}</button>`).join('')}</div>${result?`<div class="tool-result-counts"><span>一致<b>${counts.matched||0}</b></span><span class="attention">差异<b>${counts.difference||0}</b></span><span>待确认<b>${(counts.duplicate||0)+(counts.invalid||0)}</b></span></div>`:''}</div>${!result?empty('选择字段后开始核对。'):!shown.length?empty('当前筛选下没有记录。'):`<div class="tool-table-wrap"><table class="tool-table"><thead><tr><th>关联编号</th><th class="num">流水金额</th><th class="num">台账金额</th><th class="num">差额</th><th>核对结果</th><th>说明</th></tr></thead><tbody>${shown.slice(0,200).map(r=>`<tr><td>${esc(r.id||'未填写')}</td><td class="num">${tableValue(r.leftAmount)}</td><td class="num">${tableValue(r.rightAmount)}</td><td class="num">${signed(r.diff)}</td><td><span class="tool-status ${r.status}">${statusNames[r.status]}</span></td><td class="reason">${esc(r.reason||'—')}</td></tr>`).join('')}</tbody></table></div>`}<div class="tool-table-footer"><span>${result?`当前 ${shown.length} 条${shown.length>200?'，预览前 200 条':''} · 共 ${records.length} 条结果`:'尚未执行'}</span><span>${!state.left.name&&!state.right.name?'尚未选择文件':state.left.sample&&state.right.sample?'来源：示例数据':'来源：当前选择的文件'}</span></div></div>`;
  }
  function convertView(){
    const result=state.result;const invalid=result?.invalid||[];const valid=result?.valid||[];
    const rows=state.filter==='invalid'?invalid.map(r=>({bad:true,...r})):state.filter==='valid'?valid.map((values,i)=>({values,line:i+1})):valid.map((values,i)=>({values,line:i+1})).concat(invalid.map(r=>({bad:true,...r})));
    return `<div class="tool-convert-input">${fileBox('input','源文件')}<div class="tool-field-map"><h2>字段映射</h2><div class="tool-field-map-grid">${field('日期 *','date',state.input.table)}${field('摘要 *','description',state.input.table)}${field('金额 *','amount',state.input.table)}${field('部门 *','department',state.input.table)}</div><p class="tool-subtle-caption">日期接受 YYYY-MM-DD 或 YYYY/MM/DD；金额最多两位小数。</p></div></div><div class="tool-section-head"><h2>集团费用台账</h2><small>标准字段 · ${result?'导出仅包含校验通过的记录':'必填项全部通过后可导出'}</small></div><div class="tool-result-surface"><div class="tool-result-bar"><div class="tool-filters">${[['all','全部'],['valid','校验通过'],['invalid','异常记录']].map(([value,label])=>`<button class="tool-filter" data-filter="${value}" aria-pressed="${state.filter===value}">${label}${result?` ${value==='all'?rowsTotal(result):value==='valid'?valid.length:invalid.length}`:''}</button>`).join('')}</div>${result?`<div class="tool-result-counts"><span>可导出<b>${valid.length}</b></span><span class="attention">需修正<b>${invalid.length}</b></span></div>`:''}</div>${!result?empty('确认字段映射后转换台账。'):!rows.length?empty('当前筛选下没有记录。'):`<div class="tool-table-wrap"><table class="tool-table"><thead><tr><th>${state.filter==='invalid'?'源文件行号':'记录'}</th><th>日期</th><th>摘要</th><th class="num">金额</th><th>部门</th><th>校验结果</th></tr></thead><tbody>${rows.slice(0,200).map((r,i)=>{const v=r.bad?[r.values[state.mapping.date],r.values[state.mapping.description],r.values[state.mapping.amount],r.values[state.mapping.department]]:r.values;return `<tr class="${r.bad?'invalid-row':''}"><td>${r.bad?`源第 ${r.line} 行`:i+1}</td><td>${esc(v[0]||'—')}</td><td class="text-wrap">${esc(v[1]||'—')}</td><td class="num">${esc(v[2]||'—')}</td><td>${esc(v[3]||'未填写')}</td><td class="reason">${r.bad?`<span class="tool-status warning">${esc(r.errors.join('；'))}</span>`:'<span class="tool-status success">通过</span>'}</td></tr>`;}).join('')}</tbody></table></div>`}<div class="tool-table-footer"><span>${result?`当前 ${rows.length} 条${rows.length>200?'，预览前 200 条':''} · 异常记录不会导出`:'尚未执行'}</span><span>${!state.input.name?'尚未选择文件':state.input.sample?'来源：示例数据':'来源：自选文件'}</span></div></div>`;
  }
  function rowsTotal(result){return result.valid.length+result.invalid.length;}
  function reportView(){
    const result=state.result;
    return `<div class="tool-report-input">${fileBox('input','费用明细')}<div class="tool-field-map"><h2>分析字段</h2><div class="tool-field-map-grid">${field('日期 *','date',state.input.table)}${field('部门 *','department',state.input.table)}${field('费用类别 *','category',state.input.table)}${field('金额 *','amount',state.input.table)}</div><p class="tool-subtle-caption">仅汇总当前文件中的有效记录；负数作为冲减。</p></div></div>${result?reportContent(result):`<div class="tool-result-surface" style="margin-top:20px">${empty('确认分析字段后生成基础报告。')}</div>`}`;
  }
  function chart(groups,title){const min=Math.min(...groups.map(g=>g.amount),0),max=Math.max(...groups.map(g=>g.amount),0),span=max-min||1,zero=-min/span*100;return `<div class="tool-chart"><h3>${title}</h3>${groups.slice(0,6).map(g=>`<div class="tool-bar-row"><span class="tool-bar-name" title="${esc(g.name)}">${esc(g.name)}</span><div class="tool-bar-track ${min<0?'has-negative':''}" style="--zero:${zero}%" role="img" aria-label="${esc(g.name)}，${formatMoney(g.amount)} 元"><div class="tool-bar-fill ${g.amount<0?'negative':''}" style="left:${Math.min(zero,(g.amount-min)/span*100)}%;width:${Math.abs(g.amount)/span*100}%"></div></div><span class="tool-bar-amount">${formatMoney(g.amount)}</span></div>`).join('')}${groups.length>6?'<p class="tool-note">图表显示金额最高的 6 项，完整数据见汇总明细。</p>':''}</div>`;}
  function summaryText(result){
    if(!result.count)return ['当前文件中没有可纳入统计的有效记录。'];
    const first=result.departments[0];const cat=result.categories[0];
    const details=[`本次汇总 ${result.count} 笔有效记录，费用净额 ${formatMoney(result.total)} 元，涉及 ${result.departments.length} 个部门、${result.categories.length} 个费用类别。`];
    if(first)details.push(`按净额排序，${first.name}为金额最高的部门，合计 ${formatMoney(first.amount)} 元；${cat.name}为金额最高的费用类别，合计 ${formatMoney(cat.amount)} 元。`);
    if(result.valid.some(r=>r.amount<0))details.push(`其中 ${result.valid.filter(r=>r.amount<0).length} 笔负数记录已作为冲减计入净额。`);
    return details;
  }
  function reportContent(result){
    const dates=result.valid.map(r=>r.date).sort();const period=dates.length?(dates[0]===dates.at(-1)?dates[0]:`${dates[0]} 至 ${dates.at(-1)}`):'无有效日期';
    return `<article class="tool-report-body"><div class="tool-report-head"><div><h2>费用汇总报告</h2><p>${period} · ${state.input.sample?'示例数据':'自选文件'} · 人民币</p></div><div class="tool-report-total"><small>费用净额</small><strong><span>¥</span>${formatMoney(result.total)}</strong><em>${result.count} 笔有效记录</em></div></div>${result.count?`<div class="tool-report-charts">${chart(result.departments,'部门分布')}${chart(result.categories,'费用类别')}</div>`:empty('没有可统计的有效记录。')}<section class="tool-report-summary"><h3>基础摘要</h3>${summaryText(result).map(text=>`<p>${esc(text)}</p>`).join('')}</section>${result.invalid.length?`<details class="tool-report-invalid"><summary>${result.invalid.length} 条异常记录未计入汇总</summary><div class="tool-table-wrap"><table class="tool-table"><thead><tr><th>源文件行号</th><th>问题</th></tr></thead><tbody>${result.invalid.slice(0,200).map(r=>`<tr><td>第 ${r.line} 行</td><td class="text-wrap">${esc(r.errors.join('；'))}</td></tr>`).join('')}</tbody></table></div></details>`:''}<details class="tool-report-breakdown"><summary>查看汇总明细</summary><div class="tool-table-wrap"><table class="tool-table"><thead><tr><th>维度</th><th>名称</th><th class="num">笔数</th><th class="num">净额（元）</th></tr></thead><tbody>${[['部门',result.departments],['费用类别',result.categories]].flatMap(([dim,groups])=>groups.map(g=>`<tr><td>${dim}</td><td>${esc(g.name)}</td><td class="num">${g.count}</td><td class="num">${formatMoney(g.amount)}</td></tr>`)).join('')}</tbody></table></div></details><div class="tool-report-bottom"><span class="tool-skill-link">${icon('skill')}<b>月度费用分析 Skill · v1.2</b><span>AI 解读未连接</span></span><span>来源：${esc(state.input.name)}</span></div></article>`;
  }
  function empty(text){return `<div class="tool-empty">${icon(id==='report'?'chart':'file')}<p>${text}</p></div>`;}
  function execute(silent=false){
    if(!isAllowed()){ctx.toast('当前身份无权使用此工具');return;}
    state.error='';
    try{
      if(id==='reconcile'?(!state.left.name||!state.right.name):!state.input.name)throw new Error(id==='reconcile'?'请选择银行流水和收款台账文件。':'请选择待处理的 CSV 文件。');
      const map=Object.values(state.mapping);if(map.some(v=>v<0))throw new Error('请为每个必填项选择对应字段。');
      if(id==='reconcile'){
        if(state.mapping.leftKey===state.mapping.leftAmount||state.mapping.rightKey===state.mapping.rightAmount)throw new Error('关联字段与金额字段不能使用同一列。');
        state.result=reconcileTables(state.left.table,state.right.table,state.mapping);
      }else{
        if(new Set(map).size!==map.length)throw new Error('不同标准字段不能映射到同一列。');
        state.result=id==='convert'?convertTable(state.input.table,state.mapping):analyzeExpenses(state.input.table,state.mapping);
      }
      state.ran=true;state.filter='all';
      if(!silent){
        const result=state.result;const detail=id==='reconcile'?`${result.counts.matched||0} 条一致，${result.counts.difference||0} 条金额差异，${(result.counts.duplicate||0)+(result.counts.invalid||0)} 条待确认，${result.counts['left-only']||0} 条仅流水存在，${result.counts['right-only']||0} 条仅台账存在`:id==='convert'?`${result.valid.length} 条校验通过，${result.invalid.length} 条需修正`:`汇总 ${result.count} 笔，净额 ${formatMoney(result.total)} 元`;
        ctx.addActivity?.({appId:id,title:`${names[id]}已完成`,detail});ctx.toast(id==='reconcile'?'核对完成':id==='convert'?'转换完成':'基础报告已生成');
      }
    }catch(error){state.error=error.message;state.result=null;}
    render();
  }
  async function loadFile(file,which){
    if(!file)return;
    const workspace=root.querySelector('.tool-workspace');
    const stillMounted=()=>isCurrent()&&root.querySelector('.tool-workspace')===workspace&&isAllowed();
    try{
      if(!/\.csv$/i.test(file.name))throw new Error('仅支持 CSV 文件，请另存为 UTF-8 CSV 后重试。');
      if(file.size>2*1024*1024)throw new Error('文件超过 2 MB，请拆分后重新选择。');
      const text=await file.text();if(!stillMounted())return;if(text.includes('\uFFFD'))throw new Error('文件编码无法识别，请另存为 UTF-8 CSV 后重试。');
      const table=parseCSV(text);if(table.rows.length>5000)throw new Error('单个文件最多支持 5,000 行，请拆分后重试。');
      if(!table.rows.length)throw new Error('文件中只有表头，请至少添加一条记录。');
      state[which]={table,name:file.name,sample:false};state.mapping={...state.mapping,...remap(id,table,which)};state.result=null;state.error='';state.ran=false;render();ctx.toast('文件已载入，等待处理');
    }catch(error){if(!stillMounted())return;const blank=initial(id);state[which]=blank[which];if(id==='reconcile'){state.mapping[which+'Key']=-1;state.mapping[which+'Amount']=-1;}else state.mapping=blank.mapping;state.result=null;state.ran=false;state.error=error.message;render();}
  }
  function exportResult(){
    if(!state.result||!isAllowed())return;
    const result=state.result;
    if(id==='reconcile')download('两表核对_结果.csv',csvExport(['关联编号','流水金额','台账金额','差额','核对结果','说明'],result.records.map(r=>[r.id,moneyForCSV(r.leftAmount),moneyForCSV(r.rightAmount),moneyForCSV(r.diff),statusNames[r.status],r.reason||''])));
    if(id==='convert'){
      if(!result.valid.length){ctx.toast('没有校验通过的记录，请先修正源文件');return;}
      download('集团费用台账.csv',csvExport(['日期','摘要','金额','部门'],result.valid));
    }
    if(id==='report'){
      const dates=result.valid.map(r=>r.date).sort();const title='费用汇总报告';
      const table=(label,groups)=>`<h2>${label}</h2><table><thead><tr><th>名称</th><th>笔数</th><th>净额（元）</th></tr></thead><tbody>${groups.map(g=>`<tr><td>${esc(g.name)}</td><td>${g.count}</td><td>${formatMoney(g.amount)}</td></tr>`).join('')}</tbody></table>`;
      const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:15px/1.8 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;color:#223955;max-width:920px;margin:40px auto;padding:0 24px}h1{font-size:27px}h2{font-size:18px;margin-top:32px}table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #dce5f0;padding:9px 12px;text-align:left}th{background:#f1f5fa}small{color:#5a708b}.amount{font-size:30px;color:#2c63ae}.note{border-top:1px solid #dce5f0;padding-top:20px;margin-top:35px;font-size:13px;color:#5a708b}</style></head><body><h1>${title}</h1><small>${dates.length?`${dates[0]} 至 ${dates.at(-1)}`:'无有效日期'} · ${state.input.sample?'示例数据':'自选文件'}</small><p class="amount">¥ ${formatMoney(result.total)}</p><p>${result.count} 笔有效记录；${result.invalid.length} 条异常记录未计入汇总。</p><h2>基础摘要</h2>${summaryText(result).map(t=>`<p>${esc(t)}</p>`).join('')}${table('部门汇总',result.departments)}${table('费用类别汇总',result.categories)}${result.invalid.length?`<h2>未计入汇总的异常记录</h2><ul>${result.invalid.map(r=>`<li>源文件第 ${r.line} 行：${esc(r.errors.join('；'))}</li>`).join('')}</ul>`:''}<p class="note">数据来源：${esc(state.input.name)}。本报告按当前文件进行确定性汇总，未调用 AI 或月度费用分析 Skill，不含同比、预算或因果判断。</p></body></html>`;
      download('费用汇总报告.html',html,'text/html;charset=utf-8');
    }
    ctx.toast(id==='report'?'报告已导出':id==='convert'?`已导出 ${result.valid.length} 条有效记录`:'核对结果已导出');
  }
  function bind(){
    root.querySelector('[data-back]').onclick=()=>ctx.navigate('catalog');
    root.querySelector('[data-run]').onclick=()=>execute();
    root.querySelector('[data-export]').onclick=()=>exportResult();
    root.querySelectorAll('[data-file]').forEach(input=>input.onchange=()=>loadFile(input.files?.[0],input.dataset.file));
    root.querySelectorAll('[data-mapping]').forEach(select=>select.onchange=()=>{const name=select.dataset.mapping;state.mapping[name]=Number(select.value);state.result=null;state.error='';render();root.querySelector(`[data-mapping="${name}"]`)?.focus();});
    root.querySelectorAll('[data-filter]').forEach(button=>button.onclick=()=>{state.filter=button.dataset.filter;render();root.querySelector(`[data-filter="${state.filter}"]`)?.focus();});
  }
  root.__toolGuideAction=action=>{if(action!=='load-sample'||!isCurrent()||!isAllowed())return false;Object.assign(state,sampleState(id));render();ctx.toast('已载入示例数据，等待处理');return true;};
  render();
}
