import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeed,USERS,canDiscover,canUse,allowedByScope,safeState} from './model.js';

test('员工能发现财务工具但不能直接使用，公共转换工具可使用',()=>{
 const state=createSeed();
 assert.equal(canDiscover(state.apps[0],USERS.employee),true);
 assert.equal(canUse(state.apps[0],USERS.employee),false);
 assert.equal(canUse(state.apps[1],USERS.employee),true);
});
test('未发布和停用状态对维护人及管理员同样禁用',()=>{
 for(const status of ['draft','review','rejected','disabled']){
  const app={...createSeed().apps[0],status};
  assert.equal(canUse(app,USERS.finance),false);
  assert.equal(canUse(app,USERS.admin),false);
 }
});
test('使用权限不能绕过查看权限',()=>{
 const app={...createSeed().apps[0],visibility:'selected',userIds:['business'],useScope:'all'};
 assert.equal(canUse(app,USERS.employee),false);
 assert.equal(canUse(app,USERS.business),true);
});
test('财务范围不受历史隐藏成员勾选影响',()=>{
 assert.equal(allowedByScope('finance',['employee'],USERS.employee),false);
 assert.equal(allowedByScope('finance',['employee'],USERS.business),true);
 assert.equal(allowedByScope('selected',['employee'],USERS.employee),true);
 assert.equal(allowedByScope('unknown',['employee'],USERS.employee),false);
});
test('指定人员授权撤销后立即生效',()=>{
 const app={...createSeed().apps[0],useScope:'selected',useUserIds:['employee']};
 assert.equal(canUse(app,USERS.employee),true);
 app.useUserIds=[];
 assert.equal(canUse(app,USERS.employee),false);
});
test('修订审核中不影响正式版本，正式版本停用仍不可用',()=>{
 const app={...createSeed().apps[0],pendingRevision:{status:'review',version:'2.0.0'}};
 assert.equal(canUse(app,USERS.finance),true);
 app.status='disabled';
 assert.equal(canUse(app,USERS.finance),false);
});
test('空或破损存储可恢复初始数据',()=>{
 for(const value of [null,{}, {schema:1,apps:[]}])assert.equal(safeState(value).apps.length,5);
 const state=createSeed();state.persona='invalid';delete state.activities;
 assert.equal(safeState(state).persona,'finance');assert.deepEqual(state.activities,[]);
});
