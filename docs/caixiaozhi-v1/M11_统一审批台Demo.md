# M11 统一审批台 Demo 与公共确认动作服务

版本：1.0｜深度：简易可运行 Demo｜依赖：01 公共契约、02 固定夹具。本文是实施设计，未声称已实现或已通过测试。

## 1. 目标、所有权与依赖

本模块提供当前审批任务、审批决策、逐项回执，以及供所有产品模块复用的确认与动作执行基础服务。
独立审批台、Agent 抽屉、M13 工具网关和 M14 运行底座使用同一服务，不各自保存“已批准”副本。
业务聚合由 M08/M09/M10 等模块持有；M11 管理任务和动作账本，通过领域 handler 调用聚合服务。
公共服务落在 `packages/action-service`，不依赖 React、dsh 或具体报销表，避免被做成只能审批报销的工具。

| 依赖 | 使用内容 | 边界 |
|---|---|---|
| M12 | ActorContext、动作权限、当前范围、authz_version | prepare、confirm、execute、status 每次鉴权 |
| M08/M09/M10 | 业务快照、合法状态转换、审批链、额度联动 | 状态写入仍在业务模块，不能由通用 JSON 任意改表 |
| M04 | 预审完成度、分类、证据、依赖版本 | 预审是辅助证据，eligible 不等于批准 |
| M03/M05 | 规则与 Skill 的 enable/publish handler | 复用确认账本，但发布校验由各模块完成 |
| M07/M10 | 报告外发意图、站内通知发送 handler | 发送对象、内容、收件人一并绑定确认 |
| M13/M14 | 工具准备动作、查询动作、运行恢复 | M14 只消费 action_id，不再创建第二套执行器 |
| M15 | 演示环境 generation、故障注入 | 过期 generation 不能执行动作或写入回执 |

本期经理和财务为顺序审批；不实现任意会签流程、代理审批、支付或银行出款。
财务批准完成报销的审批流程，状态为 `completed`；界面用“审批完成”，不能显示“已付款”。

## 2. 编号功能与角色权限

| 编号 | 功能 | 可观察结果 |
|---|---|---|
| APR-01 | 读取当前待办 | 由 pending task 与业务状态联合查询，按当前审核人筛选 |
| APR-02 | 单据详情与审核证据 | 显示对象版本、当前节点、最新预审和来源 |
| APR-03 | 批准 / 退回 | 用户确认后有 decision、业务状态、任务状态和回执 |
| APR-04 | 低风险批量批准 | 只处理确认中列明的对象版本，逐单返回结果 |
| APR-05 | 决策历史 | 查询不可变记录，不用最后一条聊天覆盖历史 |
| ACT-01 | 准备有影响动作 | 规范化参数、校验、绑定版本，返回确认摘要 |
| ACT-02 | 确认并执行 | 用户经浏览器会话确认，后端重验后执行 |
| ACT-03 | 幂等与 CAS | 相同请求只写一次，过期对象返回冲突 |
| ACT-04 | 未知结果核实 | 超时进入 unknown，按稳定请求标识查回执 |
| ACT-05 | 取消未执行动作 | 取消 prepared/confirmed 的未执行项，不伪造回滚 |
| ACT-06 | 领域 handler 注册 | 提交、审批、发布、发送统一接入并保留领域约束 |

| 身份 | 读取范围 | 写入范围 |
|---|---|---|
| 员工 | 本人业务进度与本人动作回执 | 本人提交、重提、撤回；无审批权限 |
| 张伟 / 孙静 | 对应部门当前任务及已授权历史 | 自己负责的 pending task；不能替其他经理批准 |
| 刘敏 | 显式授权部门的财务待办 | pending_finance 当前财务任务 |
| 规则 / Skill 维护者 | 所授权版本与发布记录 | 仅明确授予的 enable/publish 权限 |
| 赵磊 | 运行耗时、错误码、脱敏任务元数据 | 可运维核实流程，无业务批准与正文读取权 |

一个人拥有 manager 角色不代表拥有所有部门任务；任务 assigned_to、业务部门范围和动作授权必须同时满足。
审批后原审批人可按历史授权看决策；撤权后不能依赖曾审过该单继续读取正文和附件。

## 3. 页面、抽屉与操作旅程

### 3.1 页面结构

`/approvals`：待我处理 / 我已处理两个页签，业务类型、申请人、提交时间筛选；默认仅当前任务。
列表列出单号、申请人、业务类型、金额、当前节点、预审状态、更新时间；总数由服务端授权查询得到。
点击行打开审批抽屉，显示单据、发票 / 行程 / OA 关联、制度证据、个人提醒和决策时间线。
抽屉使用 M01 的 ResourceRef 和深链接规则；独立页与 Agent 使用相同 `ApprovalDetail` 组件和查询。
审批按钮不由前端角色名决定；使用服务端 `available_actions`，执行时仍重新鉴权。
退回必须填写 1–1000 字原因，可引用缺失字段；按钮旁明确退回会结束当前 pending task。
勾选低风险项后显示数量、金额、审核节点和逐单版本；用户可展开每一项并移除。

### 3.2 标准低风险旅程

张伟读取夹具的五张销售部待办，发起 M04 本人范围的预审，得到四组真实检查结果。
选择 clm-001 和 clm-005 后，服务端核验完整性、新鲜度与当前任务，准备 124000 分的确认摘要。
用户确认后逐单提交事务，两张单据进入 pending_finance，经理任务 approved，生成财务 pending task。
摘要卡显示每项 action receipt，主管待办剩三张，财务新增两张；已完成金额仍是 590000 分。
刘敏需读取自己的财务任务和审核证据后批准，才写 completed_at 并增加审批完成指标。

### 3.3 失败状态必须可操作

| 状态 | 展示 | 后续动作 |
|---|---|---|
| 无待办 | “暂无待处理单据”，保留历史入口 | 不展示假低风险空报表 |
| 预审未完成 / 部分失败 | 检查未完成，列出失败检查 | 重试读检查；不能加入低风险批次 |
| attention / risk / incomplete | 展示原因，默认不加入批量 | 人工逐项处理；退回或有权限的单笔决策 |
| 版本冲突 | 指出对象已变化，旧确认失效 | 刷新，重做必要预审，再准备确认 |
| 确认过期 | 保留原摘要并标记过期 | 重新读取和准备，不延长旧确认 |
| 部分成功 | 逐项成功 / 冲突 / 失败统计 | 成功项禁止重发，失败项按原因处理 |
| unknown | “结果核实中”，显示查询入口 | 只查账本和外部回执，不再次批准 |
| 权限变化 | 停止详情与动作，移除缓存正文 | 返回授权列表，不能继续用旧卡执行 |

## 4. 数据模型与约束

各表具有公共 id、tenant_id、version、created_at、updated_at；业务时间、金额和错误契约引用 01。

| 表 | 关键字段 | 校验与索引 |
|---|---|---|
| approval_tasks | resource_type/id、resource_version、stage、assigned_to、state、submission_id | 同资源同提交轮次最多一个 pending task |
| approval_decisions | task_id、actor_id、decision、reason、review_ack、before/after_version、action_id | decision 为 approve/return；action item 唯一；证据与未知项确认记录不可改写 |
| confirmations | actor_id、session_id、authz_version、action、args_hash、summary_hash、resource_refs、dependency_refs、extra_guards、expires_at | 默认真实时间 10 分钟；状态与确认版本持久化；令牌只存 nonce / 摘要 |
| actions | confirmation_id、operation、state、idempotency_key、payload_hash、run_id、trace_id、generation | 租户 + actor + operation + key 唯一 |
| action_items | action_id、ordinal、resource_ref、task_ref、state、receipt_id、external_request_id | 批次稳定 ordinal；每项独立幂等键 |
| action_receipts | action_id、item_id、outcome、resource、external_receipt_id、error_code、occurred_at、data_mode | 公共 ActionReceipt 投影；至少保留 180 天 |
| action_attempts | item_id、attempt、started_at、finished_at、transport_result、reconcile_after | 不记录密钥或完整票据；尝试不等于业务结果 |
| outbox | event_type、resource_ref、action_id、payload、generation、delivery_state | 与本地业务事务一起提交，消费者幂等 |

`resource_refs` 仅允许 01 的 ResourceRef 类型；审批任务通过 `task_ref:{id,version}` 额外守卫绑定。
M10 消息草稿通过 extra_guards 绑定 draft id/version；不能随意增加公共 ResourceRef 枚举。
args_hash 使用 schema 校验后的规范 JSON：金额分字符串、稳定键序、明确 null；不直接 hash 模型原文。
dependency_refs 按动作需要绑定规则、Skill、能力、预审、材料、字段映射修订号；无关依赖不强行添加。
跨租户、对象重复、缺版本、批次超 50 项或混合经理 / 财务节点的批准请求直接拒绝。
批量金额以每项当前数据库金额精确求和；确认摘要不能以客户端合计替代。
审批任务创建必须得到明确审核人；目录不能解析经理或财务范围时拒绝提交并提示配置缺失。

### 4.1 业务状态与任务转换

| 业务 | 确认动作 | 原状态 | 新状态与任务 |
|---|---|---|---|
| 差旅 / OA | submit 或 resubmit | draft / returned / withdrawn | pending_manager；新建经理 pending task |
| 差旅 / OA | approval.approve | pending_manager | approved；当前任务 approved |
| 报销 | submit 或 resubmit | draft / returned / withdrawn | pending_manager；新建经理 pending task |
| 报销 | approval.approve | pending_manager | pending_finance；经理 approved、财务 pending |
| 报销 | approval.approve | pending_finance | completed；财务 approved，设置 completed_at |
| 三类业务 | approval.return | 当前合法 pending 状态 | returned；当前任务 returned，保存理由 |
| 三类业务 | 对应 withdraw | 当前合法 pending 状态 | withdrawn；当前任务 cancelled |

重提创建新 submission_id，旧任务和决策不删除；报销退回后重提从经理节点开始。
单据状态、任务转换、decision、receipt、额度联动、outbox 必须在同一 PostgreSQL UnitOfWork 中提交。
M09 完成与退回分别调用 M10 额度 consume/release 服务；通用执行器不能绕过该服务直接更改额度表。

### 4.2 动作状态与结果语义

合法主链：prepared → confirmed → executing → succeeded / rejected / failed / unknown。
prepared 可 expired/cancelled；confirmed 且尚未启动的项可 cancelled；executing 不能直接冒充 cancelled。
rejected 表示权限、版本、状态、确认等前置守卫拒绝，已知没有该项业务效果。
failed 表示已知失败且效果未提交；仅超时不能判 failed；无法证明是否生效必须 unknown。
unknown 经核实可以转 succeeded 或明确未提交的 failed/rejected；继续无证据就保持 unknown。
已成功项不因其他项失败而回滚；最终汇总必须包含 succeeded/rejected/failed/unknown 各项数量。
批次全部有确定结果后可终结为 succeeded，含义是“执行处理已结束”；混合结果的 UI 必须写“部分完成”。
存在 unknown 项时父动作保持 unknown，M14 run 进入 reconciling；禁止用父动作状态替代逐项 outcome。

## 5. 确认、低风险资格与可靠执行

### 5.1 prepare / confirm / execute

1. prepare 从可信交互上下文获取 actor，按 action schema 解析请求并由 handler 读取当前业务快照；订阅委托不能准备或确认写入。
2. 校验权限、任务、对象版本、状态、依赖版本、收件人与领域要求，生成可读摘要和不可变参数。
3. 保存 prepared action 与 confirmation；模型只能得到 action_id、confirmation_id 和摘要，无执行凭证。
4. 本人交互浏览器 GET /confirmations/:id 重新读取 review，得到摘要、确认版本、summary_hash 和短时签名 confirmation_token。
5. 用户点击确认时提交 expected_version、summary_hash、confirmation_token；校验签名、同 actor/session、当前 authz_version、真实期限、CAS 和 CSRF。
6. 执行前再次校验全部守卫；使用服务器读取的 ConfirmedAction，不能接受客户端自造 confirmed 标志。
7. 本地 handler 用单事务完成领域效果与回执；成功提交后通过 outbox 刷新待办、卡片与分析缓存。
8. 重复确认和重试使用原幂等键返回原动作；参数变化或勾选变化必须新准备，不能扩大旧批次。

confirmation_token 绑定 tenant、actor、session、authz_version、confirmation id/version、action id、args_hash、summary_hash、generation 和 expires_at。
令牌默认真实时间 2 分钟，且不晚于确认记录的 10 分钟期限；采用服务端密钥签名，不能用前端 hash 当签名。
GET review 仅允许该 actor 的有效 interactive 会话；subscription 的 session_id=null、其他用户、模型工具或连接器调用均不能获取令牌。
M13 prepare/status 和 M14 模型上下文只拿 id、摘要、期限及结果；日志、SSE、聊天卡片和模型返回中必须移除令牌。
浏览器只在内存持有令牌；刷新或短时令牌到期可重新 GET review，确认记录过期或依赖变动则重新 prepare。
GET review 不执行动作、不延长确认记录期限；已确认记录只返回现有 action 状态，不签发可扩大权限的新令牌。

### 5.2 eligible 的精确定义

低风险批量资格同时要求：当前 actor 是当前 pending task 的审核人；业务与节点仍匹配；范围授权有效。
对应预审必须为当前 reviewer_scope，必查检查全部 completed；结果分类严格为 low。
文档、票据、材料、公司规则、个人规则、映射与适用能力版本全部与预审快照一致。
任何 risk、incomplete、attention、失败检查、未知关键事实、stale 或别人的审核结果都使资格为 false。
服务端返回 eligible 只是允许用户选择；任何批次仍需用户看清单并显式确认。
M11 通过 packages/contracts/src/preaudit-eligibility.ts 的 PreauditEligibilityPort.check(ctx,input,tx?) 读取低风险批量资格；实现属于 M04，不跨模块直接查表。
prepare 不传 tx，冻结 EligibilityProof 的 result_hash、lock_hash、locked_versions 到 confirmation.extra_guards；对应每个精确 resource_ref / task_ref / result_id。
execute 逐项传 expected_guards 与当前业务 UnitOfWork，在同一事务锁 revision guard 行并重新校验哈希、版本、当前审核人和用途，再执行业务 CAS；变化返回 REVALIDATION_REQUIRED，不写 decision。
此 eligible 端口用于批量路径，不把 false 当作单笔人工决策的自动拒绝；MaaS 无等价原子版本条件时关闭 bulk capability。

### 5.3 单笔人工决策与硬阻断

硬阻断由业务 handler 返回 hard_block_reasons，限定为原业务系统提交 / 节点 / 关联校验及授权、CAS 守卫。
具体包括非法金额或日期、必填票据 / 费用类型 / 成本中心缺失、重复票据、OA 未批准或日期 / 申请人不符、额度不足、非法节点和非当前任务。
硬阻断存在时 available_actions 不含 approve；直接调用也拒绝，填写理由不能绕过，需退回补正或先解决配置 / 关联问题。
SRS 的 risk、attention、incomplete 本身不是硬阻断；Demo 的住宿超 800 元 / 间夜与个人餐费提醒仅作为审核证据，不直接拒绝单笔。
对这些分组做单笔批准或退回前，界面必须打开当前证据，并明确确认已查看的 finding / 未知项；要求 1–1000 字决策说明。
review_ack 绑定当前 document version、preaudit result / lock hash、evidence refs 和 acknowledged finding ids，随确认摘要冻结并持久化到 decision。
invoice verified=null 表示核验未知，不自动当作假票或缺原始文件；若同时触发原系统必填缺失，则仍按硬阻断处理。
人工决定不改写 SRS 结果为 low，不补造未知事实；历史保留原风险 / 未覆盖项、说明与真实决策人。

### 5.4 远端适配器、超时与恢复

真实外部系统接入时，先落本地执行意图和稳定 external_request_id，再发请求，不能持有数据库事务等待网络。
适配器必须支持幂等标识与结果查询；不支持的有影响写入在 M13 能力目录保持关闭。
发送后断网或响应丢失写 unknown，reconciler 根据 action_id/external_request_id 查询，不盲目重复发送。
外部成功确认后补记本地回执和投影，若投影更新失败继续恢复；不得再次发外部审批。
用户点击取消时，先停止未来未开始项；正在执行项保留核实状态，摘要分别报告已完成与已取消项。
Demo 也通过故障注入验证“数据库提交后 HTTP 回包丢失”，刷新查询应恢复同一成功回执。

## 6. HTTP 与适配器契约

均加 `/api/v1`；所有写请求带 Idempotency-Key，资源编辑与确认带 expected_version。

| 端点 | 输入 | 返回 |
|---|---|---|
| GET /approvals | tab、type、cursor、limit | 授权任务、精确金额、available_actions |
| GET /approvals/:taskId | 无 | 当前 task、业务 ref、详情、检查与历史 |
| GET /approvals/:taskId/history | cursor、limit | 不可变决策记录 |
| POST /confirmations | action、resource_refs、args、依赖证据引用 | prepared action、确认 id/version、摘要、期限 |
| GET /confirmations/:id | 本人交互会话，禁止模型工具转发 | summary、summary_hash、version、expires_at、confirmation_token、token_expires_at |
| POST /confirmations/:id/confirm | expected_version、summary_hash、confirmation_token | 200 已核实结果或 202 执行中 / unknown |
| POST /actions/:id/cancel | expected_version | 未开始项取消结果和在途项核实状态 |
| GET /actions/:id | 无 | 当前状态、逐项回执、下一次建议查询时间 |
| POST /actions/:id/reconcile | expected_version | 触发授权核实任务，不重新发原业务命令 |

```json
{
  "action":"approval.batch_approve",
  "resource_refs":[{"type":"expense_claim","id":"clm-001","version":1},
    {"type":"expense_claim","id":"clm-005","version":1}],
  "args":{"items":[
    {"resource_id":"clm-001","task_ref":{"id":"at-001","version":1},"preaudit_result_id":"par-001"},
    {"resource_id":"clm-005","task_ref":{"id":"at-005","version":1},"preaudit_result_id":"par-005"}
  ]}
}
```

任务 / 预审 id 为响应示例，实际必须使用当前读取返回值；不能在客户端按单号拼出任务 ID。

```json
{
  "data":{"id":"act-20","state":"unknown","summary":{"succeeded":1,"rejected":0,"failed":0,"unknown":1},
    "items":[{"resource_id":"clm-001","outcome":"succeeded","receipt_id":"rcpt-21"},
      {"resource_id":"clm-005","outcome":"unknown","receipt_id":"rcpt-22","next":"reconcile"}]},
  "meta":{"request_id":"req-20","trace_id":"trace-20","server_time":"2026-11-05T02:00:00Z","data_mode":"demo"}
}
```

```ts
interface ActionHandler<A> {
  validate(ctx: ActorContext, args: A, refs: ResourceRef[]): Promise<PreparedDomainAction>;
  execute(ctx: ActionContext, tx: UnitOfWork | null, action: ConfirmedAction<A>): Promise<ActionReceipt>;
  queryOutcome(ctx: ActionContext, action: ConfirmedAction<A>): Promise<ActionReceipt>;
}
async function prepareAction(ctx: ActorContext, input: PrepareInput): Promise<ConfirmationView>;
async function getConfirmationReview(ctx: ActorContext, id: string): Promise<InteractiveConfirmationReview>;
async function confirmAction(ctx: ActorContext, id: string, input: ConfirmInput): Promise<ActionView>;
type ConfirmInput = {expected_version:number; summary_hash:string; confirmation_token:string};
async function executeAction(lease: WorkerLease, actionId: string): Promise<ActionView>;
async function reconcileAction(ctx: ActorContext, actionId: string): Promise<ActionView>;
function registerHandler(name: ActionName, handler: ActionHandler<unknown>): void;
```

ActionContext 由公共服务构造，包含可信 actor、confirmation、action/item id、幂等键、trace、generation、租约边界。
M13 的 `finance.action.prepare/status` 只映射 prepareAction/getAction；M14 等待确认、执行恢复及核实均读取同一 action_id。
领域注册至少覆盖 travel/expense/oa 的 submit/resubmit/withdraw、approval.approve/return/batch_approve、rule.enable/publish、skill.publish、oa.message.send；名称在共享 contracts 中唯一导出。

## 7. 建议代码与 Codex 分步实施

| 文件 | 责任 |
|---|---|
| packages/action-service/src/{prepare,review,confirm,execute,reconcile,cancel}.ts | 公共编排、短时令牌与守卫 |
| packages/action-service/src/{registry,idempotency,guards,receipt}.ts | handler 注册、CAS、去重、回执 |
| packages/contracts/src/{actions,approvals}.ts | 状态、命令、摘要与逐项结果 schema |
| packages/contracts/src/preaudit-eligibility.ts | 引用 M04 唯一资格端口、输入及证明；不复制资格实现 |
| apps/api/src/modules/approvals/{schema,service,routes}.ts | 当前任务、历史和授权查询 |
| apps/api/src/modules/approvals/action-handlers.ts | 批准 / 退回路由到相应业务服务 |
| apps/worker/src/reconciler/actions.ts | 未知结果核实，复用公共服务 |
| apps/web/src/features/approvals/{ApprovalList,ApprovalDetail,BatchConfirmation}.tsx | 页面与抽屉共用组件 |

1. 建任务、确认、动作、项、决策和回执表；先验证唯一约束、CAS 和规范化 payload hash。
2. 实现 ActionHandler、本人 review 令牌和本地事务执行；先验证工具输出无 token，再以差旅提交联通确认到回执。
3. 接报销两阶段、OA 单经理节点；校验 pending 唯一任务、重提历史和额度联动。
4. 接 M03/M05 发布 handler 与 M10 消息 handler，验证公共包不依赖审批领域表。
5. 注入 M04 的 PreauditEligibilityPort，验证 execute 同事务资格重验和业务 CAS；接逐项结果与 unknown 核实，严格禁止重放成功项。
6. 接审批台与 Agent 抽屉，然后联调 M13/M14；删除重复的业务执行入口和前端假成功逻辑。
7. 按下面 GWT 与 02 并发矩阵验证，记录数据库版本、task、decision、receipt 和 trace 证据。

## 8. GWT 验收

| 编号 | Given / When / Then |
|---|---|
| A11-01 | Given 张伟当前两张 low 且检查完整；When 确认 clm-001/005；Then 逐项转 pending_finance、总额 124000 分，completed 指标不变。 |
| A11-02 | Given clm-002 为 attention；When 手写加入批量请求；Then prepare 拒绝该资格，不能自动删去提醒并批准。 |
| A11-03 | Given 孙静的低风险结果；When 张伟尝试用于 clm-006；Then 404，不泄露技术部门金额与人员信息。 |
| A11-04 | Given 确认绑定 v1；When 另一窗口更新为 v2 后确认；Then VERSION_CONFLICT / REVALIDATION_REQUIRED，无决策写入。 |
| A11-05 | Given 确认两张；When 客户端更改为三张但保留确认 id；Then hash/refs 不匹配拒绝，第三张不执行。 |
| A11-06 | Given 相同幂等键与参数；When 重复确认十次；Then 仅一条有效 decision 和同一结果；换参数用同键返回 IDEMPOTENCY_CONFLICT。 |
| A11-07 | Given 批次第一项成功、第二项已被处理；When 执行结束；Then 第一项保留成功、第二项冲突，UI 显示部分完成。 |
| A11-08 | Given 本地提交成功后响应丢失；When 重启后按 action_id 查询；Then 找到原成功回执，不重复创建财务任务。 |
| A11-09 | Given 外部请求超时且无明确回执；When 用户重试；Then 仅触发核实并保持 unknown，不能再次发送批准命令。 |
| A11-10 | Given 确认已过真实时间十分钟；When demo 业务时钟回拨再确认；Then 仍过期，业务时钟不能延长授权。 |
| A11-11 | Given confirmed 动作执行前 actor 失权；When Worker 接手；Then rejected，无业务写入；旧任务正文不能继续下载。 |
| A11-12 | Given 刘敏的有效财务任务；When 批准；Then completed_at、额度 consume 与回执同事务，任何位置都不产生 paid 字段。 |
| A11-13 | Given M14 在业务成功后中断；When 恢复 run；Then 查询公共 action receipt 生成结果卡，不建立新审批动作。 |
| A11-14 | Given rule.publish 与 skill.publish；When 从各自页面确认；Then 使用同一确认/动作表，同时执行各领域发布权限与版本检查。 |
| A11-15 | Given 批次某项 executing；When 用户取消；Then 未开始项取消，在途项继续核实，已成功项不被显示为已撤销。 |
| A11-16 | Given 其他会话 / 模型工具 / 无会话订阅；When 请求 GET review 或伪造 token 确认；Then 拒绝，模型日志不包含 token；本人页面刷新可取新短时令牌。 |
| A11-17 | Given clm-003 为住宿 risk 且无业务硬阻断；When 用户查看当前证据并填写说明后单笔确认；Then 可进入财务，原 risk 与说明保留。 |
| A11-18 | Given OA 未批准或额度不足产生 hard_block_reasons；When 尝试用人工说明批准；Then 无 approve 可用且服务端拒绝，不扣额度。 |
