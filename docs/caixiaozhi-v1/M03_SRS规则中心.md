# M03 SRS 规则中心详细设计

版本 1.0；面向产品、后端、前端、测试及 Codex 实施者。
本模块将自然语言制度或个人关注转换为经过确认、测试、版本管理的确定性规则。
本设计遵循 [总体架构与公共契约](01_总体架构与公共契约.md)；字段夹具与金额以 02 联调文档为最终来源。
本文中的接口、DSL、服务签名是财小智项目契约，不是 dsh 原生 API。

## 1 定位 依赖与交付边界

SRS 只接收结构化 JSON，输出规则判断、字段证据和未知原因；不读取图片，不执行 OCR，不决定是否审批。
公司强制规则与当前使用人的个人提醒分别保存、分别执行，最终共同输入 M04 的分组器。
首期不实现公司、团队、个人三级继承覆盖；公司规则的部门适用条件只是过滤范围，不产生下级覆盖权。
个人规则不能关闭、替换、降低公司标准，不能产生自动批准、自动退回或自动发送消息的动作。
M09 提供已确认票据和报销字段；M08/M10 提供差旅、招待关联字段；M12 提供真实身份及数据范围。
M06 提供已发布制度的不可变段落引用；M13 注册受控工具；M14 执行模型草稿任务；M11 提供统一确认执行器。
M01 使用 rule_proposal 卡片与 rules 抽屉；M02 可以提出创建规则建议，但记忆保存不等于规则启用。
产品级交付包括规则编辑器、编译器、测试器、差异比较、发布确认、映射治理和审计记录。

## 2 编号需求与优先级

| 编号 | 优先级 | 可验证需求 |
|---|---|---|
| R03-01 | P0 | 类别只允许 invoice/transport/lodging/meals/itinerary/general |
| R03-02 | P0 | 支持公司强制和个人提醒两种层级，禁止覆盖公司规则 |
| R03-03 | P0 | 自然语言生成待确认草稿，原始意图与结构化解释同时保存 |
| R03-04 | P0 | 未明确范围、计量单位或比较边界时必须进入澄清，不能猜测启用 |
| R03-05 | P0 | 结构化表单可手改，服务端重新校验、编译和测试 |
| R03-06 | P0 | 每次发布生成不可变版本；运行时锁定版本与映射版本 |
| R03-07 | P0 | 白名单 DSL 确定性执行，禁止 eval、脚本、任意 URL 和任意 SQL |
| R03-08 | P0 | 缺失、未映射、外部字段获取失败产生 unknown，不能转成 pass |
| R03-09 | P0 | 发布前运行包含边界值与缺失字段的测试集，并展示与上版差异 |
| R03-10 | P0 | 启用、发布、停用通过 M11 确认；草稿保存无需审批式确认 |
| R03-11 | P0 | 外部字段只能通过人工确认的字段映射进入规则 |
| R03-12 | P0 | reviewer scope 区分本人预检、主管审核、财务审核 |
| R03-13 | P1 | 支持复制旧版本为新草稿、导出规则说明及查看命中历史摘要 |
| R03-14 | P1 | 模型不可用时仍可手工创建、测试、启用确定性规则 |

## 3 角色 权限与数据范围

| 角色 | 可读 | 可写 | 边界 |
|---|---|---|---|
| 员工 | 对本人适用的公司规则说明、本人个人规则 | rule.manage.personal 下管理本人规则 | 不读取他人的提醒或完整公司测试数据 |
| 主管 | 适用公司规则、本人审核提醒 | 管理自己的 review_queue 规则 | 部门范围来自 M12 授权，不由提示词扩大 |
| 财务 | 授权范围内公司规则和映射 | rule.manage.company 下编辑公司规则 | 公司规则发布仍需明确确认 |
| 平台管理员 | 规则运行的脱敏诊断元数据 | 无默认业务规则权限 | operations.read 不隐含规则内容可读 |

rule.manage.company 同时需要该规则组织范围的管理授权；全租户规则要求全租户管理范围。
个人规则 owner_id 必须等于 ActorContext.user_id；请求中的 owner_id、reviewer_id 不参与身份推导。
公司规则的可见说明与可管理 DSL 分离；员工可查看适用标准，不默认读取内部测试样本中的其他员工字段。
查看版本差异、样例输入、历史命中明细、导出说明均再次鉴权；缓存键含 tenant、actor、authz_version。
跨租户或无权枚举资源统一返回 404；已授权规则上的发布动作无权返回 403。

## 4 关键旅程与界面状态

### 4.1 自然语言创建个人提醒

1. 张伟输入“我部门餐饮费超过 1000 元时提醒我”，M01 调用 finance.rules.propose。
2. 服务端创建个人草稿，确认 owner=u-zhang，提出 reviewer_purpose=manager_review 与部门授权候选。
3. 卡片显示“范围：销售部待审；阈值：严格大于 1000 元；计量：待确认”。
4. 抽屉只问缺失项：“按每张报销单餐饮合计、每人每天，还是每张发票？”；不预选替用户同意。
5. 用户选每张报销单餐饮合计，草稿更新为 sum(meals.amount) > 100000 分。
6. 用户可改阈值、比较符、类别、范围；每改一次草稿 version 递增，并使旧测试证明失效。
7. 用户点击样例测试，展示 999.99、1000.00、1000.01 元及未知金额的真实解释轨迹。
8. 用户查看与现行版的差异，点击启用，确认框展示范围、边界、版本及“仅提醒”的影响。
9. M11 确认执行器调用 activateRule；成功后返回真实 action receipt，再更新卡片为已启用。
10. M04 后续对张伟待审任务使用此版本；clm-002 命中 attention；员工李娜自身预检不使用张伟规则。

### 4.2 公司规则管理

公司规则列表默认展示当前版本、生效日期、适用模块、测试状态、来源制度、映射依赖及待复核标记。
编辑已启用规则时创建新草稿；运行中的旧版本保持不可变，不能原地改 DSL。
发布差异必须包含阈值、gt/gte、计量单位、范围、缺失处理、来源引用和映射版本的变化。
公司制度来源更新后显示“来源需复核”；不会自动把新段落改成新规则或继续声称来源已一致。
停用公司规则属于有影响写入，必须显示必查覆盖变化，并生成新公司规则集修订号。

### 4.3 界面与内部状态

| 区域或状态 | 展示与操作 |
|---|---|
| 空列表 | 公司规则说明或“创建个人提醒”；不自动生成并启用规则 |
| proposal_generating | 展示领域 job 进度，可取消草稿生成，刷新按 proposal_id 续查；关联现有对话时保留 origin_run_id |
| clarification_required | 明确列出未决字段，允许继续对话或表单作答 |
| draft | 可编辑解释表单与只读 JSON 预览，保存后保留服务端版本 |
| test_running | 测试按钮防重，展示真实用例数与完成数 |
| test_failed | 定位表达式或用例错误，启用按钮禁用 |
| ready | 编译及发布测试通过，可准备启用确认 |
| active | 展示现行版本、生效范围与最近启用回执 |
| disabled 或 archived | 不进入新的规则集；历史预审保留原版本引用 |
| conflict | 保留本地编辑内容，刷新服务端差异，禁止静默覆盖 |

上述为规则领域内部状态；不得映射成公共 Agent run、预审任务或审批状态的别名。
抽屉 URL 使用 ?drawer=rules&resource=<rule_id>；页面刷新时读取最新权限与版本。

## 5 领域模型与存储约束

所有实体包含公共 id、tenant_id、version、created_at、updated_at；版本对象另有不可变 content_hash。

| 实体 | 必需字段 | 约束 |
|---|---|---|
| rule_definition | owner_id、level、category、name、lifecycle、active_version_id | level=company 时 owner_id 是管理责任人，不代表个人范围 |
| rule_version | rule_id、version_number、dsl_version、dsl_json、explanation、content_hash | 发布后不可更新；删除草稿不能删除已引用历史版本 |
| rule_applicability | modules、department_ids、purposes、basis、unit、effective_from、effective_to | modules 限 travel/expense_claim/oa_request；日期区间左闭右开 |
| rule_dependency | canonical_field、mapping_id、mapping_version、required、source_ref | 来源 policy 引用必须精确到版本、段落及 quote_hash |
| rule_test_case | rule_version_id、name、input_json、expected_truth、expected_outcome | 输入必须是脱敏合成数据；保留创建来源 |
| rule_test_run | compiled_hash、test_set_hash、mapping_hash、results、passed、finished_at | 三个 hash 全匹配才可作为发布依据 |
| rule_set_revision | level、owner_id、purpose、revision_number、member_versions、hash | 空个人规则集仍有修订号；发布或停用时递增 |
| field_mapping | provider、source_schema_version、module、target_field、source_pointer、transform | transform 只能选已注册纯函数；无任意代码 |
| field_mapping_version | mapping_id、mapping_json、content_hash、confirmed_by | 发布后不可变；改映射使受影响预审 stale |
| rule_change_audit | actor、action、before_ref、after_ref、confirmation_id、receipt_id | 追加写入，与会话删除无关 |

数据库唯一约束：(tenant_id, rule_id, version_number)、(tenant_id, idempotency_key_scope, key)。
活动规则集更新、版本状态更新、审计和 outbox 事件在同一数据库事务中提交。
公司规则 level=company 时 outcome_mode=mandatory_check；个人固定 outcome_mode=attention_trigger。
公司版本另有 failure_kind=violation/missing_evidence：限额或合规比较不满足用 violation；已确认缺少必需材料用 missing_evidence。
规则编辑器要求显式选择检查类型并校验 failure_kind；个人版本不能声明公司失败类型；自然语言不得静默降级公司违规。
个人规则不能包含 exemption、auto_approve、auto_reject 字段；schema additionalProperties=false。
basis 固定枚举 submitted_date/evaluation_date/expense_date；首期演示规则使用 submitted_date。
草稿报销没有 submitted_at 时显式使用 evaluation_date 并在预检结果说明；提交后必须重跑。
expense_date 规则必须指定取每项消费日期，不能把多天合并单据无说明地取最早或最晚日期。

## 6 标准输入与字段目录

```ts
type SrsInput = {
  schema_version: 1;
  document: ResourceRef & {type:'expense_claim'|'travel'|'oa_request'};
  business_date: string;
  applicant_id: string;
  department_id: string;
  total_amount: Money|null;
  expense_items: Array<{
    id:string; category:'invoice'|'transport'|'lodging'|'meals'|'itinerary'|'general'; source_expense_type:string|null;
    amount:Money|null; invoice_refs:string[]; spent_on:string|null;
    room_nights:string|null; oa_request_ref:ResourceRef|null;
  }>;
  invoices:Array<{id:string; amount:Money|null; invoice_number:string|null; verified:boolean|null}>;
  travel?:{start_on:string|null;end_on:string|null;request_ref:ResourceRef|null};
  external_facts:Record<string, {value:unknown; provenance:string; state:'known'|'unknown'}>;
  field_states:Record<string, {state:'known'|'missing'|'unmapped'|'unavailable'; reason:string|null}>;
};
```

这是 SRS 归一化投影；单据真源仍归 M08/M09/M10，禁止另外创建可编辑的报销副本。
reviewer scope 由服务端执行上下文单独传入；不得让原始 JSON 内的字段覆盖审核人权限。
M09 的 ExpenseClaim.items/item_id 为业务编辑模型；其 getPreauditInput / toSrsSnapshot 返回下述原子 SrsInputSnapshot，解释器只接收其中 input，不能直接接收旧 StandardExpenseDocument。
投影映射固定 document_ref→document、claim.department_id→department_id、claim.total_amount→total_amount、items→expense_items、item_id→id。
expense_type 经版本化 enum_lookup 变成 category，原值另存 source_expense_type；办公费 office→general，但 M07 继续按 office 分析。
normalization_version/materials_version/validation 属于投影构建元数据和 M04 lock，不额外塞入 strict SrsInput；invoice_confirmed 不得冒充 verified。
```ts
type SrsProjectionProvenance = {
  source_ref:ResourceRef; materials_version:number;
  invoice_versions:Array<{id:string;version:number}>; external_refs:ResourceRef[];
  field_catalog_version:number; mapping_versions:Array<{id:string;version:number}>;
  normalization_version:string; input_hash:string;
};
type SrsInputSnapshot = {input:SrsInput;provenance:SrsProjectionProvenance};
// M09 adapter 的唯一预审读取签名；input 与 provenance 必须由同一次快照构建返回。
getPreauditInput(ctx:ActorContext,id:string,version:number):Promise<SrsInputSnapshot>;
toSrsSnapshot(ctx:ActorContext,source:ExpenseClaim,dependencies:SrsProjectionDependencies):Promise<SrsInputSnapshot>;
```
Demo 在同一只读事务取得单据、材料和已缓存外部事实；MaaS 用明确版本令牌冻结依赖，不能二次独立取 provenance 拼接。
M04 将 provenance 纳入版本锁和 input_hash 校验；不能取得一致版本时返回可恢复依赖错误或 unknown，不伪造稳定快照。
field_states 的键使用目录规范路径加稳定行 id；真实证据另存 JSON Pointer，行重排不会把缺失状态转移给另一行。
clm-004 金额为90000分且已知；invoices[].verified=null、state=unavailable、reason=VERIFICATION_PENDING，compare→unknown，不能以 exists=false 替换该 seed。

| 目录字段 | 类型 | 来源及证据 | 支持模块 |
|---|---|---|---|
| department_id | organization_id | 单据所属部门快照与主数据引用 | 全部 |
| total_amount | money_minor | 单据金额、单据 version | 全部 |
| expense_items[].category | enum | 单据费用行；办公费归 general，保留原业务分类 | expense_claim |
| expense_items[].amount | money_minor | 费用行 id 与材料版本 | expense_claim |
| expense_items[].room_nights | decimal_string | 住宿明细或人工确认数量 | expense_claim/travel |
| invoices[].invoice_number | string | M09 已确认票据字段 | expense_claim |
| invoices[].verified | boolean | 校验适配器真实结果 | expense_claim |
| external_facts.oa_approved | boolean | 已授权 OA 查询及版本 | expense_claim/oa_request |
| travel.start_on/end_on | date | 差旅申请与版本 | travel/expense_claim |

目录发布版本进入编译 hash；未列入目录的字段不能被模型临时创建为可执行变量。
外部字段映射界面显示提供方原字段、JSON Pointer、目标类型、单位、样本和适用模块；由有权人员确认。
可用 transform 首期只含 identity、trim_string、date_iso、decimal_yuan_to_minor、enum_lookup。
decimal_yuan_to_minor 接受十进制字符串且最多两位小数，拒绝浮点金额和隐式四舍五入。
映射校验失败使对应字段 unknown，并记录受限诊断；不能用空串、0 或 false 填补缺失。

## 7 DSL 语法与确定性解释

DSL dsl_version=1 采用 AST；表达式运算符白名单为 all、any、not、compare、exists、for_each。
值节点白名单为 field、literal、sum、count、multiply；field 必须来自目录，集合过滤只能使用 AST。
compare 的 comparator 只允许 eq/ne/gt/gte/lt/lte/in；money 只能与同币种 money 比较。
company predicate 表示“符合要求”，false 按 failure_kind 形成明确违规或已确认缺材料；personal predicate 的 true 形成提醒。
例如必需发票号 exists=false 且 failure_kind=missing_evidence，输出 company_missing_evidence 并由 M04 分为 incomplete；限额超标输出 company_violation。
exists 表示来源已成功提供且值非 null；来源不可用或未映射时返回 unknown，而不是 false。
已可靠读取到字段不存在时 exists=false；compare 遇到缺失值始终 unknown。
字段被来源明确标记“不适用”只允许由模块 schema 解释，不能被模型当作缺失豁免。

```json
{
  "dsl_version":1,
  "outcome_mode":"attention_trigger",
  "applicability":{"modules":["expense_claim"],"department_ids":["dept-sales"],"purposes":["manager_review"],"basis":"submitted_date","unit":"document_category_total"},
  "predicate":{"op":"compare","comparator":"gt","left":{"op":"sum","collection":"expense_items","where":{"op":"compare","comparator":"eq","left":{"op":"field","path":"item.category"},"right":{"op":"literal","value":"meals"}},"value":{"op":"field","path":"item.amount"}},"right":{"op":"literal","value":{"amount_minor":"100000","currency":"CNY"}}}
}
```

以上为张伟演示个人规则：每张报销单餐饮合计严格大于 1000 元；不是全部门所有报销的累加阈值。
公司住宿样例使用 for_each(lodging items, amount <= 80000 分 × room_nights)，不先除后舍入。
clm-003 的 220000 分与 80000×2=160000 分比较为 false；即使个人阈值设 5000 元仍属公司违规。

| 运算 | 输入含 unknown 时的真值规则 |
|---|---|
| all | 存在 false 则 false；全 true 才 true；其余 unknown |
| any | 存在 true 则 true；全 false 才 false；其余 unknown |
| not | true/false 互换；unknown 保留 |
| compare | 任一必要值 unknown 则 unknown；无类型强制转换 |
| sum | 任一属于筛选集合的金额 unknown 则 unknown；不能只加已知行 |
| for_each | 有 false 则 false；全部已知 true 才 true；必要集合未提供则 unknown |

空集合语义由字段目录 min_items 和适用条件共同确定；必填费用行空集合不能利用全称空真通过。

集合筛选的 where 若为 unknown，该行是否属于汇总集合尚不确定，sum/count/for_each 的相关结果必须传播 unknown；不能把未知筛选条件当 false 丢弃该行。比如一行费用类别尚未确认时，不能只加已知餐饮行后宣称餐饮合计低于阈值。
不适用为 applicability=false 的评估状态 skipped，不是第四种布尔真值；覆盖率单独计数。
若 applicability=unknown，必查公司规则进入 unknown；不得静默跳过规则。
解释器先计算完整必要字段清单，再执行 AST，并保留所有适用必查规则的结果，不因首条违规停止整个预审。
金额使用 bigint；数量转为分子分母进行精确乘法或交叉比较；禁止 JavaScript Number 执行业务金额判断。
限制：AST 深度≤8、节点≤200、单输入费用行≤500、单条规则执行≤100ms；超限拒绝编译或返回受控 unknown。
DSL 不能调用网络；外部事实在预审快照阶段获取并固定版本后交给纯解释器。

## 8 API 与工具契约

所有路径加 /api/v1；修改携带 Idempotency-Key，已有对象更新携带 expected_version。

| 方法与路径 | 请求关键字段 | 响应与错误 |
|---|---|---|
| GET /rules | level、category、module、cursor、limit | 授权规则列表与现行版本 |
| POST /rules/proposals | natural_language、module、purpose、current_rule_ref?、source_refs? | 202 proposal_id/job_id/origin_run_id；不启用 |
| GET /rules/{id} | 无 | 草稿、现行版、未决问题、测试状态 |
| PATCH /rules/{id}/draft | expected_version、form 或 dsl_json | 新草稿版本；校验错误精确到路径 |
| POST /rules/{id}/clarifications | expected_version、answers[] | 澄清后草稿；仍缺信息继续返回问题 |
| POST /rules/{id}/tests | expected_version、test_set_id | 202，test_run_id；真实持久任务 |
| GET /rules/{id}/diff | from_version、to_version | AST 语义差异及中文解释 |
| POST /confirmations | action=rule.enable 或 rule.publish、resource_refs、args:{draft_hash,test_run_id} | M11 confirmation；默认 10 分钟 |
| GET /rule-mappings | provider、module | 目录字段、映射现行版本 |
| POST /rule-mappings | expected_version?、mapping、sample_cases | 草稿映射；发布走统一确认 |

```json
{"name":"finance.rules.propose","version":"1.0.0","run_id":"run-03","call_id":"call-03","arguments":{"natural_language":"我部门餐饮费超过1000元提醒我","module":"expense_claim","purpose":"manager_review"}}
```

```json
{"status":"requires_input","data":{"rule_id":"rule-personal-meals","draft_version":1,"questions":[{"id":"unit","label":"按什么单位比较餐饮费？","options":["document_category_total","person_day","invoice"]}],"activation_state":"clarification_required"},"evidence_refs":[],"action_id":null,"error_code":null}
```

finance.rules.propose@1.0.0 的 required 为 natural_language/module/purpose；可选 current_rule_ref/source_refs，HTTP 与工具共用 schema。
finance.rules.test@1.0.0 的 arguments 固定 rule_id、draft_version、test_set_id；fixture refs 从授权的 test_set_id 解析，禁止传入执行脚本。
草稿生成和测试各自使用持久领域 job；origin_run_id 由服务端调用上下文注入，已有 Agent run 只关联、不创建嵌套 run，独立规则页可为 null。
POST /rules/proposals 的 source_refs 可为空；提供制度来源时必须使用 M06 可验证 citation，不接受自由 URL 冒充。
工具调用的额外字段一律拒绝；模型输出类型错误可重试一次修复，持续失败保留草稿并转手工编辑。

## 9 发布 一致性与异常恢复

发布先验证权限、expected_version、DSL 编译、映射状态、制度引用、测试 hash，再创建明确确认意图。
确认执行时重复相同验证，并锁定 rule_set_revision；并发发布只允许一个在期望修订号上成功。
修改、停用、恢复旧内容均产生新修订；恢复旧内容是复制为新版本，不复活历史数据库记录。
发布事务追加 ruleset.changed outbox；M04 将受影响未审批结果标 stale，M01 卡片标 stale。
制度来源被撤回或新版本替代时，绑定规则标 source_review_required；新的必查执行返回 unknown 直到管理者复核。
没有制度引用的规则可明确标 source_kind=manual_company_decision，由有权财务承担管理责任，不能伪造引用。
模型超时保留原文字及草稿状态，重试复用同一 proposal；不创建多个已启用规则。
测试进程崩溃通过持久任务 lease 续跑未完成用例；完成用例按 test_run_id+case_id 去重。
映射发布失败不改变现行映射；外部字段失败不影响已经固定的无关规则，但相关规则必须 unknown。
公司必查不存在、加载失败、规则集 hash 不一致都不能以“0 条通过”呈现合规；交给 M04 incomplete。
02 的 company-rules-rev-1 固定包含 rv-company-invoice-1、rv-company-lodging-1、rv-company-oa-1；分别检查票据核验、每间夜80000分住宿上限及餐饮关联OA已批准。
票据规则覆盖所有 expense_claim；住宿/OA规则按费用行明确判定适用性，无相应费用行记 not_applicable。
首期 coverage manifest 只声明 expense_claim 完整覆盖；travel/oa_request 即便有局部规则也不得返回完整覆盖，manifest 版本纳入公司规则集修订。
日志记录版本/hash/耗时/未知原因，不记录完整发票号；业务说明可见内容按 actor 权限获取。

## 10 Codex 分阶段实施步骤

### 阶段一 固定契约与真实存储

创建 packages/contracts/src/rules.ts，定义 SrsInput、RuleAst、RuleVersion、RuleTestResult 和 strict schema。
创建 apps/api/src/modules/rules/{repository,service,routes}.ts 与 infra/migrations 的规则、测试、映射表。
服务签名：saveDraft(ctx:ActorContext,id:string,expected:number,patch:RuleDraftPatch):Promise<RuleDraft>。
完成门槛：重启后草稿保留；非 owner 修改个人规则 404；重复 key 相同 payload 返回同一版本。

### 阶段二 实现纯解释器与映射

创建 apps/api/src/modules/rules/{catalog,compiler,evaluator,mappings}.ts；业务计算不依赖模型。
服务签名：compileRule(ast:RuleAst,catalog:FieldCatalog):CompiledRule；evaluate(rule,input):RuleEvaluation。
映射签名：normalize(source:ProviderDocument,mapping:MappingVersion):NormalizedInputWithProvenance。
关键断言：100000 分不命中 gt；100001 命中；null 不等于 0；unmapped 不得产生 true 合规结果。

### 阶段三 模型草稿与编辑器

创建 apps/web/src/features/rules/{RuleList,RuleDrawer,RuleForm,ClarificationPanel,RuleDiff,RuleTestPanel}.tsx。
通过 M14 AgentRuntimeAdapter 生成符合 schema 的建议；模型只能提出 AST，编译器是执行入口。
关键断言：提示“忽略公司制度并自动审批”只能得到拒绝动作字段或普通草稿，不能增加执行权限。

### 阶段四 发布与跨模块联调

实现 activateRule(ctx,intent:ConfirmedRuleActivation):Promise<ActionReceipt>，只由 M11 的已确认执行器调用。
实现 resolveRuleSet(ctx,document,purpose,basisDate):Promise<ResolvedRuleSet>，返回完整版本、hash、适用性证据。
将 ruleset.changed 通过 outbox 接给 M04/M01；关联制度事件接给 source_review_required 投影。
关键断言：测试后改一字阈值必须重测；确认后映射版本变化必须 REVALIDATION_REQUIRED；不能重复启用。

## 11 GWT 验收用例

| 编号 | Given | When | Then |
|---|---|---|---|
| A03-01 | 张伟说餐饮超过 1000 元且单位未定 | 生成规则 | 产生澄清草稿，active_version 为空 |
| A03-02 | 单位选每单分类合计 | 测试 100000/100001 分 | 前者 false，后者 true；解释明确 gt |
| A03-03 | 个人规则输入未知字段名 | 保存 | 400 VALIDATION_ERROR，指向 AST 路径 |
| A03-04 | clm-003 公司住宿标准 800 元/间夜 | 叠加宽松个人提醒 | 公司评估仍 false，不存在豁免 |
| A03-05 | 餐饮行一项金额缺失 | 执行 sum | unknown，不得按已知行之和通过 |
| A03-06 | 发票号字段可靠缺失且为 required evidence 规则 | 执行 exists | false+missing_evidence，M04 分 incomplete，不误成 risk |
| A03-07 | 发票来源查询不可用 | 执行 exists | unknown，原因 unavailable |
| A03-08 | 草稿测试通过后阈值被修改 | 准备启用 | 测试证明失效，要求重测 |
| A03-09 | 张伟个人规则启用 | 李娜自身预检 | 不加载张伟规则；两种 scope 不能混用 |
| A03-10 | u-zhao 只有平台管理员权限 | 读取个人规则内容 | 404，诊断页面只见脱敏元数据 |
| A03-11 | 同一确认已执行成功 | 再次提交同 key | 返回原 receipt，不增版本 |
| A03-12 | 两位财务基于同一规则集修订发布 | 后者执行 | VERSION_CONFLICT，不丢前者变更 |
| A03-13 | 绑定制度版本被撤回 | 开始新预审 | 相关必查 unknown，提示来源需复核 |
| A03-14 | 模型网关不可用 | 手工表单创建合法 DSL 并测试确认 | 规则仍可正常启用 |
| A03-15 | DSL 含 eval、任意 URL 或超深 AST | 编译 | 拒绝，无脚本或网络副作用 |
| A03-16 | 外部元金额为字符串 1000.001 | 映射 | 拒绝精度超限，不静默舍入 |

## 12 完成门槛与联调交付

P0 全部实现并通过 A03-01 至 A03-16；关键边界为真实接口测试，禁止仅以静态截图证明。
测试集至少覆盖严格/含等号边界、缺失、来源失败、适用范围、个人隔离、公司不可豁免、版本冲突。
交付 DSL JSON Schema、字段目录、映射样本、种子规则、迁移、工具注册、操作说明和发布回滚运行手册。
M04 必须只接收 resolveRuleSet 返回的规则版本，不用“当前默认规则”字符串；M11 必须能重验规则集 hash。
M06 引用必须保存完整定位与 quote_hash；制度问答反馈不得直接修改现行 DSL。
性能门槛在固定开发配置记录：100 条规则×100 张合成单据完成且无任务丢失；报告实测耗时，不伪造承诺。
