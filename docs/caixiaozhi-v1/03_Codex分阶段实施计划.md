# 财小智 v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 上述是配有相应技能的执行器约定。若 Codex 环境没有这些技能，直接按本文件的任务、检查项和验收标准执行，不需要为此安装额外插件或停止开发。用户交付当前模块时，视为授权完成该模块当前阶段。

**Goal:** 交付真实服务端 dsh 财务助理，以及支持八条完整业务旅程的简易业务系统 Demo。

**Architecture:** 自有 B/S 前端经 API 访问会话与领域服务；dsh 在按需独占的 Worker 执行槽内运行，经受控工具网关调用财务能力。PostgreSQL 保存产品和业务状态，dsh 会话存储保存运行日志，外部写入使用统一动作账本与回执。

**Tech Stack:** TypeScript、React/Vite、Fastify、PostgreSQL/Drizzle、dsh TypeScript SDK、SSE、私有 S3 兼容文件服务、Vitest、Playwright；精确版本在技术验证后锁定。

**Spec:** 本目录 `01_总体架构与公共契约.md`、`02_联调验收与演示数据.md` 和 M01–M15 各模块详设。计划引用模块规格，不以任务简写覆盖规格。

## Global Constraints

- M01–M07、M13–M14 为产品级范围；M08–M12、M15 为简易可运行 Demo。
- 首期模型/工具运行路线固定 dsh，所有原生 SDK 差异封装在 AgentRuntimeAdapter。
- 金额使用 `{amount_minor:string,currency:'CNY'}`；时间 UTC 保存、Asia/Shanghai 展示和业务日统计。
- 身份只由服务端认证产生；平台管理员不自动拥有员工业务数据权限。
- 同一 thread 同时最多一个非终结 run；等待状态要持久化并释放计算槽。
- 提交、审批、退回、发布等有影响操作必须确认、版本校验、幂等、回执核实。
- 首页不自动创建聊天卡；对话概要引导，右抽屉完成详情和操作，结果回到对话。
- 业务数据只能有一个权威来源；未实现依赖不得伪造成功。
- 产品环境禁用 demo 登录、seed/reset、业务时钟和故障注入。

## Review Focus

1. 写入成功但回包丢失：T09/T16 的 `write_commit_response_lost` 必须只产生一次审批，并从 unknown 恢复。
2. 旧卡/旧草稿与手改竞争：T06/T08/T12 的 `stale_version_cannot_overwrite` 必须拒绝旧版本并保留最新手改。
3. 身份或权限运行中改变：T02/T04/T16 的 `revoked_scope_blocks_next_tool` 必须拒绝后续工具、下钻与下载。
4. 规则/Skill/记忆变化后的上下文陈旧：T11/T13/T15 的失效测试须验证版本重查和已删除记忆不再注入。
5. 断线、Worker 重启和取消并发：T03/T05/T16 的恢复测试须确保不丢最终状态、不串用户、不杀其他人的任务。

---

## 0. 开始前的执行规则

先检查仓库已有代码、启动命令、依赖和迁移，再决定新增/修改位置。若只是旧单文件 HTML 演示，保留其视觉参考，另建可维护工程，不把全局 JS 对象升级成业务数据库。用户只给某模块时，仅完成该模块当前阶段和必要共同基础，不擅自重写其他模块。

本文的 tests 路径和命令是应创建的工程约定，不声称当前已有这些文件。每项先实现有意义的业务/恢复断言，再实现对应逻辑，实际运行检查；界面文案和简单样式无需机械编写镜像测试。

模型凭据缺失时仍可完成合同与确定性测试；真实集成验收必须标未执行，不生成假通过记录。各模块开发完成后形成一份实际交付报告，列当前完成范围和仍未实现的后续阶段。

## T01 公共合同、工程与持久化基础

**Files:** 根 package.json/pnpm-workspace.yaml；apps/web、apps/api、apps/worker；packages/contracts/src/{common,events,cards}.ts；infra/compose.yaml；infra/migrations；tests/contracts/common.spec.ts。

**Interfaces:** 定义 ActorContext、Money、ResourceRef、ActionReceipt、AgentCard、ToolResult、RunStatus 和统一错误类型，签名以 01 文档为准。所有模块引用，不重复定义。

- [ ] 建立工程、类型检查、格式化、迁移、健康检查和环境配置模板；不提交真实秘密。
- [ ] 定义共享 schema 与版本，验证金额字符串、枚举、拒绝未知字段和带版本资源引用。
- [ ] 建立 PostgreSQL/文件存储开发环境；按事务实现 outbox 基础与私有文件元数据。
- [ ] 创建命令 `pnpm dev`、`pnpm db:migrate`、`pnpm db:seed`、`pnpm typecheck`、`pnpm test:unit`、`pnpm test:contracts`、`pnpm test:integration`、`pnpm test:e2e`、`pnpm test:agent:real`、`pnpm test:load`。
- [ ] 运行 typecheck 与 common 合同测试；预期全部通过，数据库重启后基础记录仍可读。

**退出条件:** 各模块能从同一 schema 编译；有数据库和私有文件服务；环境分 demo/test/production，未就绪能力有明确错误。

## T02 M12 身份与主数据

**Files:** apps/api/src/modules/identity；apps/web/src/features/identity；packages/contracts/src/identity.ts；tests/integration/authz.spec.ts。

**Interfaces:** IdentityProvider、ActorContext 由 M12 提供；资源判定入口 `assertResourceAccess(ctx,operation,ref):Promise<void>`，成功返回、失败抛公共权限错误，内部审计保留拒绝理由，不向模型透出无权对象内容。

- [ ] 读取 M12，实现 demo 登录、cookie/CSRF、服务端身份、权限 grants 和字典。
- [ ] 按 02 数据初始化七个人、四部门和明确的数据范围；普通身份不获得管理员/财务特权。
- [ ] 验证 `manager_cannot_read_other_department`、`admin_cannot_read_employee_memory`、`production_rejects_demo_auth`。
- [ ] 运行 identity 合同和集成测试；刷新身份仍一致、退出后凭据失效。

**退出条件:** 通过真实服务端权限测试，后续各模块不用伪造 x-user-id 头实现用户切换。

## T03 M14 dsh 兼容验证与最小可靠 run

**Files:** packages/agent-runtime/src/{adapter,dsh/driver,workspace}.ts；apps/worker/src/runner；docs/runtime-compatibility.md；tests/integration/dsh-runtime.spec.ts。

**Interfaces:** 使用 M14 的 AgentRuntimeAdapter.start/continue/stop/dispose；M13 临时只注册 `finance.health.read` 测试工具，测试后不作为业务能力展示。

- [ ] 锁定实际 dsh/SDK/Node 版本和自定义 profile，接内网模型，验证中文、流式和工具往返。
- [ ] 建立 run/job/lease/event 存储；接受请求先落库，worker 一次拥有一个 run。
- [ ] 验证 `two_workers_one_owner`、`runtime_workspace_isolated`、`restart_restores_readonly_turn`。
- [ ] 运行真实模型集成，记录调用证据与 SDK 取消/持久化实际限制；凭据缺失则标阻塞项，不伪造通过。

**退出条件:** 真实 dsh 可调用受控工具并恢复只读任务；已锁版本及适配限制清晰。

## T04 M11 动作骨架与 M13 工具骨架

**Files:** packages/action-service/src/{prepare,confirm,execute,reconcile,cancel,registry}.ts；apps/api/src/modules/approvals/routes.ts；apps/api/src/modules/integrations/{tool-gateway,registry}.ts；packages/business-adapters/src/ports.ts。

**Interfaces:** M11 提供 `prepareAction(actor,input)`、`confirmAction(actor,confirmationId,input)`、`getAction(actor,id)`；操作 handler 注册遵循 M11；M13 提供 ToolGateway.listAllowedTools/dispatchTool。业务 handler 在各模块实现，不复制公共执行器。

- [ ] 先实现确认摘要/hash/过期、动作账本、Idempotency-Key 和结果查询；此时没有业务 handler 的操作明确拒绝。
- [ ] 实现工具参数 schema、租约检查、能力与 Skill 权限交集，禁止模型自报身份。
- [ ] 验证 `same_key_same_payload_one_action`、`same_key_changed_payload_conflict`、`model_cannot_override_actor`。
- [ ] 在服务层完成测试；通过后作为后续领域模块的公共依赖。

**退出条件:** 有唯一可靠写入边界；这一步只完成 M11/M13 公共基础，不宣称完整审批和接入台完成。

## T05 M01 对话、卡片与抽屉骨架

**Files:** apps/web/src/features/assistant；apps/api/src/modules/assistant；packages/contracts/src/cards.ts；tests/e2e/assistant-shell.spec.ts。

**Interfaces:** M01 使用 /threads、/home、/cards 和 M14 /runs/{id}/events；业务卡片 renderer 使用固定 schema，不执行模型 HTML。

- [ ] 实现首页、消息持久化、选会话、SSE 进度、基础 summary/action card 与右抽屉宿主。
- [ ] 建立卡片和 drawer 注册表，未实现类型给可理解的未就绪状态，不能用假数据冒充已接系统。
- [ ] 验证 `home_does_not_auto_create_message`、`drawer_close_preserves_chat`、`sse_reconnect_no_duplicate_card`。
- [ ] 浏览器刷新/前进后退/键盘关闭抽屉可用；状态来源后端。

**退出条件:** 最薄 Agent 产品骨架可体验，详情和写操作等待后续领域接入。

## T06 M08 差旅系统与第一条真实业务提交

**Files:** apps/api/src/modules/travel；apps/web/src/features/travel；packages/business-adapters/src/demo/travel.ts；tests/e2e/travel.spec.ts。

**Interfaces:** M08 草稿读取/patch proposal/采纳接口，注册 travel.submit/resubmit/withdraw handlers 给 M11；审批由公共 approval.approve/return 根据资源类型调用差旅领域服务，不另建 travel.approve。operation 名以 M11 registry 固定清单为准。

- [ ] 实现行程、城市映射、草稿 diff 和 CAS；每次智能修改从最新草稿读取。
- [ ] 实现提交流程和单节点主管审批，接入 Agent draft_proposal 与 document_summary。
- [ ] 验证手改 v2 后仅改返程、旧 v1 patch 被拒、提交回执和业务页面同 ID。
- [ ] 执行 E2E-02；保留所有用户可操作错误状态。

**退出条件:** 单据可从 Agent 完整进入真实 Demo 审批，不仅生成表单截图。

## T07 M10 OA 前置申请与模拟消息

**Files:** apps/api/src/modules/oa；apps/web/src/features/oa；packages/business-adapters/src/demo/oa.ts；tests/integration/oa-links.spec.ts。

**Interfaces:** 提供已批准招待申请读取、匹配状态与模拟消息回执；handlers 注册到统一动作服务。

- [ ] 实现招待申请表单、主管审批与可关联查询；权限不得依赖前端过滤。
- [ ] 建立消息 outbox 和明确 demo 站内收件结果，不发送真实企业 IM。
- [ ] 测试日期/申请人/部门/预算不匹配及重复发送同 key 去重。
- [ ] 读取同 oa-001 的抽屉、业务详情和接口结果一致。

**退出条件:** 报销模块可以依赖真实 OA 状态进行关联校验。

## T08 M09 发票、费用与报销

**Files:** apps/api/src/modules/expenses；apps/web/src/features/expenses；packages/business-adapters/src/demo/expenses.ts；tests/e2e/expense-flow.spec.ts。

**Interfaces:** 文件上传/票据识别/人工确认、expense item、claim、SRS 标准投影；M03 尚未完成时投影按合同验证，不假造预审通过。

- [ ] 实现异步 OCR adapter fixture、预览矫正、一票一费、类型候选、重复票校验。
- [ ] 实现草稿 diff、提交前校验、关联 travel/OA、主管→财务状态推进。
- [ ] 验证 `invoice_not_double_counted`、`stale_version_cannot_overwrite`、`claim_submit_receipt_persisted`。
- [ ] 执行 E2E-03 的准备/提交部分，预审部分待 T12 完成后补测。

**退出条件:** 11 张公共报销 fixture 和每张实际费用行可查询，状态同审批任务一致。

## T09 M11 审批台、回执核实和逐项动作

**Files:** apps/web/src/features/approvals；apps/api/src/modules/approvals；tests/integration/action-reconciliation.spec.ts。

**Interfaces:** /approvals 待办与详情、统一 confirmations/actions；可插拔 `PreauditEligibilityPort`，M04 完成前批量低风险按钮禁用，不回退全选直批。

- [ ] 完成固定节点审批台、退回/重提/撤回、动作审计和逐项结果。
- [ ] 实现 `getReceipt`/unknown 核实与部分失败，不重复发出相同动作。
- [ ] 测试 `write_commit_response_lost`、`two_tabs_one_approval`、`partial_batch_receipts_preserved`。
- [ ] 状态从主管到财务再到 completed，不能出现“已付款”文案。

**退出条件:** 单项写入及恢复可靠，批量 eligibility 留明确端口待 T12 接入。

## T10 M06 制度知识与来源

**Files:** apps/api/src/modules/knowledge；apps/web/src/features/knowledge；tests/integration/policy-search.spec.ts。

**Interfaces:** 文档导入、版本/生效范围、授权检索、稳定引用 ID/段落；finance.knowledge.search 通过 M13 注册。

- [ ] 实现首期受支持文本格式、解析状态、发布、分段检索和引用抽屉。
- [ ] 种子政策给公司规则作为来源；测试旧版本、冲突、无依据和越权检索。
- [ ] 执行 E2E-01；任何关键结论有可访问原段落，不能自动把政策问答发布为规则。

**退出条件:** 来源链真实可回查，后续规则可引用固定政策版本。

## T11 M03 SRS 规则中心

**Files:** apps/api/src/modules/rules；apps/web/src/features/rules；packages/contracts/src/rules.ts；tests/unit/rule-evaluator.spec.ts。

**Interfaces:** SrsInput、DSL schema、字段目录/映射、compile/evaluate、规则集修订与版本；M04 消费纯解释器，不执行模型生成代码。

- [ ] 实现三值解释器和边界：999/1000/1001，未知字段、不同币种、空集合、any/all。
- [ ] 实现语义草稿/澄清/编辑/样例测试/版本 diff/确认启用，个人不能覆盖公司要求。
- [ ] 测试 `rule_activation_invalidates_old_revision`、`unknown_cannot_pass_required_check`；显示每条规则依据。
- [ ] 执行 E2E-04 的创建到发布链路，预审效果在 T12 复验。

**退出条件:** 规则是可版本化、可测试的结构化对象，不是只有一段自然语言提示词。

## T12 M04 批量预审与 M01 风险抽屉集成

**Files:** apps/api/src/modules/preaudit；apps/web/src/features/preaudit；tests/e2e/preaudit-approval.spec.ts。

**Interfaces:** task/result/findings/coverage、document/rules/mapping/reviewer 版本绑定；向 M11 实现 PreauditEligibilityPort。

- [ ] 实现单/批快照检查、4 类分组、证据、失败重试、失效与重审。
- [ ] 接入 M01 概要卡/清单/详情抽屉；接入 M11 精确对象版本的低风险批量确认。
- [ ] 测试基准 5 张/5540 元、2 张低风险/1240 元；旧结果不允许批量审批。
- [ ] 完成 E2E-04、E2E-05 和 E2E-03 预审补测；核对财务待办与 completed 指标变化。

**退出条件:** 主场景闭环可在不同用户、不同入口真实推进。

## T13 M05 Skills Hub

**Files:** apps/api/src/modules/skills；apps/web/src/features/skills；packages/agent-runtime/src/context/skills.ts；tests/integration/skill-grants.spec.ts。

**Interfaces:** Skill 版本、输入输出、工具清单、范围授权、调用记录；M01 skill picker、M13 allowed tool intersection。

- [ ] 实现贡献/校验/私用/共享审核/发布/禁用，初期只接收受支持声明与说明文本。
- [ ] 预置五个可实际调用的财务 Skill；一个仅财务可见的隔离样例。
- [ ] 验证源码可见权与使用权独立、撤回后新调用拒绝、运行版本冻结和停用检查。
- [ ] 显式选择 Skill 产生实际工具轨迹，不能只在输入框加一个徽标。

**退出条件:** Skill 治理和调用贯通，并未获得额外数据权限。

## T14 M07 数据分析与报告

**Files:** apps/api/src/modules/analytics；apps/web/src/features/analytics；tests/integration/metrics.spec.ts；tests/e2e/report.spec.ts。

**Interfaces:** metric/query/snapshot、chart spec、drilldown cursor、report/artifact；只读查询模板和指标目录。

- [ ] 实现固定指标口径和权限约束、确定性汇总、同 snapshot 下钻。
- [ ] 图表与报告引用同一快照，导出独立鉴权，保存/编辑不篡改源数字。
- [ ] 验证 5900/1800/2300 等固定断言；零/空/未知分别处理；不查任意 SQL。
- [ ] 执行 E2E-06，包括无导出权和过期数据刷新。

**退出条件:** 图、表、正文数字可以逐项回到同批业务记录。

## T15 M02 记忆、调度与主动消息

**Files:** apps/api/src/modules/memory；apps/worker/src/scheduler；apps/web/src/features/memory；tests/integration/memory-schedule.spec.ts。

**Interfaces:** 个人记忆检索/修改/删除、subscription、inbox、调度 job；M14 context bundle 与 M01 未读入口。

- [ ] 实现明确保存/改删、记忆来源/TTL和失效，不把业务事实或审单规则存成偏好。
- [ ] 实现时区调度、同计划时点去重、暂停/删除、只读摘要投递。
- [ ] 测试 `deleted_memory_not_reinjected`、`same_schedule_slot_one_delivery`、`revoked_scope_no_summary_leak`。
- [ ] 执行 E2E-07/08；用户不在线时任务可完成，但不自动处理审批。

**退出条件:** 用户真正有独立持久记忆，主动摘要可维护、可停止、可追溯。

## T16 M14/M13 产品完善与故障恢复

**Files:** apps/worker/src/{runner,reconciler}；apps/api/src/modules/{operations,integrations}；apps/web/src/features/{operations,integrations}；tests/load/agent-runs.ts。

**Interfaces:** 完整 M14 checkpoint/cancel/resume/budget、完整 M13 registry/callback/reconciliation；不改变 M01 的公共事件协议。

- [ ] 完成运行/队列/模型/工具配额，context 压缩与权限/记忆版本更新，受控管理操作。
- [ ] 完成租约 fencing、未知写入核实、SSE 回放过期、进程重启、取消他人不受影响。
- [ ] 执行五项 Review Focus 的全部测试及模型/工具失败矩阵；记录真实模型测试与容量结果。
- [ ] 提供密钥轮换、备份恢复、连接器停用、Worker 滚动升级和未知动作处理手册。

**退出条件:** 并发和故障下数据正确；只有可证明安全的写入接入可启用，未接能力明确关闭。

## T17 M15 演示控制台与总验收

**Files:** apps/web/src/features/demo；apps/api/src/modules/demo；packages/fixtures/src/{seed,scenarios,clock}.ts；tests/e2e/full-journeys.spec.ts。

**Interfaces:** seed/reset/scenario/clock/fault 与 generation；最小 seed 在 T02 起已使用，此阶段完成可视化与故障控制。

- [ ] 实现场景加载、身份跳转、业务时钟、摘要触发、可核实的故障注入/恢复。
- [ ] reset 先停止本环境新任务和隔离旧写入，不能影响其他租户或真实系统。
- [ ] 跑完整 8 旅程、F01–F15 异常和权限负面用例；按实际结果报告，不删失败项。
- [ ] 提供可复现启动、演示操作手册、通过/未通过清单、已知限制和生产适配列表。

**退出条件:** 单人可按脚本演示完整链路，多人可用独立测试环境验证隔离，production 不能访问演示控制能力。

## 4. 每个任务的交付报告模板

```text
任务/模块：
本轮完成的需求编号和当前阶段：
实际修改与迁移：
公开接口/共享合同变化：
启动与验证命令：
实际通过的测试及证据：
实际失败或未执行的测试与原因：
对既有模块的兼容与回归结果：
仍待下一阶段完成的范围：
```

完成 T17 不自动宣称已经具备生产资质。正式上线需用真实身份和业务服务替换 Demo，按公司生产准入、数据保留与实际并发完成验证。产品核心代码保留；替换点在 IdentityProvider、BusinessAdapter、WorkflowAdapter、OCR/文件/模型供应端口，不是重写整个 Agent。
