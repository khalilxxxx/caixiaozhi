# M08 差旅申请系统 Demo 详设

版本：1.0｜实现深度：简易可运行 Demo｜依赖：[总体架构与公共契约](01_总体架构与公共契约.md)。

## 1. 模块目标与责任边界

差旅 Demo 保存员工的多段行程、交通住宿预算和成本中心，并通过公共动作与审批服务完成提交、审批、退回、撤回和重新提交。
独立业务页面与 Agent 抽屉读取同一 travel_requests / travel_legs；刷新、切换入口、Worker 重启后状态一致。
本模块不购票、不订房、不付款，不实现航班库存或真实酒店报价；预算是申请人提供的申请金额。
AI 只提出结构化草稿差异；保存结果必须来自数据库事务，不能由模型文字或前端内存声明成功。

| 依赖 | 本模块调用内容 | 边界与交付方 |
|---|---|---|
| M12 | ActorContext、部门、成本中心、城市候选 | 身份与字典由 M12 授权并版本化 |
| M06 | 用户当前选择的可访问材料引用、抽取文本 | 不读取未选择文件；不直接操作知识库索引 |
| M01 | document_summary、draft_proposal、详情抽屉 | 卡片绑定 travel.id + version，卡片不是单据副本 |
| M11 | confirmations/actions、经理审批、回执 | 统一执行器负责确认、CAS、幂等与审批任务 |
| M13 / M14 | propose_patch 工具、上下文与运行恢复 | dsh 不直接写数据库，不持有通用数据库账号 |
| M09 | 已批准差旅摘要与报销关联校验 | 报销不能改写已批准差旅的预算或行程 |
| M15 | 演示时钟和场景清理屏障 | 日期建议可用模拟业务日；审计时间用真实 UTC |

## 2. 编号功能与优先级

| 编号 | 功能 | 最小可用结果 |
|---|---|---|
| TRV-01 | 建立与保存草稿 | 返回持久 travel id、version、updated_at |
| TRV-02 | 多段行程编辑 | 添加、重排、删除行程，已有 leg_id 永久不变 |
| TRV-03 | 交通住宿与预算 | 展示分项和服务端计算总额，可追溯到每段 |
| TRV-04 | 城市语义解析 | 返回 canonical city、候选与父城市说明 |
| TRV-05 | 基于当前草稿语义填单 | 绑定本轮数据库版本与显式所选材料版本 |
| TRV-06 | 差异预览逐项采纳 | 每条显示旧值、新值、来源、影响与校验错误 |
| TRV-07 | 提交 / 重新提交 | 确认后创建唯一当前经理审批任务 |
| TRV-08 | 审批 / 退回 / 撤回 | 使用 M11 同一状态机，页面实时刷新结果 |
| TRV-09 | 详情与历史 | 显示提交快照、审批理由、修改历史和关联报销 |
| TRV-10 | 适配器替换 | 使用 TravelAdapter 端口替换未来企业差旅系统 |

## 3. 角色与权限

权限名是本项目细分项，由 M12 grants 显式配置；角色名本身不能绕过对象范围。

| 操作者 | 可读 | 可修改 | 有影响动作 |
|---|---|---|---|
| employee | 本人差旅及本人获授权附件 | 本人 draft / returned / withdrawn | travel.submit、travel.resubmit、travel.withdraw |
| manager | 授权部门当前待审和本人经办记录 | 不直接替员工改申请字段 | 本人当前 task 的 approval.approve / approval.return |
| finance | 已批准且与获授权报销关联的差旅摘要 | 无 | 无差旅审批权，除非另有明确当前任务授权 |
| platform_admin | 健康与调用元数据 | 无业务字段写权 | 无业务动作；有 demo.control 也不能读行程正文 |

列表在 SQL 条件中加入 tenant 与 scope；未知 id 和越权 id 均返回 404。
附件下载、差异来源预览、关联报销计数都重新鉴权；不会因可以看差旅而自动看到他人的报销。
被撤销部门权限后，已打开的抽屉停止加载，已签发确认在执行前拒绝，旧工具执行凭据失效。

## 4. 页面、抽屉与用户旅程

### 4.1 最简页面

| 入口 | 内容 | 操作与失败状态 |
|---|---|---|
| /travel | 本人草稿、处理中、已完成标签；状态和金额列 | 空态可新建；失败保留筛选并显示重试 |
| /travel/:id | 基本信息、可重排行程、预算、材料、历史 | 保存中禁重复；409 显示刷新与重新比较 |
| ?drawer=travel&resource=:id | 与详情页复用 TravelEditor | 授权失败显示无权或不存在，不残留缓存内容 |
| AI 建议面板 | 逐项 diff 与“采纳选中项” | 过期建议只能刷新重提，不能强行应用 |
| 提交确认 | 编号、版本、目的地、日期、总额、成本中心、经理 | 10 分钟过期；确认中显示执行状态 |
| 审批区 | 当前 task、提交快照、理由、审批历史 | 无当前任务时只读，不能从旧通知继续审批 |

### 4.2 手工填写旅程

1. 员工新建草稿，服务端从身份填申请人与部门；选择有效成本中心。
2. 添加第一段行程时由服务端产生 leg_id；保存后再次编辑只保留该 id。
3. 每段选择出发城市、到达城市、出发日期、返回或结束日期、交通方式和预算。
4. 需要住宿时填写入住、退房、房间数、每间夜预算；页面展示服务端计算的间夜数和小计。
5. 点击保存完成普通草稿写入；页面以返回 version 替换本地版本并标记已保存时间。
6. 点击提交先显示服务器校验结果；全部通过后准备 confirmation，由用户确认后执行。
7. 经理在统一审批台处理；详情、首页卡片及后续报销关联读取相同提交快照。

### 4.3 语义填单旅程

1. 用户在当前 travel 抽屉选中材料，例如“客户会议邀请 v2”；选择必须有可见复选框与材料版本。
2. 发起 propose_patch 时服务端重新加载当前 travel + legs，不采用聊天里缓存的表单 JSON。
3. 请求携带 prompt 与 selected_material_refs；服务端补入 base_version、字典版本和当前草稿快照。
4. 模型按 leg_id 生成候选操作；新增行程使用 temporary_leg_key，由应用服务采纳时分配真实 id。
5. “上海虹桥”可解析为机场地点并映射父城市上海；界面说明“地点：虹桥机场，预算城市：上海”。
6. “朝阳”“去总部”“下周回去”等多义表达显示候选或追问；不默选城市，也不提交空日期。
7. 用户逐项采纳；所有选中项合并后整体校验，成功在一个事务中更新草稿与版本。
8. 用户随后手工改结束日期，再说“加一晚酒店”，新一轮必须读取改过后的新草稿。
9. 上一轮提议晚到时标记 stale；历史聊天仅作语义解释，不得覆盖当前字段。

## 5. 数据模型与字段约束

公共字段采用统一 id / tenant_id / version / owner_id / timestamps；以下是领域增量字段。

| 表 / 字段 | 类型 | 校验与意义 |
|---|---|---|
| travel_requests.title | string | 1–100 字，去除首尾空白 |
| purpose | string | 草稿可空；提交 1–2,000 字 |
| applicant_id / department_id | string | 服务端从身份和组织快照生成，客户端不可伪造 |
| cost_center_id | string | 提交时有效且允许本部门使用 |
| state | enum | draft / pending_manager / approved / returned / withdrawn |
| total_budget | Money | 服务端汇总，客户端传入值不作为权威 |
| material_refs | array | 最多 20 项，每项有材料 id、version 和用途 |
| submitted_at / approved_at | timestamp null | 真实 UTC，由动作事务设置 |
| submitted_snapshot_id | string null | 不可变的本次提交快照 |
| travel_legs.leg_id | string | 服务端 UUID；同一差旅唯一，重排不变 |
| ordinal | integer | 从 1 连续排列；最多 20 段 |
| from_city_id / to_city_id | string null | 草稿可空；提交必须来自有效城市字典 |
| from_place_text / to_place_text | string null | 用户原文保留，不能代替 canonical city |
| departure_date / end_date | date null | 严格 YYYY-MM-DD、真实公历日期 |
| transport_mode | enum | flight / train / car / taxi / other |
| transport_budget | Money | 非负整数分，CNY；提交必须明确 |
| lodging_required | boolean | 不住宿时相关预算为 0，不保留隐藏旧金额 |
| check_in / check_out | date null | 住宿时必填；退房严格晚于入住 |
| room_count | decimal_string null | 住宿时为整数字符串 "1"–"20"；否则 null；与公共数量类型一致 |
| nightly_room_budget | Money null | 住宿时必填，按每间每晚计算 |
| lodging_budget | Money | 服务端按房间数 × 夜数 × 单价计算 |
| other_budget / other_reason | Money / string | 正金额时必须说明用途 |
| proposals.base_version | integer | 指向提议时读取的差旅版本 |
| proposals.selected_material_refs | array | 固化本轮选择及版本，不事后添加材料 |
| proposals.operations | array | 操作路径、leg_id、old/new、evidence、confidence |
| proposals.status | enum | proposed / applied / stale / rejected；独立于差旅 state |

### 5.1 日期与金额的明确规则

- 日期用严格解析器验证闰年与月份；2026-02-29、2026-04-31、2026/11/05 均拒绝。
- 每段 end_date >= departure_date；整单跨度不超过 366 天；不把 UTC 时间戳截断作为业务日期。
- 相邻段 departure_date >= 上一段 end_date；同日衔接合法；确需重叠不在本期支持范围。
- 同一行程 from_city_id 与 to_city_id 必须不同；市内差旅使用其他业务入口，不伪造第二个城市。
- 住宿 check_in >= departure_date，check_out <= end_date；夜数为业务日期差，不受夏令时小时数影响。
- 每个金额为匹配 `^(0|[1-9][0-9]*)$` 的 amount_minor；不接受负数、小数分、科学记数法和非 CNY。
- 单项及整单预算上限均为 100,000,000 分，即 1,000,000.00 元；超限返回字段错误，不截断。
- UI 输入人民币元，最多两位小数；用字符串精确换算分，不能 Number(value) × 100 后四舍五入。
- 总预算允许为 0，但必须用户明确填零；缺失 null 与零不能互换。
- 演示日期可根据 M15 business clock 建议；真实时间用于会话过期、确认 TTL 与审计。

### 5.2 状态转移

| 当前状态 | 命令 / 前置条件 | 下一状态 / 同事务效果 |
|---|---|---|
| draft | save，owner 且 CAS 匹配 | draft，version + 1 |
| returned / withdrawn | save，owner 且 CAS 匹配 | 原状态，version + 1；旧审批结论仅历史保留 |
| draft | travel.submit，字段完整且已确认 | pending_manager，冻结快照并创建经理 task |
| returned / withdrawn | travel.resubmit，同提交校验 | pending_manager，新提交快照和新 task |
| pending_manager | approval.approve，当前经理 task | approved，task approved，version + 1 |
| pending_manager | approval.return，理由 1–1,000 字 | returned，task returned，version + 1 |
| pending_manager | travel.withdraw，申请人且尚未决策 | withdrawn，task cancelled，version + 1 |
| approved | 任意字段保存 / 撤回 | INVALID_STATE；本期不做已批准变更单 |

保存行程和申请头采用同一 aggregate version；不能让头保存成功、某段失败却仍返回成功。
撤回与经理审批竞争只允许一个事务提交；另一个收到 VERSION_CONFLICT 或 INVALID_STATE。

## 6. HTTP 契约与接口样例

所有路径前缀 `/api/v1`；响应 envelope、错误、幂等和 CSRF 继承公共契约。

| 方法 / 路径 | 用途 | 关键输入 |
|---|---|---|
| POST /travel | 建草稿 | title、Idempotency-Key；不接收 owner_id |
| GET /travel | 列表 | cursor、limit、state；范围取服务端授权 |
| POST /travel | 创建本人草稿 | title 可省略默认“未命名差旅”；返回 id/version，owner 和部门由服务端注入 |
| GET /travel/:id | 当前草稿与状态 | 返回 version、legs、可执行动作 |
| PATCH /travel/:id | 手工保存 | expected_version、完整允许变更字段 |
| POST /travel/:id/proposals | 语义填单任务 | expected_version、prompt、selected_material_refs |
| GET /travel/:id/proposals/:proposalId | 读取提议 | 最新状态、逐项 diff、clarifications |
| POST /travel/:id/proposals/:proposalId/apply | 采纳选中差异 | expected_version、selected_operation_ids |
| GET /travel/:id/validation | 提交前校验 | 当前版本；返回字段路径与规则代码 |
| POST /confirmations | 准备提交 / 撤回等动作 | action、exact resource version、args |
| POST /confirmations/:id/confirm | 用户确认并执行 | CSRF、Idempotency-Key |

```json
{
  "expected_version": 6,
  "prompt": "第二段杭州改为宁波，再加一晚住宿",
  "selected_material_refs": [{"id":"mat-invite","version":2}],
  "focus_leg_id": "leg-b"
}
```

propose_patch 返回 202 及 task_id；完整建议必须能通过 GET 取回，不能仅在 SSE 消息里存在。

```json
{
  "id":"prop-8", "base_version":6, "status":"proposed",
  "operations":[
    {"id":"op-1","kind":"replace","leg_id":"leg-b","field":"to_city_id",
     "old":"city-hangzhou","new":"city-ningbo","evidence_refs":["mat-invite@2#p1"]},
    {"id":"op-2","kind":"replace","leg_id":"leg-b","field":"check_out",
     "old":"2026-11-12","new":"2026-11-13","evidence_refs":[]}
  ],
  "clarifications":[], "requires_review":true
}
```

若只采纳 check_out 导致超出 end_date，apply 返回 400 VALIDATION_ERROR 并指出需同时改结束日期；不自动采纳未选项。
删除行程属于明确 diff，必须显示该段全部预算和材料关联的影响；删除后其他 leg_id 不改变。

```ts
interface TravelAdapter {
  get(ctx: ActorContext, id: string): Promise<TravelAggregate>;
  validate(ctx: ActorContext, id: string, version: number): Promise<ValidationReport>;
  execute(ctx: ActionContext, command: TravelCommand): Promise<ActionReceipt>;
  getReceipt(ctx: ActorContext, externalReceiptId: string): Promise<ActionReceipt>;
}
async function proposeTravelPatch(ctx: ActorContext, input: ProposeTravelInput): Promise<ProposalTask>;
async function applyTravelPatch(ctx: ActorContext, input: ApplyProposalInput): Promise<TravelAggregate>;
```

execute 只接受 M11 构造的 ActionContext；工具参数不能伪造 confirmed=true 或传审批结果。
适配器的未来外部未知结果映射 unknown；由 M11/M14 查询回执后再刷新卡片。

## 7. 实现文件与 Codex 实施顺序

| 文件 | 责任 |
|---|---|
| packages/contracts/src/travel.ts | schema、日期和金额边界、提议操作类型 |
| apps/api/src/modules/travel/schema.ts | requests、legs、snapshots、proposals 表 |
| apps/api/src/modules/travel/service.ts | 草稿聚合保存、校验、提议采纳 |
| apps/api/src/modules/travel/action-handlers.ts | M11 注册的 submit / resubmit / withdraw handlers |
| packages/business-adapters/src/ports/travel.ts | 可替换端口与领域错误 |
| packages/business-adapters/src/demo/travel.ts | 事务服务代理；不重复状态机 |
| apps/web/src/features/travel/TravelEditor.tsx | 页面与抽屉共用表单 |
| apps/web/src/features/travel/ProposalDiff.tsx | 逐项采纳、来源与冲突展示 |

1. 先实现 schema、migration、纯日期与 Money 校验，固定腿级 ID 的唯一约束。
2. 实现当前身份读取、范围查询与 aggregate CAS 保存；用真实 PostgreSQL 验证刷新可恢复。
3. 实现手工表单与服务端预算返回，前端小计只作输入反馈。
4. 注册 M11 业务 handler，接通提交快照、经理 task 与 outbox 状态事件。
5. 实现城市解析候选与材料选择，再接 propose_patch 任务；可用确定性模型桩验证结构。
6. 实现逐项 diff、原子 apply、旧提议 stale 与手工编辑后重新取 draft。
7. 接入 M01 卡片、M09 差旅关联、M15 场景；最后跑下列核心旅程。

## 8. Given When Then 验收

| 编号 | Given | When | Then |
|---|---|---|---|
| TRV-A01 | 李娜有两段草稿 v3 | 保存后重载页面和抽屉 | 两入口字段、预算和 version 完全一致 |
| TRV-A02 | 第一段 leg-a，第二段 leg-b | 重排行程后对 leg-b 提议改城市 | 只改变原 leg-b，不按数组下标误改 |
| TRV-A03 | 建议基于 v6，用户手工保存成 v7 | 采纳旧建议 | 返回 409，v7 所有字段保持原值 |
| TRV-A04 | 当前草稿 v7 已手工延长日期 | 下一轮说“加一晚” | 工具读取 v7，提议基于新日期而非聊天旧值 |
| TRV-A05 | 输入“朝阳” | 生成行程建议 | 返回多候选或澄清，不默存任意城市 |
| TRV-A06 | 输入上海虹桥机场 | 采纳地点解析 | 显示机场原文及父城市上海，城市 id 有字典依据 |
| TRV-A07 | check_out 比 end_date 晚一天 | 只采纳住宿日期变化 | 400 并给字段错误，整个 apply 不写入 |
| TRV-A08 | 日期 2026-02-29 或预算 12.345 元 | 保存 / 提交 | 对应字段拒绝，不能自动改日期或舍入金额 |
| TRV-A09 | travel v4 待审 | 员工撤回与经理批准并发 | 只一个成功，一个冲突，只有一个终局 task |
| TRV-A10 | 经理退回并给理由 | 员工修改后确认重新提交 | 创建新快照和新 task，历史退回理由仍可查 |
| TRV-A11 | 张伟仅有销售权限 | 访问陈杰技术部 travel id | 404；附件、卡片与工具均不能泄漏内容 |
| TRV-A12 | 提交已执行但响应丢失 | 相同 key 重试 | 返回原 action receipt，不重复经理任务 |
| TRV-A13 | 用户未选择材料 B | Agent 请求 B 内容作填单依据 | 网关拒绝或要求重新选择，不隐式扩展范围 |
| TRV-A14 | 行程已 approved | 前端旧草稿发起 PATCH | INVALID_STATE，不产生被修改的已批准单据 |

## 9. 完成与联调检查

交付应包含启动说明、上述端点的契约测试、同一 Postgres 上的跨入口演示，以及精确记录 action / travel / task 版本的审计样例。
Demo 可使用简单 HTML 表单与表格，但所有成功提示都必须对应持久化结果；禁止用 localStorage 保存权威草稿或审批状态。
后续接企业差旅系统时保持 TravelAdapter、ResourceRef 和 M11 回执语义，替换实现不能放宽权限与确认边界。
