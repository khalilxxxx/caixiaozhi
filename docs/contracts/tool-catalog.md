# 财小智工具网关与动作接入契约

当前实现使用真实 PostgreSQL 保存确认、动作、逐项回执、执行尝试、审计、能力版本、调用记录和回调去重。演示业务适配器与 `MockWorkflowAdapter` 均明确返回 `demo`；未配置真实 MaaS 不能切换标签后继续使用演示结果。

## 服务端接入

`createActionService(database, options)` 使用 Drizzle `Database`，通过注入的 `freshActor` 与 `assertResourceAccess` 重验身份和资源权限。`signingSecret` 至少 32 字节，须来自服务端配置。`generation` 可接演示环境代际；默认 1。`now` 只用于确定性测试，生产不接演示业务时钟。

服务公开 `registerHandler`、`prepareAction`、`getReview`、`confirmAction`、`executeAction`、`getAction`、`cancelAction`、`reconcileAction`。操作名以 `packages/contracts/src/actions.ts` 的唯一 registry 为准。未登记处理器的动作明确拒绝。M11列出的操作是最小集合；M03停用与映射发布在此登记为 `rule.disable`、`rule.mapping.publish`，不新增ResourceRef类型。

领域处理器的 `validate(actor,args,refs,tx?)` 返回可信摘要、规范参数、依赖、附加守卫与精确执行项。批次每项应提供单项 `args`，执行时以该参数和该项资源再次校验。共同依赖与附加守卫必须返回相同冻结版本；逐项守卫放 `items[].guards`。本地 `execute(ctx,tx,action)` 必须使用传入事务完成业务、审批决策、额度和 outbox，返回回执后由公共服务在同一事务保存。抛错会一并回滚。

远程处理器显式 `mode:'remote'`。公共服务先原子领取执行项并持久化稳定 `external_request_id`，再发请求。`unknown` 或遗留 `executing` 只调用 `queryOutcome` 核实；不会重发原命令。真实远程写接口必须自行支持幂等和结果查询，不满足时不得发布。

确认记录绑定本人、当前会话、权限版本、动作、参数 hash、资源版本、依赖版本和环境代际，真实时间 10 分钟到期。只有同一有效浏览器交互会话可调用 `getReview(actor,id,{channel:'browser'})` 取得最长 2 分钟 HMAC 签名令牌。模型仅可取得确认 ID、摘要、期限和动作结果；令牌不进入工具目录、SSE、卡片和调用日志。浏览器仅在内存持有令牌。

同一租户、本人、操作和幂等键只创建一个动作；同键不同规范 payload 返回 `IDEMPOTENCY_CONFLICT`。账本和回执至少保留 180 天。每项独立提交；父动作 `succeeded` 表示处理结束，界面必须使用逐项回执与 summary 说明部分完成。取消仅影响未领取项，在途项保留真实结果。

`createToolGateway(database, options)` 注入当前身份、运行租约、预算、Skill 白名单与资源授权端口。`registerTool(definition,{authorize,execute})` 只注册可信代码。`installBuiltinCapabilities` 是可信部署/seed 的内置 demo 目录安装入口，不对 HTTP 暴露；重复启动不重新启用已停用能力，也不能覆盖既有版本内容。动态版本须经过受控契约夹具测试，发布与停用通过 M11 确认。

有效工具为当前用户权限、已发布版本、启用连接器、运行 profile、所选 Skill 的交集。订阅仅可读。输入严格 JSON Schema，不接受模型指定身份、凭据、URL、SQL 或脚本。每次调用复核租约和权限，唯一 `run_id/call_id` 防止重复执行。调用日志保存参数 hash 与脱敏参数，管理查询不返回完整结果正文。输出校验后最多 128 KiB；超过时使用授权私有产物端口，未配置时明确返回依赖错误。

## 首期能力

| 工具                          | 影响    | 领域所有者                 |
| ----------------------------- | ------- | -------------------------- |
| finance.todo.list             | read    | M11 当前授权待办           |
| finance.document.get          | read    | M08/M09/M10 同一业务主数据 |
| finance.preaudit.start        | read    | M04 创建内部检查任务       |
| finance.preaudit.get          | read    | M04 任务进度与证据         |
| finance.rules.propose         | propose | M03 结构化候选             |
| finance.rules.test            | read    | M03 授权测试集             |
| finance.knowledge.search      | read    | M06 授权制度               |
| finance.analytics.query       | read    | M07 固定指标快照           |
| finance.report.create         | propose | M07 私有报告草稿           |
| finance.travel.propose_patch  | propose | M08 最新草稿差异           |
| finance.expense.propose_patch | propose | M09 最新草稿差异           |
| finance.action.prepare        | propose | M11 确认意图，无令牌       |
| finance.action.status         | read    | M11 本人动作与逐项回执     |

具体版本 ID、输入和输出 schema 与描述由 `packages/integrations/src/catalog.ts` 的 `BUILTIN_CAPABILITIES` 唯一导出。可复用的领域输入直接由共享 Zod schema 生成 Draft 2020-12；输出校验包含单据版本、任务标识、金额、引用、状态和逐项回执等必要字段。`requires_confirmation` 同样校验确认意图格式。目录定义并不代表处理器已经接入；未注册处理器不会出现在可用工具中。各领域必须调用同一服务和资源授权，不创建工具专用业务副本。

`finance.action.status`因新增合法动作输出升为1.1.0；旧数据库中已发布的1.0.0定义保持不可变，不原地改checksum。`finance.rules.test@1.0.0`保留原四边界输入/输出定义；人工专用样例集由鉴权HTTP界面登记、选择和查看，未静默扩大模型工具的1.0.0协议。

## 规则测试持久任务

`POST /api/v1/rules/:id/tests` 接收 `{expected_version,test_set_id}`，以 HTTP 202 返回 `task_id/test_run_id/job_id`；`expected_version` 是规则公共版本。测试集可为内置`boundary-v1`，或由当前维护者通过`POST /rules/:id/test-sets`明确登记的不可变人工集合。人工集合包含4–100项严格SrsInput与人维护的expected_truth，绑定租户、owner及当前草稿ID/hash；不能由模型传任意cases直接跑成发布证明。`GET /api/v1/rules/:id/tests/:task_id`返回真实进度与proof；未完成或失败均不可发布。

`finance.rules.test` 使用共享严格输入 `{rule_id,draft_version,test_set_id:'boundary-v1'}`，其中 `draft_version` 是草稿内容版本。首次调用返回排队任务，完成后以同一参数重读返回真实证明。相同本人、权限版本和完整冻结绑定的新调用复用原任务；Worker 恢复不会产生重复证明。任务冻结规则公共版本、草稿版本及 hash、compiled hash、字段映射修订和快照 hash、测试集及预期真值。准备确认和执行启用都会重新核对这些绑定；草稿、权限或映射变化要求重测。证明、任务完成和租约 fencing 在同一事务提交。

`boundary-v1` 按人民币最小单位“分”生成阈值少 1 分、等于阈值、多 1 分和未知金额四项。阈值 1000 元对应 `99999/100000/100001/null` 分，gt 预期分别为 false/false/true/unknown。M03 §4.1 明确要求 999.99/1000.00/1000.01 元；联调 E2E-04 的 999/1000/1001 元为整元样例，不能替代分精度验证，因此实现采用前者。预期真值来自服务端固定比较表，规则结果仍由同一确定性解释器生成。

## 管理与回调

管理路由 `registerIntegrationRoutes` 只处理脱敏配置、版本、契约测试和确认意图，不提供公网任意工具执行端点。连接地址和密钥仅允许 `env:`/`vault:` 引用，真实连接需要注入验证适配器。平台管理员无员工业务正文特权。

`createWorkflowCallbacks` 以服务端连接器密钥校验 HMAC-SHA256，签名原文为 `${timestamp}.${rawBody}`，时间戳毫秒，允许 5 分钟偏差。幂等键为连接器、外部任务、事件 ID；同事件不同内容冲突。输出先校验契约，再同事务更新结果并写完成 outbox。重复或已终结回调不重复产生结果卡事件。超时只把原任务置为 `unknown`，保留原外部请求标识。

当前确定性验证覆盖公共动作、网关边界、全部预置输入 schema 与回调去重；真实 MaaS、真实 dsh 工具往返和各领域四类完整契约验收由实际配置及领域联调报告确认，不能由目录安装代替。

## Skill 治理与受控生成

`packages/insights` 提供 `createSkillService` 和 `createAnalyticsService`。Skill 使用授权、源码授权、维护、独立审查与发布分离；组成员身份本身不授予组维护权。全租户发布要求 `skill.manage` 的显式 operations scope 含 `skill-share:tenant`；组发布要求 named resource scope 明确包含每一个组 ID。共享发布仍复用 `skill.publish` 的统一确认账本。

预置五个共享能力与一个财务组受限能力保存真实 manifest、白名单和内容 hash。合成基准验证明确为 `blocked`，不是已通过真实模型验证；共享合成审查处于待审查。财务私有能力单独确定 owner，不向共享作者或平台管理员附赠源码，不自动生成共享审查。已有 run 由 `getFrozenForRun` 读取原版本，不在恢复时重新自动选择最新版；停用和撤销会阻止后续执行，既有动作仍可查回执。

`packages/application/src/skill-validation.ts` 的 `createSkillValidationPorts` 复用真实 `DshRuntimeAdapter` 执行成功、澄清和拒绝样例。候选只能使用登记工具，所有调用经过独立网关、当前身份、作业租约、操作白名单及公共模型槽校验。`test_run_ids` 对应真实运行元数据和持久工具调用记录，不能靠模型自报通过。结构化金额、单位和布尔事实有确定断言，解释措辞可不同。实际到达本人确认边界时，校验数据库中的 prepared action 和可信检查点，记录真实 propose 证据，不伪造最终业务成功或模型结果。

验证任务不创建隐藏会话或额外 Agent run。demo 默认只使用明确合成环境；test/production 必须注入隔离夹具身份。缺模型、缺隔离夹具、并发额度不足或试运行失败保留真实阻塞/失败记录，不能激活或发布。生产中的隔离夹具和真实 MaaS 仍需实际配置。

通用 `createControlledDshGenerator` 只接受可信服务代码登记的差旅候选、规则候选和制度解释操作，先保存 durable job、来源版本、输出 schema、任务状态和审计，再通过 dsh 生成。它不开放文件、shell、任意 HTTP 或业务写工具；只有通过领域 schema 与最新权限/来源复验的结构化输出才成功。未知事实必须按领域 schema 进入澄清路径。

所有 Agent、结构化生成和 Skill 验证共用数据库模型槽。生成和验证在启动前取得槽，模型/工具/结果提交前校验 fencing，心跳失败停止旧运行，结束释放。生成拿不到额度时保留 queued 任务，不启动第二个模型进程。该领域任务 ID 与 Agent run ID 分离，`origin_run_id` 只有真实发起 Agent run 时才填写。

## 分析、快照和私有导出

分析使用固定指标与维度白名单，在 PostgreSQL REPEATABLE READ 事务中冻结授权 claim/line 事实；完成与提交分别使用 `completed_at`/`submitted_at`，金额按整数分聚合。图表、下钻、比较、报告与导出引用同一快照，旧快照不会被活表变化替换。当前权限失效时拒绝正文和下载，数据变化则标记历史快照。

报告只允许编辑说明和用户补充，事实 hash 固定。CSV/HTML 导出经独立 `analytics.export` 授权，真实私有对象写入后回读核对 hash，下载始终由鉴权代理返回字节；HTML 文本转义且禁止脚本，CSV 文本防公式注入。数据质量与历史快照说明随导出保留。未配置私有存储时明确失败，不返回虚构下载链接。
