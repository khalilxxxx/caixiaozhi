# 简化报销与小工具实施计划

目标：完成用户授权的无查验报销流程和一个能被 Agent 调用的 CSV 费用汇总工具。
设计：`docs/superpowers/specs/2026-11-17-simple-agent-flow-design.md`。
约束：中文说明；不引入 Agno 高级能力；保留右侧填单抽屉；不重置业务数据；不执行上传代码。

## 工作分配

- [x] 后端材料与规则：`business.py`、`store.py`、`seed.json`、新增`material_service.py`及测试。移除validInvoice检查和持久规则；实现真实文本提取与待核对费用保存。
- [x] 材料前端：`Documents.tsx`、`material-import.ts`、规则和提单相关前端及测试。提取、编辑核对、转入草稿，清理查验展示。不得修改App、workspace、runtime-client、Skills、ToolCenterEmbed。
- [x] CSV小工具：新增`expense_summary.py`及测试、`ExpenseSummaryTool.tsx`及样式、修改`ToolCenterEmbed.tsx`。不得修改server、agent_runtime、store。
- [x] 主线程集成：`server.py`、`agent_runtime.py`、`App.tsx`、`workspace.tsx`及路由/卡片。接口连接、运行迁移、真实模型与浏览器验证。
- [x] 独立复核与交付：全套相关测试、类型检查、构建、实际上传到提交、CSV页面/对话/重启恢复；更新运行说明。

## 进度与裁决

- 工作区不是 Git 仓库，采用 `artifacts/flow-simple-20261117/before` 源码备份与SQLite一致性备份；不初始化仓库。
- 用户已自行确定流程并将工具选择交由实施方，直接执行，不重复征求方案批准。
- 三个实施区域文件所有权隔离，可并行；所有公共接口由主线程集成。
- 2026-11-17：实施开始。

- 2026-11-17：独立复核发现的同文件多费用误判、跨选区覆盖手改、材料引用丢范围均已修复并定向复核通过。
- 真实模型提取80.50元及CSV汇总30.00元通过；浏览器已提交80.50元并获得本地回执，CSV页面、下载、刷新、卡片跳转及390/1440布局通过。浏览器首次提交已成功，验收脚本的旧成功文案断言已修正，并以回执API复核。
- 当前共享工作空间354项后端测试、260项前端测试、类型检查与构建通过；部署保留原会话/文件/回执。正式5190示例汇总78.00元。隔离验收服务5192/5193已停止。证据见 artifacts/flow-simple-20261117/final-verification.json。
