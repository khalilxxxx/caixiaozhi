'use strict';

const paths = {
  grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  link:'<path d="m10 13 4-4m-6 6-1 1a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0m2 2 1-1a3.5 3.5 0 1 1 5 5l-4 4a3.5 3.5 0 0 1-5 0" transform="translate(1 0)"/>',
  database:'<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 4 16 4 16 0V5M4 12v7c0 4 16 4 16 0v-7"/>',
  file:'<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M13 2v7h7M8 13h8M8 17h6"/>',
  policy:'<path d="M12 5c-3-2-6-2.3-10-1v15c3.5-1.3 7-1.2 10 1 3-2.2 6.5-2.3 10-1V4c-4-1.3-7-1-10 1zm0 0v15"/>',
  building:'<path d="M3 22h18M5 22V5l10-3v20M15 9h4v13M8 8h1m2-1h1M8 12h1m2-1h1m-4 5h1m2-1h1"/>',
  lock:'<rect x="4" y="10" width="16" height="12" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v4"/>',
  check:'<path d="m4 12 5 5L20 6"/>',plus:'<path d="M12 5v14M5 12h14"/>',
  checklist:'<path d="M8 4H5v16h14V4h-3"/><rect x="8" y="2" width="8" height="4" rx="1.5"/><path d="m8 12 2.5 2.5L16 9"/>',
  case:'<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12a22 22 0 0 0 18 0m-9 0v3"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.8c0 1.7-2.4 2.1-2.4 3.7M12 17h.01"/>',
  message:'<path d="M21 11a8 8 0 0 1-8 8H8l-5 3v-6a8 8 0 0 1-1-4.3A8 8 0 0 1 10 4h3a8 8 0 0 1 8 7Z"/><path d="M7 10h9M7 14h6"/>',
  back:'<path d="m14 5-7 7 7 7"/>',chevron:'<path d="m9 5 7 7-7 7"/>',
  layers:'<path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  box:'<path d="m12 2 9 5v10l-9 5-9-5V7zM3 7l9 5 9-5m-9 5v10M7.5 4.5l9 5"/>',
  upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  external:'<path d="M14 3h7v7m0-7-11 11M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
  calculator:'<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M7 6h10M8 11h1m5 0h1m-7 4h1m5 0h1m-7 4h1m5 0h1"/>'
};
function icon(name,size=18){return '<svg aria-hidden="true" width="'+size+'" height="'+size+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'+(paths[name]||paths.grid)+'</svg>'}
window.demoIcon=icon;
const $=selector=>document.querySelector(selector);
function readRole(){try{return sessionStorage.getItem('cxz-demo-role')==='finance'?'finance':'employee'}catch{return 'employee'}}
let role=readRole();
const names={employee:'林晓',finance:'陈宁'};
const roleNames={employee:'普通员工',finance:'财务复核员'};
const {skills, connectors, team} = window.teamModel;
const bills={
 beijing:{id:'BX-261112-018',city:'北京',date:'11.10 – 11.12',hotel:580,rail:1250,taxi:70,tripSheet:false},
 hangzhou:{id:'BX-261116-026',city:'杭州',date:'11.15 – 11.17',hotel:450,rail:410,taxi:80,tripSheet:true}
};
const suppliers={
 stationery:{name:'青屿办公服务（示例）有限公司',registered:'青屿办公服务（示例）有限公司',status:'存续'},
 studio:{name:'棠木设计（示例）有限公司',registered:'棠木创意设计（示例）有限公司',status:'存续'}
};
const currency=new Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY'});
const money=n=>currency.format(n);
const sum=b=>b.rail+b.hotel*2+b.taxi;
let searchText='';
const sessions=new Map();
function memory(key){const id=role+'-'+key;if(!sessions.has(id))sessions.set(id,{choice:'',done:false});return sessions.get(id)}
function roleHeader(){$('#avatar').textContent=names[role].slice(0,1);$('#roleName').textContent=names[role];$('.person').setAttribute('aria-label',names[role]+'，'+roleNames[role])}
const panel=$('#panel');
function showPanel(title,html){$('#panel-title').textContent=title;$('#panel-body').innerHTML=html;if(!panel.open)panel.showModal();$('#panel-close').focus()}
function closePanel(){if(panel.open)panel.close()}
$('#panel-close').innerHTML=icon('close');
$('#panel-close').onclick=closePanel;
panel.addEventListener('click',e=>{if(e.target===panel){const r=panel.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closePanel()}});
$('#guide').innerHTML=icon('help',16)+'使用指引';
function esc(value) {
 return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}
function statusLabel(key) {
 const granted=window.teamModel.allowed(key,role);
 return '<span class="badge '+(granted?'':'hold')+'">'+(granted?'已授权':'未授权')+'</span>';
}
function connections(key) {
 const items=key?connectors.filter(item=>item.key===key):connectors;
 const rows=items.map(c=>`<section class="conn"><div class="conn-head"><h3 class="iconline">${icon(c.icon)}${esc(c.name)}</h3>${statusLabel(c.key)}</div><p>${esc(c.description)}</p><small>${esc(window.teamModel.scope(c.key,role))}</small></section>`).join('');
 showPanel(key?'连接器详情':'连接器',`<p class="panel-note">${names[role]} · ${roleNames[role]} · 示例权限</p>${rows}`);
}
function composition() {
 const skillInfo=skills.filter(s=>team.skills.includes(s.key)).map(s=>`<section class="conn"><h3>${esc(s.name)}</h3><small>数据来源 · ${esc(s.source)}</small></section>`).join('');
 const connectorInfo=connectors.filter(c=>team.connectors.includes(c.key)).map(c=>`<section class="conn"><div class="conn-head"><h3>${esc(c.name)}</h3>${statusLabel(c.key)}</div><small>${esc(window.teamModel.scope(c.key,role))}</small></section>`).join('');
 showPanel('专家团组成',`<p class="panel-note">${esc(team.name)} · ${roleNames[role]}</p><h3 class="group-label">技能</h3>${skillInfo}<h3 class="group-label">连接器</h3>${connectorInfo}`);
}
function guide(){
 showPanel('使用指引','<section class="guide-section"><h3>能力中心</h3><p>在同一目录查看专家团、技能和连接器。进入财务核验专家团后，可输入“只核对住宿标准”或“核对附件和供应商主体”。每次结果会列出实际使用的技能、数据来源和受限事项。</p></section><section class="guide-section"><h3>轻应用</h3><p>费用分摊计算器在新窗口使用。上传自包含 HTML 后，可在本浏览器保存并打开个人轻应用。</p><a class="linkbtn" href="amount-total.html" download="报销金额合计.html">下载示例 HTML 应用</a></section><section class="guide-section"><h3>演示身份</h3><p>两种身份可查看的业务范围不同。切换后，可在“连接器”或供应商主体核验中查看本身份的权限。</p><div class="choices">'+Object.keys(names).map(r=>'<button class="secondary" data-role="'+r+'" aria-pressed="'+(r===role)+'">'+names[r]+' · '+roleNames[r]+'</button>').join('')+'</div></section><section class="guide-section"><h3>数据与接入</h3><p>单据、制度、供应商和授权均为示例。任务选择及核对由本地规则执行，企查查使用合成快照。上传的轻应用仅保存在当前浏览器。</p></section><a href="brief.html" target="_blank" rel="noopener">查看调研与 MVP 取舍</a>');
 $('#panel-body').querySelectorAll('[data-role]').forEach(btn=>btn.onclick=()=>{
   role=btn.dataset.role;
   try{sessionStorage.setItem('cxz-demo-role',role)}catch{}
   closePanel();render();$('#guide').focus();
 });
}
$('#guide').onclick=guide;
const groups=[['all','全部'],['teams','专家团'],['skills','技能'],['connectors','连接器']];
function openGroup(id){return id==='all'?'#hub':'#hub/'+id}
function home(section='all') {
 const main=$('#main');
 main.innerHTML=`<div class="pagehead hub-heading"><h1>能力中心</h1></div>
 <div class="hub-controls"><nav class="hub-filters" aria-label="能力类型">${groups.map(([id,label])=>`<a href="${openGroup(id)}" ${id===section?'aria-current="page"':''}>${label}</a>`).join('')}</nav>
 <label class="searchbox">${icon('search',16)}<input type="search" id="search" aria-label="搜索能力" placeholder="搜索名称或用途"></label></div><div id="catalog-results"></div>`;
 const search=$('#search');search.value=searchText;
 search.oninput=()=>{searchText=search.value;fillCatalog(section)};
 fillCatalog(section);
}
function fillCatalog(section) {
 const query=searchText.trim().toLocaleLowerCase();
 const match=text=>text.toLocaleLowerCase().includes(query);
 const hasTeam=(section==='all'||section==='teams')&&match(team.name+team.description+skills.map(s=>s.name).join('')+connectors.map(c=>c.name).join(''));
 const shownSkills=section==='skills'||section==='all'?skills.filter(s=>match('技能'+s.name+s.description+s.source)):[];
 const shownConnections=section==='connectors'||section==='all'?connectors.filter(c=>match('连接器'+c.name+c.description)):[];
 const feature=hasTeam?`<section class="hub-team"><div class="hub-team-copy"><h2>${esc(team.name)}</h2><p>${esc(team.description)}</p><div class="hub-team-actions"><a href="#team" class="primary">${icon('message',16)}使用专家团</a><button id="composition" class="secondary">查看组成</button></div></div><div class="hub-map" aria-hidden="true"><div class="hub-branch"><span>${icon('checklist',18)}技能 <b>${team.skills.length}</b></span><span>${icon('database',18)}连接器 <b>${team.connectors.length}</b></span></div><div class="hub-mascot"><img src="expert.webp" alt=""></div></div></section>`:'';
 function sectionBox(label,items){return items.length?`<section class="hub-group"><div class="sectionbar"><h2>${label}<span class="count">${items.length}</span></h2></div><div class="hub-items">${items.join('')}</div></section>`:''}
 const skillList=sectionBox('技能',shownSkills.map(s=>{
  const blocked=s.connectors.find(c=>!window.teamModel.allowed(c,role));
  const button=blocked?`<button class="hub-action" data-connection="${blocked}">查看权限</button>`:`<a class="hub-action" href="#${s.key}" aria-label="使用${esc(s.name)}">使用</a>`;
  return `<article class="hub-item"><span class="skill-ico ${s.color}">${icon(s.icon,21)}</span><div class="hub-item-text"><h3>${esc(s.name)}</h3><p>${esc(s.description)}</p></div>${button}</article>`;
 }));
 const connList=sectionBox('连接器',shownConnections.map(c=>`<article class="hub-item"><span class="hub-conn-icon">${icon(c.icon,20)}</span><div class="hub-item-text"><h3>${esc(c.name)} ${statusLabel(c.key)}</h3><p>${esc(window.teamModel.scope(c.key,role))}</p></div><button class="hub-action" data-connection="${c.key}" aria-label="查看${c.name}详情">详情</button></article>`));
 $('#catalog-results').innerHTML=feature+(skillList||connList?`<div class="hub-sections ${skillList&&connList?'paired':''}">${skillList}${connList}</div>`:'')||'<p class="empty">没有匹配的能力，请更换关键词。</p>';
 $('#composition')?.addEventListener('click',composition);
 document.querySelectorAll('[data-connection]').forEach(btn=>btn.onclick=()=>connections(btn.dataset.connection));
}
function details(pairs){return '<dl class="details">'+pairs.map(([k,v])=>'<div><dt>'+k+'</dt><dd>'+v+'</dd></div>').join('')+'</dl>'}
function billInfo(b){return details([['申请人','林晓'],['出差行程','上海 ⇄ '+b.city],['行程日期',b.date+'（2 晚）'],['报销金额',money(sum(b))],['材料来源','报销单与已附票据（示例）']])}
function showEvidence(finding) {
 showPanel('核对依据',finding.evidence.map(row=>`<section class="proof"><h3>${esc(row.title)}</h3><small>${esc(row.source)}</small><blockquote>${esc(row.quote)}</blockquote></section>`).join(''));
}
function getChecks(mode,b){
 const items=[];
 if(mode!=='policy')items.push(b.tripSheet?['materials',false,'网约车附件齐全','发票及电子行程单均已随单附上。']:['materials',true,'补充网约车电子行程单','市内交通 '+money(b.taxi)+' 已附发票，附件目录中缺少配套行程单。']);
 if(mode!=='materials')items.push(b.hotel>500?['policy',true,'补充住宿超标说明',money(b.hotel)+'/晚 × 2 晚，适用标准为 '+money(500)+'/晚，合计超出 '+money((b.hotel-500)*2)+'。']:['policy',false,'住宿金额在标准内',money(b.hotel)+'/晚，适用标准为 '+money(500)+'/晚。']);
 return items;
}
function review(key){
 const skill=skills.find(s=>s.key===key);
 const state=memory(key), supplier=key==='supplier';
 const heading=`<a class="back" href="#hub/skills">${icon('back',15)}能力中心</a><div class="pagehead"><h1>${skill.name}</h1></div>`;
 const blocked=skill.connectors.find(c=>!window.teamModel.allowed(c,role));
 if(blocked) {
   $('#main').innerHTML=heading+`<div class="case-box boxbody"><p class="notice">${esc(window.teamModel.scope(blocked,role))}</p><button class="linkbtn" id="why">查看权限</button></div>`;
   $('#why').onclick=()=>connections(blocked);return;
 }
 const records=supplier?suppliers:bills;
 const label=supplier?'供应商':'报销单';
 const options=Object.entries(records).map(([id,v])=>`<option value="${id}">${supplier?esc(v.name):'上海 ⇄ '+v.city+' · '+v.id}</option>`).join('');
 $('#main').innerHTML=heading+`<div class="case-layout"><section class="case-box"><div class="boxbody"><h2>待核${label}</h2><label for="case-choice">选择${label}</label><select class="case-select" id="case-choice"><option value="">请选择示例${label}</option>${options}</select><div id="input-details"></div><button class="primary" id="run">开始核对</button></div><div class="case-footer">${icon('database',16)}${esc(skill.source)}</div></section><section class="case-box boxbody" aria-live="polite" id="result"></section></div>`;
 const select=$('#case-choice');select.value=state.choice;
 function sync(){
   const data=records[state.choice];$('#run').disabled=!data;
   $('#input-details').innerHTML=data?(supplier?details([['核验字段','登记名称、经营状态'],['来源','示例供应商主数据']]):billInfo(data)):'<div class="details"></div>';
   const result=$('#result');
   if(!data||!state.done){result.innerHTML='<h2>核对结果</h2><div class="result-empty">'+icon('file',30)+'等待核对</div>';return}
   const response=window.teamModel.runSkill(key,{role,billKey:supplier?'':state.choice,supplierKey:supplier?state.choice:''},{bills,suppliers,getChecks,money});
   const issues=response.findings.filter(f=>f.issue).length;
   result.innerHTML=`<div class="result-summary"><h2>核对结果</h2><span class="badge ${issues?'hold':''}">${issues?issues+' 项待复核':'所查项目均相符'}</span></div>`+response.findings.map((f,i)=>`<article class="finding"><h3>${esc(f.title)}</h3><p>${esc(f.body)}</p><button class="linkbtn" data-proof="${i}">${icon('file',14)}查看依据</button></article>`).join('');
   result.querySelectorAll('[data-proof]').forEach(btn=>btn.onclick=()=>showEvidence(response.findings[Number(btn.dataset.proof)]));
 }
 select.onchange=()=>{state.choice=select.value;state.done=false;sync()};
 $('#run').onclick=()=>{state.done=true;sync()};sync();
}
function render(){
 const page=location.hash.slice(1)||'hub', apps=page==='apps'||page==='tools';
 if(location.protocol!=='file:' && location.pathname.startsWith('/demos/capability-hub/')){
   const destinations = {
     hub: '#skills?section=teams', expert: '#skills?section=teams', team: '#skills?section=teams',
     'hub/teams': '#skills?section=teams', 'hub/skills': '#skills', 'hub/connectors': '#skills?section=connectors'
   };
   if(Object.hasOwn(destinations,page)){location.replace('/agent.html'+destinations[page]);return;}
 }
 roleHeader();closePanel();
 $('#skills-tab').setAttribute('aria-current',apps?'false':'page');
 $('#tools-tab').setAttribute('aria-current',apps?'page':'false');
 if(apps){window.renderTools($('#main'),role);return}
 if(page==='expert'||page==='team'){
   window.renderTeam($('#main'),{role,names,bills,suppliers,getChecks,money,icon,showPanel,onEvidence:showEvidence,onConnectors:connections});return;
 }
 if(skills.some(s=>s.key===page)){review(page);return}
 const group=page.split('/')[1];home(groups.some(g=>g[0]===group)?group:'all');
}
window.addEventListener('hashchange',()=>{render();scrollTo(0,0);$('#main').focus({preventScroll:true})});
render();
