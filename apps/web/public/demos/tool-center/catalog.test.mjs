import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from './model.js';

const snapshot = state => {
  assert.equal(typeof model.getToolCatalog, 'function', '原工具模型必须提供目录快照');
  return model.getToolCatalog(state);
};
test('统一目录沿用员工权限，CSV费用汇总作为可收藏普通条目', () => {
  const state = model.createSeed(); state.persona = 'employee'; state.favorites.push('expense-summary');
  const result = snapshot(state);
  assert.equal(result.identity.id, 'employee');
  assert.equal(result.canReview, false); assert.equal(result.canUpload, false);
  assert.equal(result.items.find(item => item.id === 'reconcile').canUse, false);
  assert.equal(result.items.find(item => item.id === 'convert').canUse, true);
  assert.equal(result.items.find(item => item.id === 'expense-summary').favorite, true);
  assert.equal(result.items.some(item => item.status === 'draft'), false);
});
test('目录保留发布版本，独立记录新修订版本且不改变原状态', () => {
  const state = model.createSeed();
  state.apps[0].pendingRevision = { version:'2.0.0', status:'review', name:'修订名称', reviews:{business:'pending',technical:'pending'} };
  const item = snapshot(state).items.find(item => item.id === 'reconcile');
  assert.equal(item.name, '两表核对'); assert.equal(item.version,'1.2.0');
  assert.equal(item.status,'published'); assert.equal(item.canUse,true);
  assert.equal(item.latestVersion,'2.0.0'); assert.equal(item.latestStatus,'review');
  assert.equal(state.apps[0].version,'1.2.0');
});
test('隐藏资产不泄漏给普通用户，审核身份保留真实审核访问', () => {
  const state = model.createSeed(); state.persona = 'employee';
  state.apps[0].visibility = 'selected'; state.apps[0].userIds = ['finance'];
  assert.equal(snapshot(state).items.some(item => item.id === 'reconcile'), false);
  state.persona = 'technical';
  const result = snapshot(state);
  assert.equal(result.canReview,true);
  assert.equal(result.items.find(item => item.id === 'reimbursement-check').canReview,true);
  assert.equal(result.items.find(item => item.id === 'reconcile').canView,false);
});
test('目录收藏写回既有状态并保留上传资产及审核记录', () => {
  const state = model.createSeed(); state.apps.push({...state.apps[0],id:'custom-one',name:'自有资产'});
  const storage = { value:JSON.stringify(state), getItem(){return this.value}, setItem(key,value){this.value=value} };
  assert.equal(typeof model.toggleToolFavorite,'function');
  model.toggleToolFavorite('expense-summary',storage);
  const after = JSON.parse(storage.value);
  assert.equal(after.apps.at(-1).id,'custom-one'); assert.deepEqual(after.apps[0].reviews,state.apps[0].reviews);
  assert.equal(after.favorites.includes('expense-summary'),true);
  model.toggleToolFavorite('expense-summary',storage);
  assert.equal(JSON.parse(storage.value).favorites.includes('expense-summary'),false);
});
