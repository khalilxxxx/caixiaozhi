# 公开真实财报实施计划

> 执行采用 subagent-driven-development，由后端子任务与主会话集成协作完成，任务完成后独立审阅。用户已确认方案并授权决定后续细节。

**目标** 使用海康威视正式年报披露的 2023—2025 年度合并财务数据，完成真实查询、快照报告与离线导出。

**架构** React 复用现有应用及报告容器，FastAPI 与 Agno 共用 `financial_analytics.py`，SQLite 工作空间保存不可变报告。公开数据采用经过校验的法定披露原始 PDF 快照。

**技术栈** Python、FastAPI、Agno、SQLite、React、TypeScript、现有 CSS 与 SVG 图表。

**设计依据** `docs/superpowers/specs/2026-11-17-public-financial-reports-design.md`。

## 全局约束

- 用户界面与交付说明使用中文，沿用现有视觉与默认收起的使用指引。
- 用户指定海康威视，2025 年报 `1225123062` 和 2024 年报 `1223153152`，覆盖 2023—2025 年度；2023 比较期采用已重述值。
- 八项核心指标与完整利润勾稽组成使用整数分计算，接口保留人民币元两位小数，图表使用亿元。
- 页面与对话共享服务端计算，报告保留生成时完整快照。
- 保留原有工作区未提交修改，直接在当前工作区完成可运行成果，不提交其他任务的文件。

## 审阅重点

- 年度区间及同一申报过滤，拒绝季度值或累计期混入。
- 缺少比较期、未知指标或年份时不返回默认替代结果。
- 原始快照被修改或缺失时报告清晰错误，已有报告可独立重开。
- 工作空间 PATCH 不得覆盖报告，重试不会意外改变已有快照。
- 财年快速切换和网络错误不呈现上一年的结果，HTML 离线图表完整且用户文本转义。

## 统一接口

核心指标 ID 为 `revenue`、`costOfRevenue`、`researchAndDevelopment`、`sellingGeneralAndAdministrative`、`operatingIncome`、`netIncome`、`attributableNetIncome`、`operatingCashFlow`。其中 netIncome 为合并净利润，attributableNetIncome 为归母净利润。

`query_financials(year=2025, metric=None)` 返回以下 JSON 字段。

- `dataset` 包含 `id`、`version`、`label`、`entity`、`currency`、`displayUnit`、`years` 及 `source`。`source` 包含 `provider`、`url`、`filingUrl`、`accession`、`filedAt`、`retrievedAt`、`sha256`。
- `year` 及 `period`，后者包含 `start`、`end`、`label`。
- `metrics` 为八项指标或指定指标列表，每项包含 `id`、`label`、`value`、`previousValue`、`yoy`（百分数或 null）、`concept`、`unit`。
- `totals` 包含八项原值、`operatingExpenses`（研发加销管）、`totalCosts`、`grossProfit`、`operatingMargin`、`netMargin` 及销售、管理、财务、税费和其他营业损益净额原值。totalCosts 仅表示三项成本费用合计，otherOperatingNet 为营业利润与营收减三项费用的差额计算项。
- `trend` 包含三年记录，每条包含 `year`、`periodStart`、`periodEnd`、八项指标、`totalCosts`、`operatingMargin`。
- `findings` 为 `{title,text}[]`，`limitations` 为字符串数组，`cards` 为现有界面卡，使用 `kind: analysis`、`data: {publicFinance:true,year}`。

`create_report(store, year=2025)` 返回 `{report,cards}`，报告含 `id`（`public-report-` 前缀）、`title`、`createdAt`、`version:1`、`snapshot`（移除 cards 的完整查询结果）。报告保存在受保护的 `publicFinancialReports` 字典。

HTTP 使用 `/api/local/analytics/public` 前缀。

- `GET /query?year=2025&metric=revenue` 直接返回查询对象。
- `GET /reports` 返回 `{reports:[报告元数据]}`，元数据含 `id,title,createdAt,year,version,datasetVersion`。
- `POST /reports` 接收 `{year:2025}`，返回 `{report,cards}`。
- `GET /reports/{id}` 返回 `{report}`，缺失结果报错。

## 任务 1 公开数据与服务端

文件为 `apps/agno-service/financial_analytics.py`、`apps/agno-service/data/`、`scripts/demos/fetch-public-financials.py`、`apps/agno-service/server.py`、`apps/agno-service/store.py` 和对应测试。

- [ ] 先写并运行回归测试，覆盖官方三年原值、勾稽、同比缺基期、未知参数、校验损坏及报告持久化保护。
- [ ] 获取官方年报原始 PDF 与哈希，提取并渲染核对合并报表页面、三年原值及重述情况。
- [ ] 实现上述查询、报告快照、HTTP 与 PATCH 保护接口。
- [ ] 运行后端相关测试并记录结果，独立审阅数据来源与实现。

## 任务 2 页面、对话与报告

文件为 `PublicFinancials.tsx`、`public-financials.css`、`public-financials-model.ts`、`Analytics.tsx`、`App.tsx`、`Chat.tsx`、`capability-model.ts`、`agent_runtime.py` 和有必要的定向测试。

- [ ] 为报告 HTML 转义、单位格式、财报卡与工具执行补充定向回归测试并先运行失败。
- [ ] 数据分析默认打开公开财报，提供财年筛选、指标、三年趋势、成本费用、指标明细和已生成报告。
- [ ] 对话加入真实查询与生成工具，明确旧费用分析的合成来源，默认示例采用公开财报。
- [ ] 复用现有报告容器，按快照展示摘要、指标、图表、解读、边界与来源，导出独立 HTML 和原币种原值 CSV。
- [ ] 类型检查、构建及定向测试通过，独立审阅集成与错误处理。

## 任务 3 端到端验收与交付

- [ ] 重启本地服务，实际执行公开财报页面与模型对话查询及报告生成。
- [ ] 检查桌面与窄屏、两个财年快照、刷新恢复、下载和来源链接。
- [ ] 导出海康威视 2025 年度报告与三年指标 CSV，保存必要验证证据。
- [ ] 独立审阅本轮变更，修复影响结果正确性的缺陷后运行最终验证。
- [ ] 更新交付说明，写明来源、DB-GPT 参考范围、已验证流程和数据覆盖边界。

## 用户补充后的数据契约

数据集使用 `cninfo-hikvision-2025`，币种 `CNY`，显示单位“亿元”，期间标签“年度”。来源包含两份年报 documents 与各年/指标 sources 的物理页码。查询卡携带数据集版本及完整查询快照，历史来源不能被新默认数据源替换。2023 重述原因和当年缺少可比基期需明确显示。
