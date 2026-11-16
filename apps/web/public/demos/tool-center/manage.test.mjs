import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewTransition, publishTransition, sharingFormState, permissionTransition, SAMPLE_HTML } from './manage.js';

const author = { id:'finance',name:'林晓',role:'author' };
const business = { id:'business',name:'周敏',role:'business' };
const technical = { id:'technical',name:'陈屿',role:'technical' };
const admin = { id:'admin',name:'许宁',role:'admin' };
const app = { id:'example',name:'示例',version:'1.0.0',owner:'林晓',ownerId:'finance',status:'review',visibility:'all',userIds:[],useScope:'finance',useUserIds:[],reviews:{business:'pending',technical:'pending'} };
const fullyReviewed = () => reviewTransition(reviewTransition(app,'business','approved','口径确认',business),'technical','approved','检查完成',technical);

test('提交人不能审核', () => assert.throws(() => reviewTransition(app,'business','approved','',author)));
test('技术身份不能业务审核', () => assert.throws(() => reviewTransition(app,'business','approved','',technical)));
test('驳回原因必填', () => assert.throws(() => reviewTransition(app,'business','rejected','  ',business)));
test('单审不能发布', () => assert.throws(() => publishTransition(reviewTransition(app,'business','approved','口径确认',business),admin)));
test('双审可发布且原对象不变', () => {
  assert.equal(publishTransition(fullyReviewed(),admin).status,'published');
  assert.equal(app.reviews.business,'pending');
});
test('非管理员不能发布', () => assert.throws(() => publishTransition(fullyReviewed(),business)));
test('驳回后两轨锁定', () => {
  const rejected = reviewTransition(app,'business','rejected','缺少异常处理',business);
  assert.throws(() => reviewTransition(rejected,'technical','approved','',technical));
  assert.throws(() => publishTransition(rejected,admin));
});
test('同一轨不可重复审核', () => {
  const reviewed = reviewTransition(app,'business','approved','',business);
  assert.throws(() => reviewTransition(reviewed,'business','rejected','修订',business));
});
test('修订审核保留当前发布版本', () => {
  const active = {...fullyReviewed(),status:'published',pendingRevision:{...app,version:'1.1.0'}};
  const reviewed = reviewTransition(active,'business','approved','',business);
  assert.equal(reviewed.version,'1.0.0');
  assert.equal(reviewed.status,'published');
  assert.equal(reviewed.pendingRevision.reviews.business,'approved');
});
test('修订发布归档旧版本', () => {
  const active = {...fullyReviewed(),status:'published',pendingRevision:{...fullyReviewed(),version:'1.1.0'}};
  const published = publishTransition(active,admin);
  assert.equal(published.version,'1.1.0');
  assert.equal(published.history[0].version,'1.0.0');
  assert.equal(published.pendingRevision,null);
});
test('示例HTML提供计算控件与脚本', () => {
  assert.match(SAMPLE_HTML,/<script>/);
  assert.match(SAMPLE_HTML,/<\/script>/);
  assert.match(SAMPLE_HTML,/分摊金额/);
});
test('内置工具上传HTML修订后发布为自定义工具', () => {
  const active = {...fullyReviewed(),id:'reconcile',builtIn:true,status:'published',pendingRevision:{...fullyReviewed(),version:'2.0.0',builtIn:false,code:SAMPLE_HTML}};
  const published = publishTransition(active,admin);
  assert.equal(published.builtIn,false);
  assert.equal(published.id,'reconcile');
  assert.equal(published.code,SAMPLE_HTML);
  assert.equal(published.history[0].builtIn,true);
});
test('存量HTML修订漏写builtIn也不会调用旧内置页', () => {
  const active = {...fullyReviewed(),builtIn:true,status:'published',pendingRevision:{...fullyReviewed(),version:'2.0.0',code:SAMPLE_HTML}};
  assert.equal(publishTransition(active,admin).builtIn,false);
});
test('修订提交后撤回人员权限，发布不恢复旧授权', () => {
  const currentPermissions = {visibility:'selected',userIds:['finance'],useScope:'selected',useUserIds:['finance']};
  const active = {...fullyReviewed(),status:'published',...currentPermissions,pendingRevision:{...fullyReviewed(),version:'2.0.0',code:SAMPLE_HTML,visibility:'all',userIds:['employee'],useScope:'all',useUserIds:['employee']}};
  const published = publishTransition(active,admin);
  for (const key of Object.keys(currentPermissions)) assert.deepEqual(published[key],currentPermissions[key]);
  assert.equal(published.version,'2.0.0');
  assert.deepEqual(published.history[0].useUserIds,['finance']);
});
test('停用期间收回权限，发布新版本也不恢复已撤销成员', () => {
  const currentPermissions = {visibility:'finance',userIds:[],useScope:'selected',useUserIds:['business']};
  const disabled = {...fullyReviewed(),status:'disabled',...currentPermissions,pendingRevision:{...fullyReviewed(),version:'2.0.0',code:SAMPLE_HTML,visibility:'all',userIds:[],useScope:'selected',useUserIds:['business','employee']}};
  const published = publishTransition(disabled,admin);
  for (const key of Object.keys(currentPermissions)) assert.deepEqual(published[key],currentPermissions[key]);
  assert.equal(published.status,'published');
  assert.equal(disabled.status,'disabled');
});
test('全体可见、财务可用正确回显财务范围', () => {
  assert.deepEqual(sharingFormState(app),{visibility:'all',viewIds:[],useMode:'finance',useIds:[]});
});
test('指定使用成员正确回显且集合顺序不影响相同范围判定', () => {
  const selected = {...app,visibility:'selected',userIds:['finance','employee'],useScope:'selected',useUserIds:['employee','finance']};
  assert.equal(sharingFormState(selected).useMode,'inherit');
  const partial = {...selected,useUserIds:['employee']};
  assert.equal(sharingFormState(partial).useMode,'selected');
  assert.deepEqual(sharingFormState(partial).useIds,['employee']);
});
test('隐藏的旧成员列表在财务范围下不产生额外授权', () => {
  const stale = {...app,visibility:'finance',userIds:['employee'],useScope:'finance',useUserIds:['employee']};
  assert.deepEqual(sharingFormState(stale),{visibility:'finance',viewIds:[],useMode:'inherit',useIds:[]});
});
test('从指定王晨切换财务范围，保存后清空两份隐藏列表', () => {
  const selected = {...app,visibility:'selected',userIds:['employee'],useScope:'selected',useUserIds:['employee']};
  const updated = permissionTransition(selected,{visibility:'finance',viewIds:['employee'],useMode:'finance',useIds:['employee']},author);
  assert.equal(updated.visibility,'finance');
  assert.equal(updated.useScope,'finance');
  assert.deepEqual(updated.userIds,[]);
  assert.deepEqual(updated.useUserIds,[]);
});
test('继承范围也不会保存隐藏旧名单', () => {
  const updated = permissionTransition(app,{visibility:'all',viewIds:['employee'],useMode:'inherit',useIds:['employee']},author);
  assert.equal(updated.useScope,'all');
  assert.deepEqual(updated.userIds,[]);
  assert.deepEqual(updated.useUserIds,[]);
});
test('使用者不能超出可查看成员', () => {
  assert.throws(() => permissionTransition(app,{visibility:'finance',viewIds:[],useMode:'selected',useIds:['employee']},author));
});
test('非维护者不能修改授权', () => {
  assert.throws(() => permissionTransition(app,{visibility:'all',viewIds:[],useMode:'inherit',useIds:[]},technical));
});
