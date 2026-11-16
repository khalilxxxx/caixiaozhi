# M04 SRS 预审中心详细设计

版本 1.0；本模块把单张与批量单据预审做成可恢复、可解释、可追溯的真实异步任务。
预审结果是辅助判断。预审完成、低风险、候选可批处理都不表示已经审批或付款。
本设计继承 [总体架构与公共契约](01_总体架构与公共契约.md)，规则解释器与字段目录由 [M03](M03_SRS规则中心.md) 提供。
所有人员、金额和规则阈值都是演示夹具；完整数据仍以 02 联调文档唯一维护。

## 1 定位与依赖

M04 负责授权单据选择、结构化输入归一化、版本冻结、规则执行、发现聚合、进度和结果保存。
M09 负责发票识别、结构化字段与材料版本；M04 不再次 OCR，也不直接修改原始单据。
M03 负责公司与个人规则集；M06 负责可验证制度引用；M12 负责 reviewer scope 与权限版本。
M14 的普通 durable_jobs 提供领域任务持久化、lease 与取消；预审不进入 Agent run_jobs，M01 展示 preaudit_summary 卡片及 preaudit 抽屉。
M11 负责所有审批、退回与批量确认；M04 只提供候选结果和执行前复核服务。
M13 注册 finance.preaudit.start/get；模型解释不参与金额计算、规则结果或审批权判定。
首期只有 expense_claim 发布完整预审 coverage manifest；travel/oa_request 可沿用协议运行局部检查，但无完整覆盖时固定 incomplete、MODULE_COVERAGE_UNCONFIGURED，不能给 low 或批量候选。
所有结果必须由实际读取的单据、规则、字段映射和工具调用产生，禁止按单据编号硬编码分组。

## 2 编号需求

| 编号 | 优先级 | 需求 |
|---|---|---|
| R04-01 | P0 | 同时支持单张、显式列表、经过授权筛选得到的固定批次 |
| R04-02 | P0 | 单批≤100 张；大范围分成可追踪预审子批次，保留原选择边界 |
| R04-03 | P0 | 每张输出规则覆盖度、证据、risk/incomplete/attention/low 分组 |
| R04-04 | P0 | 公司必查逐条保留结果，个人提醒不能覆盖公司发现 |
| R04-05 | P0 | 冻结所有影响判断的版本，变化后结果必须 stale |
| R04-06 | P0 | 真正后台执行，断线刷新后恢复进度，不能用计时器伪造完成 |
| R04-07 | P0 | 支持部分失败、只重试失败项、取消未执行项与结果历史 |
| R04-08 | P0 | 候选批量批准仅由完整、当前、本人审核范围的 low 结果产生 |
| R04-09 | P0 | 员工本人预检与主管审核不可共享个人规则或候选资格 |
| R04-10 | P0 | 模型解释失败时，确定性证据和分组仍可用 |
| R04-11 | P0 | 工具、列表、明细、SSE 和下载每次鉴权 |
| R04-12 | P1 | 展示批次耗时、错误分布与字段覆盖问题，支持治理反馈 |

## 3 身份与 reviewer scope

reviewer scope 不是前端角色切换标签，而是服务端构造的资源授权和目的组合。

| purpose | 单据范围 | 个人规则 owner | 是否可能成为批量审批候选 |
|---|---|---|---|
| employee_precheck | 当前用户本人单据 | 当前用户 | 永远 false；只帮助提交前检查 |
| manager_review | 当前用户有当前主管节点权限的单据 | 当前主管本人 | 满足全部门槛后可 true |
| finance_review | 当前用户有当前财务节点权限的单据 | 当前财务本人 | 满足全部门槛后可 true |

主管同时作为员工时必须显式选择“我的单据预检”或“待我审核”；同一单据也生成不同 scope 的结果。
purpose 从入口与已授权当前节点确定，模型只可提出候选；不能传 reviewer_id 冒充他人。
张伟只可预审销售部授权待审列表，不能因批次含一个技术部 ID 而泄露其名称或金额。
批次创建时含未知或无权 ID，整体返回统一 404，未授权项不得进入任务；不在返回体枚举哪些 ID 存在。
任务启动后的撤权通过 authz_version 检查终止相应读取；已持久结果立即失去原用户可见性。
财务查看张伟预审历史只允许获授的业务审计视图；不能直接使用其 low 结果执行财务节点审批。

## 4 用户旅程与页面结构

### 4.1 主管批量预审

1. 张伟点击“待我审核”，M01 创建会话并展示真实待办概要；首页加载不会自动发起预审。
2. 选择当前 5 张待审，界面显示选中数量、金额、节点以及“按当前规则预审”。
3. 点击开始无需审批式确认；POST /preaudit/tasks 固定这些 document refs，返回 task_id/status/total/origin_run_id；对话发起关联既有 run，独立预审页 origin_run_id=null。
4. 卡片展示排队、正在读取、已完成 X/5、失败数；不将排队时间包装成检查进度。
5. 每张完成即更新同一卡片 revision，抽屉逐条展示分组和证据，刷新从服务端恢复。
6. 完成时展示低风险 2 张 1240.00 元、个人关注 1 张、风险 1 张、缺失 1 张。
7. 用户点击“查看低风险 2 张”，核对两张金额、规则覆盖、证据和当前节点。
8. 用户点击“批量批准”，M11 prepare action 再次验证两张结果；选择与版本写入确认意图。
9. 显式确认后 M11 逐项审批，M04 只消费回执并将已推进节点的历史结果标 stale。
10. 其余单据仍可打开、询问原因或经 M11 退回；模型不能用预审风险自动退回。

### 4.2 员工提交前预检

员工选择自己的 draft 报销，系统使用 evaluation_date 和该员工个人规则进行预检。
卡片可显示 low，但同时注明“提交前预检，提交后按正式版本重新检查”，不能出现批准按钮。
员工点击“补充材料”进入 M09；保存材料会产生新版本，旧结果立即 stale，需重跑。
自然语言“帮我把问题修好”只能产生 M09 draft_proposal，修改经过采纳后才写入。

### 4.3 界面与异常状态

| 页面或状态 | 必须展示 | 可操作项 |
|---|---|---|
| task queued | 排队位置可得时展示，提交时刻、批次范围 | 取消、查看选择 |
| task running | pending/running/completed/failed 真实计数 | 查看已完成项、取消后续 |
| task partial_failed | 成功结果、失败项及可重试原因 | 仅重试失败项、导出授权摘要 |
| item stale | 失效原因、变更版本、原检查时刻 | 刷新单据、重新预审 |
| 风险详情 | 所有发现、命中规则、实际值与标准、来源 | 打开单据、制度、准备退回 |
| 缺失详情 | 无法检查的必查项与具体缺字段 | 打开补料入口、重新检查 |
| 个人关注 | 属于谁的提醒、阈值及适用范围 | 查看个人规则、单张人工处理 |
| 低风险详情 | 必查完成比例、个人检查完成、候选资格 | 有权时准备批量批准 |
| 依赖不可用 | 已检查项仍保留、失败提供方和中文原因 | 重试，禁止假装零问题 |

抽屉 URL 使用 ?drawer=preaudit&resource=<task_id>，内部选中 result_id 写入受控路由状态。
每张金额显示含税单据金额；发现可定位到费用行或发票，不能用发现条数代替单据数量。

## 5 状态机与终结语义

预审任务固定 queued/running/completed/partial_failed/failed/cancelled。
单据处理固定 pending/running/completed/failed/stale；不能增加 passed 或 approved 作为处理状态。

| 转换 | 条件 | 处理 |
|---|---|---|
| queued → running | Worker 成功获得 lease | 写启动时间与 attempt，不重复创建 items |
| pending → running | 调度当前项且授权仍有效 | 固定或验证输入版本 |
| running → completed | 规则输出及覆盖证明提交成功 | 保存 result 与 findings 后更新计数 |
| running → failed | 输入取得或编译依赖不可恢复失败 | 保存标准错误与 retryable |
| completed → stale | 任一锁定维度失效 | 保留原结果，只移除当前可操作资格 |
| running → completed task | 所有项目成功产生结果 | risk/incomplete 仍属检查成功 |
| running → partial_failed | 至少一项 completed 且至少一项 failed | 清晰区分业务发现与技术失败 |
| running → failed task | 所有项目均 failed 或批次基础依赖失败 | 不显示“全部不合规” |
| queued/running → cancelled | 接收取消并停止未开始项目 | 保留已完成结果；pending 项标记 cancellation_skipped_at |

取消不扩展 item 状态枚举；未开始项仍 pending 且有 skipped_reason=task_cancelled，不再调度。
运行中纯规则评估可在安全点停止，未提交结果的 item 回 pending 并记录取消原因；不对外宣称已检查。
任务 completed 后收到版本变更仍保持“此批检查完成”的历史事实，相关 item 为 stale、候选数为 0 或减少。
Agent run 由 M14 独立管理；产出完整部分失败报告的 run 可 succeeded，不能替换 task partial_failed。

## 6 领域模型与表约束

| 实体 | 核心字段 | 约束 |
|---|---|---|
| preaudit_task | owner_id、purpose、scope_hash、selection_json、status、origin_run_id、counts | tenant+actor+operation+key 幂等 |
| preaudit_item | task_id、document_type/id、requested_version、status、attempt、last_error | task+document 唯一；选择去重 |
| preaudit_lock | item_id、document_version、materials_version、ruleset_hash、mapping_hash | 不可变；包含全部锁定维度 |
| preaudit_result | item_id、lock_id、group、coverage_json、eligible_for_bulk_approval、result_hash | 原始结果不可原地变更；freshness 另投影 |
| preaudit_finding | result_id、rule_ref、kind、truth、field_refs、actual、expected、citation_refs | 保留次要发现；无权字段脱敏 |
| preaudit_evidence | result_id、source_ref、field_pointer、value_hash、captured_at | 能追到源对象与版本，不只写自然语言 |
| preaudit_explanation | result_id、text、model_call_id、status、evidence_refs | 可选；不包含权威 group 或金额字段 |
| preaudit_invalidation | result_id、dimension、old_version、new_version、occurred_at | 追加写入；支持审计和卡片更新 |

公共实体字段与时间格式沿用总体契约；任务、结果、finding 外键必须同 tenant。
输入快照只保存本次所需字段、值来源和 hash；不在日志复制整份含隐私附件内容。
结果不能引用未提交输入快照；result、findings、evidence、item.completed 在同一事务提交。
任务计数从 item 状态聚合或事务维护，不能依赖浏览器加一；并发重复完成不会使 completed_count 超额。
结果主键不可作为 ResourceRef 新 type；卡片 payload 引用 result_id，resource_refs 仍使用单据、rule、policy。

## 7 版本锁定与失效矩阵

```ts
type PreauditVersionLock = {
  document_ref: ResourceRef;
  materials_version: number;
  invoice_versions: Array<{id:string;version:number}>;
  external_refs: ResourceRef[];
  company_ruleset_revision: number;
  company_rule_refs: ResourceRef[];
  personal_ruleset_revision: number;
  personal_rule_refs: ResourceRef[];
  field_catalog_version: number;
  mapping_versions: Array<{id:string;version:number}>;
  policy_refs: ResourceRef[];
  reviewer_id: string;
  reviewer_purpose:'employee_precheck'|'manager_review'|'finance_review';
  reviewer_scope_hash:string;
  authz_version:number;
  approval_task_id:string|null;
  approval_task_version:number|null;
  effective_basis:string;
  basis_date:string;
};
```

| 变化 | 失效结果 | 重跑要求 |
|---|---|---|
| 单据金额、费用行或业务状态变化 | 该单据所有相关 scope 结果 | 获取新版本 |
| 附件替换、OCR 复核、票据字段变化 | 依赖相应材料的结果 | 使用新 materials/invoice versions |
| 公司规则启用、停用、修订 | 受影响模块与日期范围结果 | 解析新公司规则集 |
| 当前审核人个人规则变化 | 该 owner+purpose 的结果 | 不影响其他审核人的个人集合 |
| 映射或字段目录变更 | 依赖该映射/目录的结果 | 重新归一化输入 |
| 制度引用撤回、替代或授权失效 | 使用该来源的结果 | 先完成规则来源复核 |
| 审核人变更、调岗、撤权 | 对应 reviewer scope 结果 | 由当前有权人重新预审 |
| 当前审批节点推进 | 原节点结果 | 下一节点不能继承批量候选资格 |

outbox 失效通知用于及时更新界面；M11 执行前始终同步重验，不能依赖通知必达来保证正确性。
锁定只保证检查输入一致，不要求长时间数据库锁住单据；运算期间变更由提交前的版本比对发现。
提交结果时版本已变，保存历史结果并将 item=stale，不曾短暂发布 eligible=true。

## 8 覆盖度 分组与候选算法

公司必查覆盖集合由 M03 resolveRuleSet 与该模块已发布 coverage manifest 决定，包含全部注册规则的适用性判定证据。
coverage 必含 company_required_total、company_known_total、company_unknown_total、company_not_applicable_total、company_missing_evidence_total。
另含 personal_selected_total、personal_known_total、personal_unknown_total、missing_fields[]、failed_dependencies[]。
规则真值 true/false 都属于已检查；unknown 不属于已覆盖。missing_evidence 是已检查但材料不满足，不能因覆盖为 100% 判 low。
加载失败不允许把 required_total 置为 0；clm-004 金额90000分已知，票据核验事实 unknown→unresolved_required→incomplete。
确知缺材料时的 false+missing_evidence 用于独立测试用例，不能改写 clm-004 的 pending 核验语义。
输入缺失而导致 applicability unknown 的规则属于必查未覆盖；明确不适用才能单独计数。
company_required_total 为适用 true 或适用性 unknown 的必查数量；明确 not_applicable 单列且不进入分母，known_total 只计已知 true/false 的适用规则。
clm-001 展示“适用公司必查1/1，另2项不适用；个人提醒1/1”，不混合百分比掩盖缺失；此计数来自02三条公司规则逐条解析。

1. 逐条执行适用公司规则；false 按规则 failure_kind 生成 company_violation 或 company_missing_evidence，unknown 生成 unresolved_required。
2. 执行当前使用人当前 purpose 的全部已启用个人规则，true 生成 personal_attention。
3. 个人规则 unknown 保留 unresolved_personal；首期为了候选可靠性，也归入 incomplete 的无法判断项。
4. 存在 company_violation 则 group=risk；仍保留所有缺失和个人关注发现。
5. 无公司违规但有 company_missing_evidence、必要 unknown 或来源复核阻塞，则 group=incomplete。
6. 前两类不存在且命中个人提醒，则 group=attention。
7. 必查集合已解析完整、全已知、个人检查完整且无命中，才 group=low。
8. low 之后独立计算是否有当前节点审批权、版本有效、本人 scope 一致，再决定候选资格。

```ts
eligible = group === 'low'
  && companyRequiredResolved && companyUnknown === 0
  && personalSetResolved && personalUnknown === 0
  && versionsCurrent && authzCurrent
  && reviewerId === actor.user_id
  && purpose !== 'employee_precheck'
  && hasCurrentApprovalNodePermission;
```

unknown 需要人工补充或重新取数，不能解释成明确违规；risk 是确定规则不符合，不是模型主观风险分数。
首期不存在 no_required_rules 特例：空规则集、未配置完整模块覆盖或 manifest 不能解析均为 incomplete，不能按空集全真推得 low。
候选集合返回每项 result_id、document_ref、task_ref:{id,version} 与 purpose；task_ref 对应当前 assigned approval task，不只返回可能重号的 version。
单批预审最多100张；交给 M11 的一次批量确认最多50张，界面要求用户明确选择每批范围，不能自动拆批并连续执行审批。

## 9 API 工具与 JSON 示例

| 方法与路径 | 请求 | 响应 |
|---|---|---|
| POST /preaudit/tasks | purpose、documents[] | 202 task_id/status/total/origin_run_id；规则由服务端解析和冻结 |
| GET /preaudit/tasks/{id} | 可选 cursor | task、counts、items、next_cursor |
| GET /preaudit/results/{id} | 无 | 锁定摘要、发现、证据、候选原因 |
| POST /preaudit/tasks/{id}/cancel | expected_version | 202 取消请求，之后返回真实终结状态 |
| POST /preaudit/tasks/{id}/retry | expected_version、failed_item_ids[] | 202 新子任务、retry_of_task_id |
| GET /preaudit/tasks/{id}/bulk-candidates | 无 | 当前可候选结果及被排除原因 |
| POST /confirmations | action=approval.batch_approve、resource_refs、args.items | 每项 resource_id/task_ref/preaudit_result_id；交 M11 |

```json
{"purpose":"manager_review","documents":[{"type":"expense_claim","id":"clm-001","version":1},{"type":"expense_claim","id":"clm-005","version":1}]}
```

```json
{"data":{"task_id":"pa-101","status":"queued","total":2,"origin_run_id":"run-101"},"meta":{"request_id":"req-101","trace_id":"tr-101","server_time":"2026-11-05T03:00:00Z","data_mode":"demo"}}
```

```json
{"data":{"result_id":"pr-clm001","document_ref":{"type":"expense_claim","id":"clm-001","version":1},"status":"completed","group":"low","amount":{"amount_minor":"68000","currency":"CNY"},"coverage":{"company_required_total":1,"company_known_total":1,"company_unknown_total":0,"company_not_applicable_total":2,"company_missing_evidence_total":0,"personal_selected_total":1,"personal_known_total":1,"personal_unknown_total":0},"eligible_for_bulk_approval":true,"eligibility_reasons":[],"findings":[],"snapshot_at":"2026-11-05T03:00:10Z"},"meta":{"data_mode":"demo","request_id":"req-102","trace_id":"tr-101"}}
```

上例对应02真实 clm-001：票据规则通过，住宿/OA规则明确不适用；其他单据必须逐条解析，不能复制示例计数。
company_required_total 仅计适用必查；company_not_applicable_total 是额外说明，不重复加进分母。

```json
{"name":"finance.preaudit.start","version":"1.0.0","run_id":"run-101","call_id":"call-101","arguments":{"purpose":"manager_review","documents":[{"type":"expense_claim","id":"clm-001","version":1}]}}
```

finance.preaudit.start/get 均为1.0.0；get 的 arguments 只有 task_id，返回公共 ToolResult，证据引用必须可回查。
start 的 HTTP 与工具 required 完全一致：purpose、documents；additionalProperties=false。调用方不提供个人规则版本集合。
purpose 必须由界面/对话澄清确定并经服务端节点授权校验；未能确定时工具 requires_input，不猜测审核目的。
M04 的 snapshot builder 在校验单据范围后，逐单调用 M03 resolveRuleSet(ctx,document,purpose,basisDate)，解析并冻结全部适用公司规则和当前 actor+purpose 的已启用个人规则。实际版本列表与规则集 hash 存在任务快照及结果中供用户查看，不能从模型或旧聊天推断。规则在任务排队后变化时，以实际冻结时版本为准；冻结后变化按 stale 机制处理。
本期调整个人规则范围通过 M03 启停完成，不在单次预审请求中漏传或替换集合来跳过提醒。没有个人规则时由服务端记录合法空集合及修订号；他人个人规则从不加载，模型不能改 reviewer 身份。
单据列表筛选先在 M02 固定为 documents；不接受任意筛选字符串并在 worker 中重新扩大列表。
202 的 origin_run_id:string|null 来自可信调用上下文，禁止客户端指定他人 run；预审任务从不创建 Agent run。
独立预审页面轮询 /preaudit/tasks/{id}；仅绑定现有 run 时通过 GET /runs/{id}/events 的 card.upsert 透出进度。
run.status 仅表示原 Agent 编排状态，不替代预审 task 状态；run 中断后领域任务仍可独立查询。
禁止创造与公共事件不兼容的 progress.percent 事件；需要新事件必须先修改公共契约。

```json
{"status":"ok","data":{"task_id":"pa-101","status":"queued","total":1,"origin_run_id":"run-101","poll_after_ms":1000},"evidence_refs":[],"action_id":null,"error_code":null}
```

给 M11 的请求必须使用其统一命名；task/result id 均取最新授权响应，不能由单据编号拼造。
```json
{"action":"approval.batch_approve","resource_refs":[{"type":"expense_claim","id":"clm-001","version":1}],"args":{"items":[{"resource_id":"clm-001","task_ref":{"id":"at-001","version":1},"preaudit_result_id":"pr-clm001"}]}}
```

## 10 执行流程 与故障恢复

Worker 先校验范围、读取真实单据和材料版本，再取得 company/personal ruleset、映射、外部事实与制度引用。
结构化输入、来源版本及授权锁定提交后，纯规则解释器执行；外部网络调用不放进解释器。
规则执行成功后保存确定性结果，再选择性启动模型解释；解释只能引用 finding/evidence IDs。
解释提示与输出校验禁止新增事实、改分组、删缺失项；没有证据的解释句子被丢弃或标为推测。
模型解释超时只将 explanation.status=failed，页面保留规则模板解释，不能使已完成预审降为技术失败。
外部依赖超时默认重试 2 次，退避由 M14 调度；可重试获取，不重复执行任何审批写入。
批次项目默认并行度 4，按 tenant/user 公平调度；值是配置初值，不是已测性能承诺。
每项 lease 默认 30 秒、10 秒续约；崩溃后只恢复未持久提交项，完成项通过唯一键跳过。
如果持久事务结果未知，先查询 item/result，再决定重算；不能产生两个有效 result_hash 不同的“同次结果”。
retry 接口只接受原任务 failed 项，创建新子任务并重新冻结当前版本；旧成功结果和旧失败记录保持可追溯。
若用户要求重跑 stale 项，创建普通新任务并记录 rerun_of_result_id，不能把 stale 伪装为 failed 重试。
父批次可展示每张最新子任务结果，但每项明确显示检查时刻与规则版本，不能声称全批是同一次快照。
基础规则集不可用时任务 failed；已解析规则但单字段外部事实缺失时产生 completed+incomplete。
取消后的模型解释和未开始项停止；已完成结果可查看，审批 action 如已创建由 M11 独立核实与取消。

## 11 Codex 实施分阶段指令

### 阶段一 契约 持久任务与范围校验

建立 packages/contracts/src/preaudit.ts，冻结任务、item、group、lock、coverage、finding 与严格请求 schema。
建立 apps/api/src/modules/preaudit/{routes,repository,service,authorization}.ts 和对应数据库迁移。
签名：startPreaudit(ctx:ActorContext,cmd:StartPreauditCommand):Promise<PreauditTaskAccepted>。
断言：重复 idempotency key 只有一个 task；带 clm-006 的张伟批次整体 404；刷新保留选中 refs。

### 阶段二 快照与纯执行

建立 snapshot-builder.ts、rule-runner.ts、classify.ts、eligibility.ts；调用 M03，不复制解释器。
从 ExpenseAdapter.getPreauditInput 原子取得 M03 的 SrsInputSnapshot；input/provenance 不分两次读取，approval_task_id/version 与授权信息由 M04 追加冻结。
签名：buildInput(ctx,item):Promise<{input:SrsInput;lock:PreauditVersionLock}>。
签名：evaluateSnapshot(input,ruleSet):DeterministicPreauditResult；classify(findings,coverage):RiskGroup。
断言：缺失金额不变 0；公司违规与个人命中并存仍 risk；employee_precheck low 的 eligible=false。

### 阶段三 可靠执行与界面

建立 apps/worker/src/runner/preaudit-worker.ts，调用 M14 lease/outbox；每项完成事务化提交。
建立 apps/web/src/features/preaudit/{TaskCard,TaskDrawer,FindingList,CoveragePanel,BulkCandidatePanel}.tsx。
断言：断 SSE 后续接不重复计数；杀 Worker 后只恢复未完成项；partial_failed 保留成功结果。

### 阶段四 失效与审批交接

M11 的唯一资格读取端口放 packages/contracts/src/preaudit-eligibility.ts；具体实现留在 M04，无跨模块直接查表。
```ts
type PreauditEligibilityInput = {
  resource_ref:ResourceRef;
  task_ref:{id:string;version:number};
  preaudit_result_id:string;
  expected_purpose:'manager_review'|'finance_review';
  expected_guards?:{result_hash:string;lock_hash:string};
};
type EligibilityProof = {
  eligible:boolean; result_id:string; reviewer_id:string;
  result_hash:string; lock_hash:string; locked_versions:PreauditVersionLock;
  checked_at:string; rejection_reasons:string[];
};
interface PreauditEligibilityPort {
  check(ctx:ActorContext,input:PreauditEligibilityInput,tx?:UnitOfWork):Promise<EligibilityProof>;
}
```
prepare 调用 check 并把返回 hashes/locked_versions 写 confirmation.extra_guards；execute 传 expected_guards 在 M11 当前事务重验。
check 校验当前 reader、assigned task 与版本、结果归属、purpose、所有来源和规则锁；无权统一404，不返回他人证据。
Demo execute 的资格重验与业务CAS在同一事务，锁相关 revision guard 行；版本变化返回 REVALIDATION_REQUIRED，不写 decision。
MaaS 无法提供等价原子版本条件时禁用 bulk capability，不以客户端已经看到 low 替代执行保证。
消费单据、材料、规则、映射、权限和制度 outbox；失效原因可追踪到一项或整个范围。
断言：准备确认后新增个人提醒、改材料或审批节点变化，M11 必须 REVALIDATION_REQUIRED 且不批准。

### 阶段五 解释与运维

实现 explainResult(ctx,resultId) 的可选模型调用，输出只允许 text 和 evidence_refs。
增加任务队列等待、单项耗时、unknown 比例、lease 恢复、解释失败、stale 原因等指标。
记录一次真实模型集成轨迹与一次模型断开演示；业务确定性断言不得依赖模型输出措辞。

## 12 GWT 验收用例

| 编号 | Given | When | Then |
|---|---|---|---|
| A04-01 | 张伟有销售 5 张待审授权 | 执行批量预审 | 2 low/1 attention/1 risk/1 incomplete |
| A04-02 | low 为 clm-001 与 clm-005 | 查看候选金额 | 精确 124000 分，不包含 clm-002 |
| A04-03 | clm-004 金额已知、票据核验 pending | 执行必查 | unknown→unresolved_required→incomplete，明确未覆盖核验 |
| A04-04 | clm-003 住宿超公司标准 | 执行个人宽松规则 | risk 且保留公司实际值与标准 |
| A04-05 | 李娜执行本人 clm-002 预检 | 解析个人规则 | 不加载张伟提醒，不能获得审批候选资格 |
| A04-19 | 张伟新增或更新个人提醒但 Agent 不知道版本 ID | 仅用 purpose/documents 启动预审 | 服务端解析当前适用版本并冻结，启动无需额外读取规则工具；伪造 personal_rule_version_ids 参数被 strict schema 拒绝 |
| A04-06 | 张伟传入 clm-006 | 创建批次 | 404，任务未创建，不透露技术部信息 |
| A04-07 | 某项 completed 后浏览器断线 | 重连 after seq | 恢复同一结果且计数不翻倍 |
| A04-08 | 5 项中 1 项技术失败 | 批次结束 | task partial_failed，可只重试该项 |
| A04-09 | 子任务重试时单据已变 | 新一轮检查 | 冻结新版本并保留原失败历史 |
| A04-10 | 已有 low 结果 | 材料版本更新 | item stale，候选资格即时取消 |
| A04-11 | low 已进入确认框 | 张伟新增个人提醒 | 执行被 REVALIDATION_REQUIRED 拒绝 |
| A04-12 | 员工自身预检为 low | 构造批量批准请求 | 不能作为主管结果使用 |
| A04-13 | 确定性检查完成且模型解释超时 | 展示结果 | 分组仍可用，模板证据解释完整 |
| A04-14 | Worker 在结果提交后崩溃 | lease 恢复 | 不重复插入结果、不重复计数 |
| A04-15 | 用户取消且已有 2 项完成 | 任务终结 | 保存 2 项结果，未开始项标明取消未检 |
| A04-16 | clm-001/005 已经批准到财务 | 再用主管结果 | 原结果 stale，财务需本人 scope 预审 |
| A04-17 | 公司规则集读取失败 | 开始检查 | failed，不把“0 条规则”显示为 low |
| A04-18 | 同一项同时明确违规与缺失 | 展示详情 | 主分组 risk，同时展示缺失证据 |

## 13 完成门槛

A04 全部通过，基准种子结果由实际规则解释产生；不能在测试或业务代码中按 clm ID 返回分组。
完成单批 100 张的恢复与取消演练，记录实际时延、内存和数据库压力；不以 UI 动画替代执行。
接口具备跨租户、权限变更、版本失效、幂等冲突、部分失败和 outbox 延迟测试。
交付任务状态迁移、快照字段清单、发现 schema、运维查询和 M11 交接契约。
操作指南说明“预审完成”“低风险”“待确认审批”“已审批”四种产品语义及其真实来源。
