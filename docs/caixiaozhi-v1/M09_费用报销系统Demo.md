# M09 费用报销系统 Demo 详设

版本：1.0｜实现深度：简易可运行 Demo｜依赖：[总体架构与公共契约](01_总体架构与公共契约.md)。

## 1. 目标与边界

本模块完成发票私有上传、异步识别、人工矫正确认、费用行绑定、报销草稿、提交与两级审批联动。
OCR 提供方允许使用可控 mock；上传记录、队列任务、人工确认、费用保存、审批和失败恢复必须运行真实后端逻辑。
一张逻辑发票对应一条费用行；不以一份 PDF 等同一张发票，也不让同一发票重复绑定多份有效报销。
M09 负责把识别与业务字段整理成标准 JSON；M04 / SRS 只做结构化规则检查，不读取原图进行 OCR。
completed 的含义是审批完成；本 Demo 不创建支付单、银行流水或“已付款”提示。

| 依赖 | 使用方式 | 数据所有权 |
|---|---|---|
| M12 | 申请人、部门、成本中心和授权范围 | M09 不接受客户端自报角色 |
| M06 / 共享文件服务 | 私有存储、鉴权预览、材料引用 | 发票识别和人工确认由 M09 负责 |
| M08 | 获授权差旅已批准快照 | 只引用 travel id + version，不复制可变主单 |
| M10 | 招待 OA 的批准状态、日期与额度 | 绑定与占用通过领域服务校验 |
| M11 | 确认、提交、经理 / 财务审批与动作账本 | 业务 handler 写报销，M11 统一驱动状态 |
| M03 / M04 | 字段映射、预审与 SRS JSON | 审批使用当前审核人的新鲜预审结果 |
| M13 / M14 | OCR connector、工具任务与可靠执行 | Worker 通过受控适配器，不持有开放 SQL 能力 |
| M15 | 固定 11 张报销夹具、识别与超时故障 | fixture 逻辑与生产上传入口隔离 |

## 2. 编号功能

| 编号 | 功能 | 结果 |
|---|---|---|
| EXP-01 | 上传登记与完成校验 | 生成文件记录、摘要指纹和私有预览 |
| EXP-02 | 异步 OCR | 返回可查询任务，重启后任务不丢失 |
| EXP-03 | 预览与字段矫正 | 原图 / PDF 页和字段并排；记录人工修正来源 |
| EXP-04 | 人工确认发票 | 未确认不能进入正式费用绑定 |
| EXP-05 | 费用类型候选 | 明确类别自动填候选，不明确必须选择确认 |
| EXP-06 | 一票一行与重复检测 | 同租户安全提示，避免有效重复绑定 |
| EXP-07 | 报销草稿与附件管理 | 保存版本、金额汇总、关联差旅 / OA |
| EXP-08 | 提交校验 | 必填、金额、关联单据与票据状态一次返回 |
| EXP-09 | 两级审批 | pending_manager → pending_finance → completed |
| EXP-10 | 退回、撤回、重新提交 | 取消当前任务并保留所有审批历史 |
| EXP-11 | 结构化预审输入 | 标准 JSON 固化版本和材料确认状态 |
| EXP-12 | 原始系统入口 | 与 Agent 抽屉复用同一编辑器和接口 |

## 3. 角色、页面与失败状态

| 角色 | 范围 | 可执行操作 |
|---|---|---|
| employee | 本人报销与本人上传票据 | 建草稿、矫正确认、绑定、提交、退回后补正、撤回 |
| manager | 显式部门范围内的当前经理任务 | 审批、退回、查看授权票据；不能替申请人改金额 |
| finance | grant 指定部门与当前财务任务 | 财务核准、退回、查看字段与证据；不执行付款 |
| platform_admin | 无业务数据读取权 | 查看识别任务计数与脱敏错误码，不看票面内容 |

| 页面 / 抽屉 | 用户旅程 | 明确失败状态 |
|---|---|---|
| /expenses | 本人草稿、待审、退回、完成列表 | 空态可新建；不能用“加载失败”伪装空列表 |
| /expenses/:id | 基本信息、费用表、总额、关联单和审批轴 | 409 提示远端版本，保留本地未保存输入供比较 |
| 票据上传抽屉 | 拖文件 → 上传 → 识别排队 → 字段确认 | 超限 / MIME 错误 / 加密 PDF / 上传过期分别提示 |
| 识别详情抽屉 | 页缩略图、字段置信提示、候选费用类型 | 识别失败允许重试或手录；不能显示已确认 |
| 关联单选择器 | 只查询本人获授权 approved 差旅 / OA | 已失效或额度变化后阻止绑定 / 提交 |
| 提交确认 | 编号、版本、费用行数、总额、关联单、审批链 | 确认过期需重建，unknown 显示核实中 |
| 审批详情 | 当前节点、标准 JSON 摘要、预审与证据 | 旧预审 stale，缺字段 incomplete，不显示低风险 |

原始系统入口 `/expenses/:id` 与 `?drawer=expense_claim&resource=:id` 读取同一实体；授权与字段编辑条件一致。
保存成功后提示“草稿已保存 vN”；异步提交只提示“处理中 action-id”，核验回执后才提示“已提交”。

## 4. 发票上传与识别生命周期

### 4.1 统一上传边界

- 发票上传 profile 固定为 invoice-v1：PDF、PNG、JPEG；实际 MIME 为 application/pdf、image/png、image/jpeg。
- 单文件上限 20 MiB，即 20,971,520 字节；0 字节拒绝；相同值用于前端、API、对象存储签名策略与完成校验。
- 单报销最多 20 个有效附件文件、100 张逻辑发票；单 PDF 最多 50 页，不在浏览器放宽限制。
- 扩展名只作提示，必须验证真实文件签名、MIME 与实际字节数；文件名去路径并限制 120 字。
- 加密 PDF、压缩包、可执行文件、损坏文档返回 VALIDATION_ERROR，不把错误文件递交 OCR。
- 上传先登记，使用 10 分钟有效的私有上传能力；完成时核验 checksum、字节数和文件存在性。
- 未完成文件留临时区，24 小时回收；已绑定发票的文件受业务保留策略保护。
- 浏览器只使用短时鉴权代理预览；服务端不向模型暴露永久文件 URL 或对象存储密钥。

### 4.2 状态与任务

| 对象 | 状态 / 转移 | 约束 |
|---|---|---|
| uploaded_files | registered → uploaded → validated / rejected | validated 以后才可启动 OCR |
| ocr_tasks | queued → running → completed / failed / cancelled | lease、attempt、heartbeat 持久化，任务 id 可查询 |
| invoices | recognized → needs_confirmation → confirmed | OCR 完成只产生候选，用户确认才可正式绑定 |
| invoice corrections | confirmed → needs_confirmation | 已绑定时仅可在可编辑报销中修改，并使报销 version + 1 |
| recognition retry | failed → 新 attempt | 固化输入文件版本；最多 3 次可重试错误 |
| late recognition | 输入版本已变化 | 保存为历史 attempt，不能覆盖人工修正 |

OCR job 包含 file_id、file_version、sha256、provider_version、environment_epoch 与 idempotency key。
mock OCR 通过 fixture 文件摘要返回已知字段，也允许注入缺失发票号、低置信类型和供应商超时。
mock 仍经 durable queue、状态更新与回执；不得用前端定时器直接生成成功对象。
一份 PDF 识别出多张票据时，为每个页范围 / 区域产生独立 invoice candidate，用户逐张确认。
识别出重复页或区域重叠时标记需要确认；不自动生成多个可报销费用行。
人工手录仍需保留文件引用、edited_by、edited_at 与修正记录；无原始文件的新提交本期不支持。

## 5. 数据模型与校验

| 表 / 字段 | 类型 | 验证与含义 |
|---|---|---|
| invoices.owner_id / file_id | string | 本人上传；文件必须 validated |
| invoice_number | string null | 票面标识；提交必填，1–64 字 |
| invoice_code | string null | 票种允许无代码；不能因 null 自行补零 |
| invoice_date | date null | 合法公历 YYYY-MM-DD；不晚于演示业务日 |
| seller_name / buyer_name | string null | 票面抬头，提交按票种必查要求 |
| seller_tax_id / buyer_tax_id | string null | 按票种校验，保持字符串前导零 |
| gross_amount / tax_amount | Money null | 非负 CNY，tax <= gross，缺失与 0 区分 |
| net_amount | Money null | 已知净额时 net + tax = gross；精确整数分 |
| invoice_kind | enum | electronic / paper / transport_ticket / other |
| confirmation_state | enum | recognized / needs_confirmation / confirmed；仅表示人工确认票面字段 |
| verification_state | enum | pending / verified / rejected / unavailable；独立于 OCR / 人工确认 |
| verification_evidence | object null | 提供方、事实来源、核验时间、结果引用、synthetic 标记；模拟结果不得声称真实税务验真 |
| fingerprint | string null | 规范化票面要素的服务端 HMAC；不能客户端自报 |
| source_fields / corrections | JSON / append log | 每字段识别源、页码、原值、新值、操作者 |
| claims.title / purpose | string | 标题 1–100；提交事由 1–2,000 字 |
| applicant_id / department_id | string | 从服务端身份及组织快照生成 |
| cost_center_id | string | 有效且在申请人部门可用范围 |
| state | enum | draft / pending_manager / pending_finance / completed / returned / withdrawn |
| total_amount | Money | 服务端求和，不信任前端总额 |
| submitted_at / completed_at | UTC timestamp null | M07 同名字段决定统计；seed 固定值见 02，正常操作记录真实 UTC；BusinessClock 只定查询窗 |
| expense_items.item_id / invoice_id | string | 一个 invoice 在同一 claim 只有一行 |
| expense_type | enum | transport / lodging / meals / office / other |
| expense_subtype | enum null | business_entertainment 或 null；类型 meals 时适用 |
| type_confirmation | enum | candidate / confirmed；不明确时必须人工选定 |
| incurred_date | date | 合法业务日期；提交不晚于演示业务日 |
| claim_amount | Money | 0 < amount_minor <= invoice.gross_amount；降低申报需说明 |
| reduction_reason | string null | 少报票面金额时 1–500 字 |
| travel_ref / oa_ref | ResourceRef null | 必须 approved 且当前范围可访问 |
| lodging_details | object null | 入住、退房、房间数、间夜数；lodging 类型必填 |
| transport_details | object null | 起止城市、交通方式；与相关行程日期核对 |
| material_refs | array | 当前有效文件版本；冻结提交快照 |

单项与报销总额上限统一为 100,000,000 分；输入规则与 M08 Money 规则一致，不接受科学记数法或三位元小数。
一张已确认发票可以暂不绑定；绑定时在事务中获取 invoice claim reservation，防止并发双重绑定。
同一 invoice 不能同时关联两张未删除报销；从可编辑草稿解除绑定才释放；completed 永久保留消费记录。
withdrawn / returned 仅释放 OA 提交额度占用，不自动释放发票归属；修改原单并重提仍引用原 invoice。
费用类型可根据明确票面生成候选；无论候选是否确定，用户确认票据时看到并确认最终类型。
类别不明确、OCR 字段缺失或矛盾时必须补正；“其他”不是绕过住宿或招待校验的通道。

### 5.1 同租户重复提示

sha256 用于检测同字节文件；语义 fingerprint 使用票种、票号 / 代码、销售方标识、日期和总额规范化后生成。
不能仅按金额和日期判断两张不同发票重复；要素不足时返回“需要核实”，不谎称未重复。
同租户存在疑似已使用票据时返回 DUPLICATE_INVOICE 字段结果，归入 VALIDATION_ERROR；不得返回他人姓名、单号、金额或附件。
若重复票据属于本人且当前授权允许，可显示本人原报销入口；其他场景只显示“该票据可能已使用，请联系财务核实”。
去重索引及比较始终包含 tenant_id；不能泄漏其他租户是否存在该票据。
附件预览、指纹检查和日志都不能让不同上传者共享未经鉴权的下载地址。

## 6. 关联与提交状态机

| 当前状态 | 动作 | 前置条件 / 结果 |
|---|---|---|
| draft / returned / withdrawn | save | 本人 + CAS；保持当前状态并增加版本 |
| draft | expense.submit | 确认、提交校验、冻结快照；进入 pending_manager |
| returned / withdrawn | expense.resubmit | 重新校验全部字段与关联单；新建经理任务 |
| pending_manager | approval.approve | 当前经理任务；进入 pending_finance 并创建财务任务 |
| pending_finance | approval.approve | 当前财务任务；进入 completed，记录审批完成 |
| pending_manager / pending_finance | approval.return | 理由必填；进入 returned，关闭当前任务 |
| pending_manager / pending_finance | expense.withdraw | 本人确认，CAS 尚未被审批占用；进入 withdrawn |
| completed | 修改 / 撤回 | INVALID_STATE；本期不支持已完成冲销 |

新提交要求：所有费用有已确认票据、类型明确、金额一致、字段完整、成本中心有效、当前关联校验通过。
差旅费用引用批准快照；发生日期必须落在对应行程范围，城市不匹配时给明确待补正错误。
业务招待费用必须关联 M10 approved OA；发生日期匹配 OA 日期，申请人匹配且额度足够。
OA 额度在提交事务中原子占用；多单并发不能分别认为余额充足；退回 / 撤回释放占用，重提重新验证。
夹具 clm-004 的费用行金额已知为 90000 分；票据关键佐证暂不可得，verification_state=pending，核验事实 unknown；不是金额缺失或已证实不存在发票。
M15 直接装载这份受控历史样本；普通提交 API 不接收 fixture 绕过参数；核验暂未返回与业务必填字段缺失分别处理。
发票或费用材料修改会提高 claim aggregate version 并使相关预审 stale；审批中禁止直接修改材料。

## 7. HTTP 与适配器契约

路径均加 `/api/v1`；每次修改要求 Idempotency-Key，现存对象变更要求 expected_version。

| 方法 / 路径 | 输入 | 返回 |
|---|---|---|
| POST /expenses/uploads | filename、mime、size、sha256 | file id、version、临时上传能力、expires_at |
| POST /expenses/uploads/:id/complete | expected_version、sha256 | validated 文件；校验失败不启动识别 |
| POST /expenses/ocr-tasks | file ref | 202 + task id，包含识别提供方模式 |
| GET /expenses/ocr-tasks/:id | 无 | 状态、attempt、invoice candidates 或安全错误 |
| GET /expenses/invoices | cursor、limit、confirmation_state | 本人可见票据、核验与占用状态；无权对象不出现在计数 |
| GET /expenses/invoices/:id | 无 | 当前票据、字段来源、版本、可操作项；原文件走鉴权预览代理 |
| PATCH /expenses/invoices/:id | expected_version、corrections | 新票据版本、需要确认的字段 |
| POST /expenses/invoices/:id/confirm | expected_version、确认字段和类型 | confirmed invoice；不是审批确认 token |
| POST /expenses/claims | title | draft claim id + version |
| GET /expenses/claims | cursor、limit、state | 授权报销列表、金额、节点与版本 |
| GET /expenses/claims/:id | 无 | 当前 claim、items、关联对象ref、材料版本与available_actions |
| PATCH /expenses/claims/:id | expected_version、费用与关联变更 | 最新聚合、服务端总额 |
| GET /expenses/claims/:id/validation | 无 | claim version、errors、warnings、checks |
| GET /expenses/claims/:id/preaudit-input | 指定当前版本 | 给 M04 的结构化快照；要求内部受控权限 |
| POST /confirmations | expense.submit / resubmit / withdraw 或审批意图 | 统一确认信息 |

```json
{
  "expected_version":4,
  "items":[{"item_id":"item-1","invoice_id":"inv-1","invoice_version":3,
    "expense_type":"lodging","type_confirmation":"confirmed",
    "incurred_date":"2026-11-04","claim_amount":{"amount_minor":"220000","currency":"CNY"},
    "lodging_details":{"check_in":"2026-11-02","check_out":"2026-11-04","room_count":"1"},
    "travel_ref":{"type":"travel","id":"trv-1","version":5}}]
}
```

对 confirmed invoice 的实质矫正与已绑定 claim 的 version 更新必须在同一事务；不能出现票面已变而预审仍新鲜。

```ts
interface InvoiceRecognitionProvider {
  recognize(input: {fileRef: AuthorizedFileRef; providerVersion: string}): Promise<OcrCandidates>;
}
interface ExpenseAdapter {
  get(ctx: ActorContext, id: string): Promise<ExpenseClaim>;
  validate(ctx: ActorContext, id: string, version: number): Promise<ValidationReport>;
  getPreauditInput(ctx: ActorContext, id: string, version: number): Promise<SrsInputSnapshot>;
  execute(ctx: ActionContext, command: ExpenseCommand): Promise<ActionReceipt>;
  getReceipt(ctx: ActorContext, receiptId: string): Promise<ActionReceipt>;
}
async function toSrsSnapshot(ctx: ActorContext, source: ExpenseClaim, dependencies: SrsProjectionDependencies): Promise<SrsInputSnapshot>;
async function confirmInvoice(ctx: ActorContext, input: ConfirmInvoiceInput): Promise<Invoice>;
async function bindInvoice(ctx: ActorContext, claimId: string, input: BindInvoiceInput): Promise<ExpenseClaim>;
```

### 7.1 提供给 SRS 的唯一标准投影

最终类型严格 import M03 的 SrsInput；schema additionalProperties=false，不再使用另一个 StandardExpenseDocument。
下面按 clm-003 的基线金额与消费日期说明投影；invoice id / 合成票号示意值在运行时取当前授权材料，不能硬写在业务逻辑。

```json
{
  "schema_version":1, "document":{"type":"expense_claim","id":"clm-003","version":1},
  "business_date":"2026-11-04", "applicant_id":"u-wang", "department_id":"dept-sales",
  "total_amount":{"amount_minor":"220000","currency":"CNY"},
  "expense_items":[{"id":"ei-003","category":"lodging","source_expense_type":"lodging",
    "amount":{"amount_minor":"220000","currency":"CNY"},"invoice_refs":["inv-003"],
    "spent_on":"2026-11-03","room_nights":"2","oa_request_ref":null}],
  "invoices":[{"id":"inv-003","amount":{"amount_minor":"220000","currency":"CNY"},
    "invoice_number":"DEMO-003","verified":true}],
  "external_facts":{}, "field_states":{}
}
```

business_date 按规则 applicability basis 选择；示例使用 submitted_date，草稿无提交时间时显式使用 evaluation_date 并标明预检口径。
业务 items/item_id 映射 expense_items/id；expense_type 通过 map-expense-v1 的 enum_lookup 映射 category，原值保留 source_expense_type。
办公费 office→general；M07 仍读取业务分类 office；金额与间夜数均保持字符串，不额外添加 nightly_amount。
normalization_version、material_versions、提交 validation 和证据来源放入 SrsProjectionProvenance 与 M04 lock，不混入 strict SrsInput。
SrsInputSnapshot 直接引用 M03：{input:SrsInput;provenance:SrsProjectionProvenance}；getPreauditInput 只能原子返回这一封装，不提供第二次读取 provenance 的端口。
Demo 的 toSrsSnapshot 在同一只读事务取得单据、材料、映射和已缓存外部事实；校验 source 与请求 version 一致，构造 input_hash 及 provenance 后一次返回。
MaaS 使用明确版本令牌冻结全部依赖；不能取得一致版本时返回可恢复依赖错误或 unknown，M04 不以两次独立读取拼接版本锁。
confirmation_state=confirmed 不能推出 verified=true；核验状态 verified/rejected 映射 true/false，pending/unavailable 映射 null。
clm-004 的 invoices[稳定 id].verified 对应 field_states.state=unavailable、reason=VERIFICATION_PENDING；费用金额保持已知 90000 分。
field_states 使用目录规范路径和稳定行 id，真实证据 JSON Pointer 另存；unknown 不改写成 exists=false，行重排也不迁移证据归属。
核验事实更新递增材料和 claim 聚合版本，使旧预审失效；SRS 不调用 OCR、不猜票号或补全缺失事实，M11 决定当前业务节点可用动作。

### 7.2 报销语义差异提议

`finance.expense.propose_patch@1.0.0` 使用 `{id,expected_version,prompt,selected_material_refs,invoice_refs}`；后两项为本轮明确选定且经授权的 `{id,version}[]`，无选定材料时为空数组。网关把 id 映射到 claim 路径，剩余字段与下列 HTTP schema 相同。不得把历史会话中的票据默认为本轮材料。

| 端点 | 请求 | 返回与行为 |
|---|---|---|
| POST /expenses/claims/:id/proposals | expected_version、prompt、selected_material_refs、invoice_refs | 202 proposal_id/job_id/origin_run_id；先从源读取最新草稿，冲突不生成旧版建议 |
| GET /expenses/claims/:id/proposals/:proposalId | 无 | base_version、proposed/applied/stale/rejected、operations、clarifications、来源 |
| POST /expenses/claims/:id/proposals/:proposalId/apply | expected_version、selected_operation_ids | 原子采纳指定差异并返回新 claim/version/total；空选择不产生业务变更 |

```ts
type ProposeExpenseInput = {
  id:string; expected_version:number; prompt:string;
  selected_material_refs:Array<{id:string;version:number}>;
  invoice_refs:Array<{id:string;version:number}>;
};
async function proposeExpensePatch(ctx:ActorContext,input:ProposeExpenseInput):Promise<ProposalTask>;
async function applyExpensePatch(ctx:ActorContext,input:ApplyProposalInput):Promise<ExpenseClaim>;
```

复用 M08 的提议存储、差异展示、source refs、CAS 和任务机制；字段白名单、费用行校验和 apply handler 由 M09 定义。operations 用稳定 item_id，不用数组位置；新增行的暂定 ID 由服务端分配并随 proposal 固定。服务端保存本轮草稿及 invoice/material 版本、用户指令和每项来源，未知值进入 clarifications，不从旧聊天填补。

允许建议修改 claim.title/purpose/cost_center_id，以及费用行的类型候选、日期、申报金额、差旅/OA关联；添加费用行只能引用本人已确认且未被其他单占用的发票。禁止通过提议修改申请人/部门、单据状态、审批节点、invoice 原票面字段、权限和公司规则。票面矫正仍走独立 invoice correction/confirm 流程。

每条差异展示 old/new/evidence_refs；一票一行、票据占用、金额重算、OA匹配和 claim.version 更新在同一事务完成。只采纳部分差异导致字段或关联不合法时，返回明确错误和需要同时采纳的关联项，不能悄悄采纳未选项。采纳只修改草稿，不提交、不占用正式 OA 报销额度；正式占用仍在 expense.submit。

提议生成可以是普通领域 job；经 Agent 发起时仅关联既有 origin_run_id，按 M14 的异步工具等待机制返回卡片。生成或采纳时原票、材料或草稿变更，提议标 stale 并要求重新生成。丢弃提议不影响手工编辑和原始票据。

## 8. 建议代码与分步 Codex 实施

语义填单追加 `apps/api/src/modules/expenses/{proposals,proposal-schema,apply-proposal}.ts`，复用 M08 proposal 公共部分；`stale_expense_proposal_preserves_manual_edit` 断言手改 v2 后旧 v1 建议不能覆盖；`expense_proposal_cannot_change_invoice_or_status` 断言模型试图改原票金额/直接提交时 schema 拒绝。测试当前两张票采纳后恰好两行/38000分，正式提交前 OA reservation 不增加。

| 文件 | 内容 |
|---|---|
| packages/contracts/src/expenses.ts | 发票、费用、Money、识别任务；引用 M03 唯一 SrsInput schema |
| apps/api/src/modules/expenses/srs-projection.ts | toSrsSnapshot、版本化映射、事实状态与 provenance |
| apps/api/src/modules/expenses/{schema,uploads,invoices,claims}.ts | 私有上传、票据确认、聚合事务 |
| apps/api/src/modules/expenses/action-handlers.ts | submit / resubmit / withdraw、额度与状态校验 |
| apps/worker/src/runner/invoice-recognition.ts | 可靠 OCR job、版本检查、超时重试 |
| packages/business-adapters/src/{ports,demo}/expenses.ts | 业务适配器与 mock OCR 提供方 |
| apps/web/src/features/expenses/{ClaimEditor,InvoiceReview,UploadQueue}.tsx | 共用页面组件 |

1. 建表与唯一约束，复用共享文件 profile；先验证超限、MIME、租户和上传过期。
2. 实现 queue 与 OCR provider 端口，接 deterministic fixture mock，验证重启后继续查询任务。
3. 实现人工修正 / 确认与 invoice reservation，完成一票一行及重复安全提示。
4. 实现草稿聚合 CAS、精确金额和类型校验，接通关联 travel / OA 服务。
5. 接入 M11 两级审批与 outbox，确认完成不产生支付副作用。
6. 输出 M03 SrsInput / provenance 并与 M04 联调 stale / incomplete；最后接 Agent 详情与 M15 旅程。
E2E-03 严格引用 02：交通 18000 分 / 11 月 3 日、人工选餐饮 20000 分 / 11 月 4 日，合计 38000 分；餐饮关联 oa-001。
oa-001 基线预算 150000 分，clm-002 已占 120000 分；上述 20000 分占用后剩 10000 分，交通行不占招待额度。

## 9. Given When Then 验收

| 编号 | Given | When | Then |
|---|---|---|---|
| EXP-A01 | 20 MiB 合法 PDF 与 20 MiB + 1 字节 PDF | 分别上传完成 | 前者可验证，后者 API 与存储均拒绝 |
| EXP-A02 | .jpg 扩展名实际可执行文件 | 完成上传 | MIME / 签名拒绝，不排 OCR 任务 |
| EXP-A03 | OCR queued 已写库 | Worker 重启 | 任务恢复，最终字段能通过 GET 读取 |
| EXP-A04 | 人工已矫正 invoice v3 | v2 OCR 结果晚到 | 历史结果可诊断，v3 字段不被覆盖 |
| EXP-A05 | 一 PDF 内两张不同发票 | 用户逐张确认并绑定 | 生成两条费用行，各绑定唯一 invoice |
| EXP-A06 | OCR 无法确定费用类别 | 用户直接提交报销 | 返回类型确认字段错误，不能自动归“其他” |
| EXP-A07 | 发票已被同租户另一员工使用 | 李娜上传相同票据 | 安全重复提示，不暴露对方姓名、单号或票面 |
| EXP-A08 | 相同票据只存在另一个租户 | 当前租户上传 | 不泄漏跨租户重复信息，独立校验 |
| EXP-A09 | 两张草稿并发绑定同一 invoice | 同时提交 bind | 一个成功，另一个冲突，不双重占用 |
| EXP-A10 | OA 预算 1,500 元已占用 1,200 元 | 再提交 400 元招待费用 | 额度校验拒绝；并发占用也不能超额 |
| EXP-A11 | clm-001 / clm-005 经理批准 | 查看状态及金额指标 | 进入 pending_finance，completed 指标不增加 |
| EXP-A12 | 财务完成上述两单 | 查询原始页、抽屉和统计 | completed 一致且无“已付款”状态 |
| EXP-A13 | clm-004 金额 90000 分、核验 pending | 发起预审 | verified=null、VERIFICATION_PENDING、incomplete；不伪造金额缺失或已验真 |
| EXP-A14 | 报销总额含三位小数元或负数分 | 保存字段 | 精确校验拒绝，不截断不舍入 |
| EXP-A15 | 当前 manager task 已批准 | 同 key 再点批准 | 返回原回执且不创建第二个财务任务 |
| EXP-A16 | 人工确认票面字段但核验仍 pending | 构建 SrsInput | confirmation 不冒充 verified；M04 冻结同一 claim / 材料 / 映射版本 |
| EXP-A17 | 02 两票交通 180 元、餐饮 200 元及 OA 剩余 300 元 | 完成 E2E-03 | 两行合计 38000 分、提交成功；OA 仅新增占用 20000 分、剩余 10000 分 |
| EXP-A18 | 预审快照读取期间另一事务矫正已绑定发票 | 调用 getPreauditInput | input 与 provenance 来自同一一致快照；不能组合新票面和旧附件版本，M04 发现后续版本变化即失效 |

## 10. 联调完成条件

必须能演示从私有上传到财务审批完成的真实持久化链路，并覆盖 OCR 失败、人工补正、版本冲突和回执核实。
普通业务 API 不能载入 legacy fixture 或修改业务模式；mock OCR 只替换提供方输出，不替代任何审批、授权、队列或存储逻辑。
