import * as a from './variant-a.js';
import * as b from './variant-b.js';
import * as c from './variant-c.js';

const variants = {a,b,c};
const descriptions = {a:'A · 小智图标随状态变化，工作清单直接展开',b:'B · 小智更有存在感，用简短回应陪你完成任务',c:'C · 只突出当前动作，过程与细节按需展开'};
const $ = (selector) => document.querySelector(selector);
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const paths = {
  spark:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
  check:'<path d="m5 12 4 4L19 6"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  down:'<path d="m6 9 6 6 6-6"/>',chevron:'<path d="m9 5 7 7-7 7"/>',stop:'<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  alert:'<path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3v.5"/>',file:'<path d="M14 3H5v18h14V8Z"/><path d="M14 3v6h5M8 13h8M8 17h5"/>',
  search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',chart:'<path d="M4 3v17h17M8 15v-4m5 4V7m5 8V4"/>',
  arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  refresh:'<path d="M20 7a8 8 0 1 0 1 8M20 3v5h-5"/>',plus:'<path d="M12 5v14M5 12h14"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',up:'<path d="M12 19V5m-6 6 6-6 6 6"/>',
  book:'<path d="M12 5s-4-3-9-1v15c5-2 9 1 9 1s4-3 9-1V4c-5-2-9 1-9 1ZM12 5v15"/>',chat:'<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z"/>',
  pause:'<path d="M8 5v14M16 5v14"/>',play:'<path d="m8 4 12 8-12 8Z"/>'
};
function icon(name,size=16){return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.spark}</svg>`;}
const stages = [
  {phase:'thinking',title:'正在分析任务',detail:'先确认费用范围，再比较两个月的变化。',statuses:['pending','pending','pending','pending'],duration:3},
  {phase:'working',title:'正在读取费用明细',detail:'识别出差日期、费用类型和报销金额。',statuses:['running','pending','pending','pending'],duration:3},
  {phase:'working',title:'正在核对制度与费用变化',detail:'费用明细已整理，正在核对两个月的归集口径。',statuses:['completed','running','running','pending'],duration:6},
  {phase:'waiting',title:'有一项信息需要你确认',detail:'确认跨月费用口径后，继续比较。',statuses:['completed','completed','pending','pending']},
  {phase:'checking',title:'正在核对比较结果',detail:'按已确认的口径，重新汇总两个月的费用。',statuses:['completed','completed','running','pending'],duration:4},
  {phase:'responding',title:'正在整理分析结果',detail:'已找到主要变化，整理为可核对的费用报告。',statuses:['completed','completed','completed','running'],duration:4},
  {phase:'completed',title:'本轮分析已完成',detail:'费用对比与变化明细已整理。',statuses:['completed','completed','completed','completed']}
];
const stepDefinitions = [
  {id:'read',label:'读取费用明细',detail:'识别费用类型、日期与金额'},
  {id:'policy',label:'核对差旅制度',detail:'查找适用的费用归集口径'},
  {id:'compare',label:'比较9月与10月',detail:'按费用类型查找主要变化'},
  {id:'report',label:'整理费用报告',detail:'保留汇总结果与核对依据'}
];
const param = new URLSearchParams(location.search).get('variant');
const state = {variant:variants[param] ? param : 'a',index:0,override:null,elapsed:0,stageElapsed:0,playing:true,recordOpen:false,answer:'',answerDraft:'',answerNote:'',normalDraft:'',questionDraft:'',copied:false};
let toastTimer,copyTimer;
let lastTrigger;
let composerMode='normal';
function currentView(){
  const stage=stages[state.index];
  return {...stage,phase:state.override || stage.phase,title:state.override === 'failed' ? '制度核对暂时中断' : state.override === 'stopped' ? '已停止处理' : stage.title,elapsed:state.elapsed,steps:stepDefinitions.map((step,index)=>({...step,status:state.override==='failed' && index===1?'failed':stage.statuses[index]})),recordOpen:state.recordOpen,answer:state.answer,copied:state.copied};
}
function figures(){return state.answer==='按报销月份'?{oct:'47,400',sep:'42,600',change:'11.3%',increase:'4,800',hotel:'22,800',transport:'18,000',other:'6,600',hotelSep:'19,800',transportSep:'16,200',otherSep:'6,600'}:{oct:'48,600',sep:'42,000',change:'15.7%',increase:'6,600',hotel:'24,000',transport:'18,000',other:'6,600',hotelSep:'19,200',transportSep:'16,200',otherSep:'6,600'};}
function records(view){
  const occurred=view.steps.filter(step=>step.status!=='pending');
  if(!occurred.length)return '';
  const labels={running:['stopped','failed'].includes(view.phase)?'已中断':'进行中',completed:'已完成',failed:'未成功',pending:'待继续'};
  return `<section class="records"><button class="record-toggle" data-action="records" aria-expanded="${view.recordOpen}" aria-controls="work-records">${icon('chevron',12)}<span>${view.phase==='completed'?'处理记录':'查看工作记录'}</span><span>· ${occurred.length} 项</span></button>${view.recordOpen?`<ol class="step-list" id="work-records" aria-label="工作记录">${occurred.map(step=>`<li class="step-row is-${step.status}"><span class="step-dot">${icon(step.status==='completed'?'check':step.status==='failed'?'alert':'clock',13)}</span><span class="step-copy"><strong>${escape(step.label)}</strong><small>${escape(step.detail)}</small></span><span class="step-meta">${labels[step.status]}</span></li>`).join('')}</ol>`:''}</section>`;
}
function result(view){
  if(!['responding','completed'].includes(view.phase))return '';
  const f=figures();
  return `<div class="assistant-result">${view.answer?`<div class="answer-context">${icon('check',13)}${escape(view.answer)}</div>`:''}${state.answerNote?`<p class="answer-context">补充说明：${escape(state.answerNote)}</p>`:''}<p>10月销售部差旅费合计 <strong>¥${f.oct}</strong>，较9月增加 <strong>¥${f.increase}（${f.change}）</strong>。</p>${view.phase==='completed'?`<p>增加主要来自<strong>住宿费和交通费</strong>。住宿费的变化更明显，建议优先核对出差天数与每晚住宿标准。</p><button class="result-card" data-action="report">${icon('chart',24)}<span><strong>9—10月差旅费用对比</strong><small>按费用类型汇总 · ${escape(view.answer||'按出差月份')}</small></span>${icon('chevron',16)}</button><div class="reply-tools"><button data-action="copy" aria-label="复制分析结论">${icon(view.copied?'check':'copy',13)}<span>${view.copied?'已复制':'复制'}</span></button></div>`:''}</div>`;
}
const ui={escape,icon,mascot:(className='')=>`<img class="${escape(className)}" src="/agent-assets/caixiaozhi.png" alt="" draggable="false">`,records,result,questionNotice:(view)=>view.phase==='waiting'?`<div class="question-notice"><span>确认归集口径后继续。</span><button class="text-action" data-action="focus-question">去回答 ${icon('down',12)}</button></div>`:''};
const style=document.createElement('style');
style.textContent=Object.values(variants).map(item=>item.css).join('\n');document.head.append(style);
document.querySelectorAll('[data-icon]').forEach(item=>{item.innerHTML=icon(item.dataset.icon,16);});

function isRunning(view=currentView()){return !['waiting','completed','failed','stopped'].includes(view.phase);}
function showToast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('#toast').hidden=true;},3200);}
function renderAssistant(){
  const focused=document.activeElement?.closest('[data-action]')?.dataset.action;
  const thread=$('#thread');
  const follow=thread.scrollHeight-thread.scrollTop-thread.clientHeight<70;
  $('#assistant').innerHTML=variants[state.variant].renderAssistant(currentView(),ui);
  if(focused)$('#assistant').querySelector(`[data-action="${focused}"]`)?.focus({preventScroll:true});
  if(follow)thread.scrollTop=thread.scrollHeight;
}
function updateComposer(){
  const view=currentView(),running=isRunning(view),waiting=view.phase==='waiting';
  const nextMode=waiting?'question':'normal';
  if(composerMode!==nextMode){
    state[composerMode==='question'?'questionDraft':'normalDraft']=$('#draft').value;
    $('#draft').value=state[nextMode==='question'?'questionDraft':'normalDraft'];
    composerMode=nextMode;
  }
  $('#question').hidden=!waiting;
  $('#draft').placeholder=waiting?'也可以补充需要关注的内容…':'继续补充需求…';
  document.querySelectorAll('[data-answer]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.answer===state.answerDraft)));
  const send=$('#send');
  send.classList.toggle('is-stop',running);send.innerHTML=icon(running?'stop':'up',17);
  send.setAttribute('aria-label',running?'停止当前任务':waiting?'发送回答':'发送消息');
  send.disabled=waiting?!state.answerDraft:!running&&!$('#draft').value.trim();
  $('#input-hint').textContent=running?'可先写下补充内容':waiting?'选择后发送':'Enter 发送';
  $('#state-note').textContent=waiting?'等待确认，不会自动选择':view.phase==='stopped'?'草稿已保留':view.phase==='failed'?'已完成的步骤已保留':'';
}
function render(){
  $('#product').className=`product-frame variant-${state.variant}`;
  document.querySelectorAll('[data-variant]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.variant===state.variant)));
  $('#variant-note').textContent=descriptions[state.variant];
  const view=currentView();
  $('#playback').textContent=state.playing?'暂停':'播放';
  $('#playback').disabled=!isRunning(view);
  $('#playback').title=state.playing?'暂停预览播放':'继续预览播放';
  $('#jump').value=view.phase==='failed'?'failed':String(state.index===1?0:state.index===4||state.index===5?2:state.index);
  $('#sidebar-status').innerHTML=icon(view.phase==='completed'?'check':view.phase==='failed'?'alert':view.phase==='waiting'?'chat':'clock',12);
  renderAssistant();updateComposer();
  document.body.dataset.motion=document.hidden||!state.playing?'paused':'playing';
}
function advance(index){state.index=index;state.stageElapsed=0;state.override=null;if(index===6){state.recordOpen=false;state.playing=false;}if(index===3)state.playing=false;render();}
function replay(){state.index=0;state.override=null;state.elapsed=0;state.stageElapsed=0;state.playing=true;state.recordOpen=false;state.answer='';state.answerDraft='';state.answerNote='';render();state.questionDraft='';$('#thread').scrollTop=0;}
function openDialog(id){lastTrigger=document.activeElement;$(id).showModal();}
function report(){const f=figures();$('#report-basis').textContent=state.answer||'按出差月份';$('#report-body').innerHTML=`<table class="report-table"><thead><tr><th>费用类型</th><th>9月</th><th>10月</th></tr></thead><tbody><tr><td>住宿费</td><td>¥${f.hotelSep}</td><td>¥${f.hotel}</td></tr><tr><td>交通费</td><td>¥${f.transportSep}</td><td>¥${f.transport}</td></tr><tr><td>其他差旅费</td><td>¥${f.otherSep}</td><td>¥${f.other}</td></tr></tbody><tfoot><tr><td>合计</td><td>¥${f.sep}</td><td>¥${f.oct}</td></tr></tfoot></table><p>以上为交互预览中的固定示例；切换归集口径会展示对应示例金额，不构成实际费用结论。</p>`;openDialog('#report-dialog');}
function send(){const view=currentView();if(isRunning(view)){state.override='stopped';state.playing=false;render();return;}if(view.phase==='waiting'){if(!state.answerDraft)return;state.answer=state.answerDraft;state.answerNote=$('#draft').value.trim();state.playing=true;advance(4);$('#draft').focus();return;}showToast('此预览不发送普通消息，输入已保留。');}
document.addEventListener('click',async(event)=>{
  const variant=event.target.closest('[data-variant]');
  if(variant){state.variant=variant.dataset.variant;history.replaceState(null,'',`?variant=${state.variant}`);render();return;}
  const choice=event.target.closest('[data-answer]');
  if(choice){state.answerDraft=choice.dataset.answer;updateComposer();return;}
  const close=event.target.closest('[data-close]');if(close){$(`#${close.dataset.close}`).close();return;}
  const button=event.target.closest('[data-action]');if(!button)return;
  const action=button.dataset.action;
  if(action==='records'){state.recordOpen=!state.recordOpen;renderAssistant();}
  if(action==='focus-question'){$('[data-answer]')?.focus();$('#question').scrollIntoView({block:'nearest'});}
  if(action==='resume'){state.override=null;state.playing=stages[state.index].phase!=='waiting';render();}
  if(action==='retry'){state.override=null;state.index=2;state.stageElapsed=0;state.playing=true;render();}
  if(action==='defer'){state.override='stopped';state.playing=false;render();}
  if(action==='replay')replay();
  if(action==='help')openDialog('#help-dialog');
  if(action==='report')report();
  if(action==='attachment')showToast('已附：销售部差旅明细.xlsx（示例材料）');
  if(action==='skill')showToast('本轮使用：费用分析。三版采用相同的示例任务。');
  if(action==='copy'){const f=figures();try{await navigator.clipboard.writeText(`示例数据｜10月销售部差旅费 ¥${f.oct}，较9月增加 ¥${f.increase}（${f.change}）。口径：${state.answer||'按出差月份'}。`);state.copied=true;renderAssistant();clearTimeout(copyTimer);copyTimer=setTimeout(()=>{state.copied=false;renderAssistant();},2000);}catch{showToast('复制未完成，可以选择正文复制。');}}
});
$('#replay').addEventListener('click',replay);
$('#playback').addEventListener('click',()=>{state.playing=!state.playing;render();});
$('#jump').addEventListener('change',(event)=>{state.recordOpen=false;state.elapsed=0;state.stageElapsed=0;if(event.target.value==='failed'){state.index=2;state.override='failed';state.playing=false;}else{state.index=Number(event.target.value);state.override=null;state.playing=![3,6].includes(state.index);if(state.index>=4)state.answer=state.answer||'按出差月份';}render();});
$('#send').addEventListener('click',send);
$('#draft').addEventListener('input',updateComposer);
$('#draft').addEventListener('keydown',(event)=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!isRunning()&&!$('#send').disabled)send();}});
document.querySelectorAll('dialog').forEach(dialog=>{dialog.addEventListener('close',()=>lastTrigger?.focus({preventScroll:true}));dialog.addEventListener('click',event=>{if(event.target===dialog){const bounds=dialog.getBoundingClientRect();if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)dialog.close();}});});
document.addEventListener('visibilitychange',()=>{document.body.dataset.motion=document.hidden||!state.playing?'paused':'playing';});
setInterval(()=>{if(!state.playing||document.hidden||!isRunning())return;state.elapsed++;state.stageElapsed++;document.querySelectorAll('[data-elapsed]').forEach(node=>{node.textContent=`${state.elapsed} 秒`;});if(state.stageElapsed>=stages[state.index].duration)advance(state.index+1);},1000);
render();
