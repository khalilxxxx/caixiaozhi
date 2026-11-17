import test from 'node:test';
import assert from 'node:assert/strict';
import * as manage from './manage.js';

function storage() {
  const values=new Map();
  return {get length(){return values.size},key(index){return [...values.keys()][index]??null},getItem(key){return values.get(key)??null},setItem(key,value){values.set(key,String(value))},removeItem(key){values.delete(key)}};
}
const draft={name:'部门费用工具',description:'按成本中心核对费用',version:'1.0.0',category:'数据核对',maintainer:'林晓',visibility:'finance',code:'<html><body>已选择文件</body></html>',filename:'部门费用.html',sample:false};
test('上传草稿在iframe模块重载后恢复全部字段与文件内容',async()=>{
  const session=storage();
  assert.equal(typeof manage.writeUploadDraft,'function');
  manage.writeUploadDraft('finance:new::',draft,session);
  const reopened=await import('./manage.js?reopened-draft');
  assert.deepEqual(reopened.readUploadDraft('finance:new::',session),draft);
});
test('不同身份和资产草稿隔离，提交后仅清理对应草稿',()=>{
  const session=storage();
  assert.equal(typeof manage.writeUploadDraft,'function');
  manage.writeUploadDraft('finance:new::',draft,session);
  manage.writeUploadDraft('finance:reconcile:1.2.0:published',{...draft,name:'核对新版本'},session);
  manage.writeUploadDraft('admin:new::',{...draft,name:'管理员草稿'},session);
  manage.removeUploadDraft('finance:new::',session);
  assert.equal(manage.readUploadDraft('finance:new::',session),null);
  assert.equal(manage.readUploadDraft('finance:reconcile:1.2.0:published',session).name,'核对新版本');
  assert.equal(manage.readUploadDraft('admin:new::',session).name,'管理员草稿');
});
test('损坏或不可读取的草稿不会被读操作清空或覆盖',()=>{
  const session=storage();
  assert.equal(typeof manage.writeUploadDraft,'function');
  manage.writeUploadDraft('finance:new::',draft,session);
  const key=session.key(0); session.setItem(key,'{unreadable');
  assert.throws(()=>manage.readUploadDraft('finance:new::',session),/草稿/);
  assert.equal(session.getItem(key),'{unreadable');
  assert.throws(()=>manage.readUploadDraft('finance:new::',{getItem(){throw new Error('blocked')}}),/blocked/);
});
