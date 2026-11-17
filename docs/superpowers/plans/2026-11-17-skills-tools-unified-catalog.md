# 技能工具统一目录实施计划

> 执行方式：使用 superpowers:subagent-driven-development，按独立文件分工实施并交叉复核。用户已要求恢复后继续，沿已选方案持续推进。

**目标：** 一个目录查找和使用技能与工具，维护审核进入管理区域，统一视觉，全部教程与示例进入右下角指引。

**架构：** 保留技能工作区状态和旧工具本地模型，增加类型化工具目录适配器；React 统一目录、管理表格及详情，旧工具仅承载原有工具执行与管理操作，不再嵌套目录导航。沿用 React/TypeScript/Vite 和现有确定性计算逻辑。

**方案：** docs/superpowers/specs/2026-11-17-skills-tools-unified-catalog-design.md

## 全局约束

- 中文业务文案；沿用中性灰白与珊瑚红主操作，不添加页面教学副标题。
- 当前目录包含大量未提交开发成果，在现有工作区按文件隔离任务，不创建缺少这些成果的干净分支，不提交用户的已有改动。
- 技能与工具权限由原来源判定；不新增服务端授权，不授予额外权限，不伪装结果持久化。
- 上传技能和工具保持宽居中弹窗；详情使用右侧抽屉；上传 HTML 的隔离保留。
- 功能保留：上传、版本、下载、分享、访问申请、审核、发布、停用、真实文件执行与结果。

## 复核重点

- 已发布版本存在新草稿时，目录和会话选择仍使用已发布版本。
- 无权限、包检查受阻、只读资料不显示可用动作。
- 旧分享链接、管理往返、搜索收藏和滚动状态恢复。
- 浏览器工具默认无示例；主动加载示例后仍显示真实来源；不存在文件时不能执行假结果。
- 390/768/1280/1440 宽视口的导航、表格、弹层、右下角指引与滚动。

## 任务一：工具适配与运行工作区

负责文件：新建 tool-catalog.ts、ToolDetailPanel.tsx，修改 ToolCenterEmbed.tsx、tool-center-embed.css、public/demos/tool-center/*；相关行为测试。

接口：useToolCatalog() 返回 {items,identity,canUpload,canReview,loading,error,refresh,toggleFavorite}。条目包括 id/name/description/category/icon/version/owner/status/latestVersion/latestStatus/favorite/canUse/canManage/canReview/canView/updatedAt/sourceLabel。CSV费用汇总作为 expense-summary 条目进入同一目录。工具身份由原模型读取，导出 setToolPersona(id)。ToolCenterEmbed 接受 route:string、onBack:()=>void。路由支持 tool/id、manage/id、review/id、edit/id、share/id、request/id、upload、requests。ToolDetailPanel 接受 id:string，使用宿主右侧详情。

- [x] 对目录权限、发布/待审版本、收藏及旧链接写必要行为测试并确认失败。
- [x] 实现适配器，复用原 model.js，不复制授权逻辑，不重置本地资产。
- [x] 去除嵌入目录外壳，运行及管理沿用现有函数；同步路由/尺寸并统一灰白珊瑚色。
- [x] 示例默认空白；页面示例控件迁入右下角指引。只在用户明确加载后使用示例。
- [x] 运行相关工具模型/管理/计算测试。

## 任务二：统一目录和管理

负责文件：Skills.tsx、新建 skills-catalog.css、必要的状态模型与测试；不改 App/Supporting/旧工具文件。

消费任务一接口。宿主路由：#skills 目录；#skills?view=manage 管理；附加 tool=id&action=tool/manage/review/edit/share/request 进入工具工作区；旧 tab=tools 无tool映射工具筛选，有tool仍打开工具。

- [x] 覆盖已发布版本选择、可用性、不可见资产与筛选状态恢复的必要行为测试。
- [x] 一套搜索/类型/分类/收藏、统一卡片，主要动作区分在对话中使用与打开工具。
- [x] 独立管理表格按我创建的/审核发布组织，统一列出技能与工具，保留原有操作。
- [x] 技能卡片/详情状态与真正 available 条件一致，发布状态与运行状态分离。
- [x] 审核进行中不标完成；创作者管理与演示审核入口分开，继续保留演示权限标识。
- [x] 统一样式、响应式、焦点、空态和错误，保持草稿/附件。

## 任务三：宿主指引与集成

主线程负责 Supporting.tsx、必要 App.tsx、ExpenseSummaryTool.tsx、指引组件、文档与最终验收。

- [x] 增加与技能工具页面匹配的右下角指引内容；示例CSV下载、旧工具示例和演示身份切换由此进入。
- [x] 关闭重复帮助，修正脚本执行说明；上传中的指引不清除原表单草稿。
- [x] 运行 tsc、Vite build、相关单元测试；启动现有本地服务进行浏览器走查。
- [x] 桌面和窄屏一轮集中检查，修复后复核；独立代码审查；更新交付与设计文档。

验收记录：`docs/verification/2026-11-17-skills-tools-unified-catalog.md`。本轮前端相关测试 60/60、旧工具测试 55/55、类型检查与构建通过；已检查 390、768、1280、1440 宽视口。独立审查发现的空会话、工具上传草稿丢失、CSV 目录上下文丢失及目录刷新后会话目标丢失均已修复。
