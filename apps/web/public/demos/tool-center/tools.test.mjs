import test from 'node:test';
import assert from 'node:assert/strict';
import {mountTool,clearToolCache} from './tools.js';
import {createSeed,USERS,canUse} from './model.js';

function mount(id) {
  clearToolCache(); const elements = new Map();
  const root = {innerHTML:'',querySelector(selector){if(!elements.has(selector))elements.set(selector,{focus(){}});return elements.get(selector)},querySelectorAll(selector){if(selector==='[data-file]'){const input=this.querySelector('[data-file]');input.dataset={file:'input'};return [input];}return []}};
  const state = createSeed(); const activities = []; const notices = [];
  mountTool(root,id,{getCurrentUser:()=>USERS.finance,getApps:()=>state.apps,canUse:app=>canUse(app,USERS.finance),toast:message=>notices.push(message),addActivity:value=>activities.push(value),navigate(){}});
  return {root,activities,notices};
}
for (const id of ['reconcile','convert','report']) {
  test(`${id} 默认不装载示例、不生成结果，空输入不能计算`, () => {
    const {root,activities} = mount(id);
    assert.doesNotMatch(root.innerHTML,/示例数据|银行流水_2026|费用台账_待转换|费用明细_2026/);
    assert.match(root.innerHTML,/未选择文件/);
    root.querySelector('[data-run]').onclick();
    assert.match(root.innerHTML,/请选择.*文件/);
    assert.equal(activities.length,0);
    assert.match(root.innerHTML,/data-export disabled/);
  });
}
test('显式示例操作只载入输入，点击执行才产生真实计算和活动摘要', () => {
  const {root,activities} = mount('report');
  assert.equal(typeof root.__toolGuideAction,'function');
  root.__toolGuideAction('load-sample');
  assert.match(root.innerHTML,/示例数据/); assert.equal(activities.length,0);
  assert.match(root.innerHTML,/data-export disabled/);
  root.querySelector('[data-run]').onclick();
  assert.match(root.innerHTML,/77,200\.00/); assert.equal(activities.length,1);
  assert.match(root.innerHTML,/10 笔有效记录/);
});

test('选择无效新文件后不能沿用之前的示例或结果继续计算', async () => {
  const {root,activities} = mount('report');
  root.__toolGuideAction('load-sample');
  root.querySelector('[data-run]').onclick();
  const input=root.querySelector('[data-file]');
  input.files=[{name:'broken.txt',size:20,text:async()=>''}];
  await input.onchange();
  root.querySelector('[data-run]').onclick();
  assert.equal(activities.length,1);
  assert.match(root.innerHTML,/请选择待处理的 CSV 文件/);
  assert.match(root.innerHTML,/data-export disabled/);
});
