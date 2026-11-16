# M10 OA 前置申请与消息 Demo 详设

版本：1.0｜实现深度：简易可运行 Demo｜依赖：[总体架构与公共契约](01_总体架构与公共契约.md)。

## 1. 模块范围与依赖

OA Demo 只提供业务招待前置申请和模拟站内业务消息，形成“申请批准 → 报销引用 → 补件沟通 → 结果查看”的最小闭环。
不建设通用 OA 表单平台，不发送真实邮件、短信或 IM，不以页面 toast 代替接收人的消息记录。
OA 申请、额度占用、消息草稿、发送回执和阅读状态写入 PostgreSQL；原始页面与 Agent 抽屉读取相同对象。

| 依赖 | 接口用途 | 不允许的跨界 |
|---|---|---|
| M12 | 身份、经理解析、目录和明确收件人 | 不用模型猜姓名对应用户 id |
| M11 | OA 提交、审批、退回、撤回、消息发送确认 | 不另实现确认 token、动作账本或第二套审批 |
| M09 | 报销关联验证、额度占用与释放 | M09 不直接更新 M10 私有额度表 |
| M01 | OA 卡片、业务对象抽屉、深链接 | 对话消息不是已发送业务通知 |
| M02 | Agent 主动收件箱可引用 OA 通知 | 不把 M02 订阅事件冒充 M10 投递回执 |
| M13 / M14 | 受控 OA 适配器与写入核实 | 工具只能准备消息意图，不能凭文本发送 |
| M15 | 模拟时间、场景与隔离环境 | 仅 demo 可注入投递故障，不触达真实 IM |

## 2. 编号功能

| 编号 | 功能 | 最小交付 |
|---|---|---|
| OA-01 | 招待申请建草稿 | 日期、对象、事由、预算、申请人和部门 |
| OA-02 | 草稿校验与保存 | 当前版本 CAS，真实保存与刷新 |
| OA-03 | 提交 / 重提 | 显式确认，创建申请人经理任务 |
| OA-04 | 经理批准 / 退回 / 申请人撤回 | 同 M11 状态机及不可变审批历史 |
| OA-05 | 报销关联资格检查 | 检查 approved、申请人、日期、额度和版本 |
| OA-06 | 额度占用管理 | 并发安全 reserve / release / consume |
| MSG-01 | 补件 / 结果 / 提醒草稿 | 按业务对象生成可编辑文案和明确收件人 |
| MSG-02 | 确认发送与站内投递 | 返回真实 message id、action receipt、投递时间 |
| MSG-03 | 收件箱与已读 | 收件人可看正文和深链接，可幂等标已读 |
| MSG-04 | 发送核实与审计 | 丢响应保留 unknown，查回执不重发 |

## 3. 角色权限与可见范围

| 角色 / 权限 | OA 范围 | 消息范围 |
|---|---|---|
| employee / oa.read.own | 本人申请和本人可关联的批准快照 | 本人发件 / 收件；只能联系本单参与人 |
| manager / approval.decide | 授权部门本人当前经理任务和经办历史 | 向本任务申请人发送补件 / 结果通知 |
| finance / oa.read.linked | 仅与已获授权报销关联的必要 OA 摘要 | 向本人当前财务任务申请人发送消息 |
| platform_admin | 无业务内容权限 | 仅脱敏投递计数、失败码、任务诊断 |

前端不给任意 user_id 输入框；选人器来自当前业务对象可联系参与人，返回用户 id 与显示名。
同名人员必须展示所属部门供选择；未明确收件人则只创建可编辑草稿，不准备发送确认。
撤权后旧消息深链接重新鉴权；读消息不自动获得业务单据或其附件权限。
列表、搜索、计数、已读、下载都执行 tenant + actor + scope 校验；未知和越权对象统一 404。

## 4. 页面、抽屉与完整旅程

### 4.1 页面结构

| 页面 / 区域 | 主要内容 | 状态与动作 |
|---|---|---|
| /oa/entertainment | 本人草稿、待审、已批准、退回列表 | 新建；批准单只读 |
| /oa/entertainment/:id | 招待字段、金额、当前 task、审批历史 | 保存、提交、撤回、重新提交 |
| ?drawer=oa_request&resource=:id | 与详情同组件，展示报销引用和额度摘要 | 权限失败立即清除旧内容 |
| /oa/messages | 收件 / 发件、类型、对象、时间、已读 | 打开消息、标已读、查看发送结果 |
| 消息编辑抽屉 | 接收人、标题、正文、业务对象、链接预览 | 保存草稿、准备发送 |
| 消息发送确认 | 明确收件人、部门、正文、对象版本与效果 | 用户确认；过期或对象变更后重新准备 |

### 4.2 招待申请旅程

1. 李娜建立招待 OA 草稿；申请人与销售部由服务端填入。
2. 填写招待日期、招待对象与事由、预算；保存后得到 OA id + version。
3. 点击提交，校验通过后由 M11 准备确认；确认后单据进入 pending_manager。
4. 张伟打开当前 task，可批准或填写理由退回；批准记录预算和日期快照。
5. 李娜在报销中选择此批准 OA；M09 获取当前批准状态、日期、额度与对象版本。
6. 报销提交时调用 M10 reserve，在一个事务中占用申请额度；关联失败不会产生半份提交。
7. 财务核准后占用变 consumed；退回或撤回变 released，重新提交必须重新占用。

### 4.3 补件与结果消息旅程

1. 张伟在 clm-004 详情选择“补充材料提醒”，系统生成消息草稿并显示申请人李娜。
2. 草稿列出需要补充的字段；引用 claim id 和当前版本，不包含其他员工的票据信息。
3. 张伟可修改正文；点击“发送”进入统一确认，确认内容包括李娜、销售部和完整文案。
4. 用户确认后 M11 调用本模块 handler；事务写 message 与 recipient delivery 并产生成功回执。
5. 李娜收件箱出现提醒，点击后打开同一 clm-004 的最新详情；需要先退回才能修改已提交报销。
6. 李娜补正并重提后，旧消息正文保持原样，链接读最新单据并提示“单据已有更新”。
7. 业务审批 outbox 可产生结果通知草稿；发送仍需明确确认，不因为状态变化自动冒充人工发信。
8. 站内提醒无需真实 IM 账号，界面醒目标记“演示站内通知”；成功含义是写入接收人的站内收件箱。

## 5. 领域模型

| 表 / 字段 | 类型 | 约束 |
|---|---|---|
| entertainment_requests.id / tenant_id / version | common | id 不从编号推导；version 统一 CAS |
| owner_id / applicant_id | string | 同本人身份；禁止客户端覆盖 |
| department_id | string | 申请时组织快照，由服务端生成 |
| entertainment_date | date null | 草稿可空，提交严格合法 YYYY-MM-DD |
| entertained_party | string | 提交 1–200 字，包含组织或对象说明 |
| purpose | string | 提交 1–2,000 字 |
| budget | Money null | 提交为正 CNY，最大 100,000,000 分 |
| state | enum | draft / pending_manager / approved / returned / withdrawn |
| submitted_snapshot_id | string null | 本轮日期、对象、事由和预算不可变快照 |
| approved_at / submitted_at | timestamp null | 真实 UTC，不用模拟时钟改变审计时间 |
| oa_budget_reservations.claim_id | string | 按 claim + submission_id 唯一，避免重提重复占用 |
| amount | Money | 本次与此 OA 关联费用行的求和 |
| state | enum | reserved / consumed / released |
| reservation_key | string | M09 提供的内部幂等业务键，服务端生成 |
| demo_messages.owner_id / sender_id | string | 明确发送者，与确认 actor 绑定 |
| message_kind | enum | supplement / result / reminder |
| subject / body | string | 分别 1–100 / 1–2,000 字，只接受纯文本 |
| recipient_ids | array | 1–20 个去重用户 id，当前单据参与人范围 |
| resource_ref | ResourceRef | OA、差旅或报销的确切对象与准备时版本 |
| draft_version | integer | 正文或收件人修改增加版本并使旧确认失效 |
| state | enum | draft / sent；投递失败与 unknown 由 action 状态承载 |
| sent_at / action_id | timestamp null / string null | 发送成功后由事务写入 |
| message_deliveries.recipient_id | string | message + recipient 唯一 |
| read_at | timestamp null | 本人第一次标已读；重复调用返回相同结果 |

消息修改不回写业务单据；审批退回理由和补件消息分别保留，不能用发消息代替退回动作。
发送后正文与收件人不可编辑；需要更正时新建消息并明确引用原 message id。
暂未实现消息撤回，发送确认明确写“发送后接收人可见”；不能把删除对话当作删除业务通知。

## 6. 校验、关联与状态转移

### 6.1 OA 校验与状态机

- 日期必须是合法公历日期；2026-02-29、2026-13-01、空字符串均不合法。
- 新申请提交时 entertainment_date >= 当前 business date；允许当天申请，不允许用本入口事后补批。
- 已存在历史批准申请仍可被报销引用，不因今天已过而自动失效；有效性根据批准状态与发生日期校验。
- 预算输入最多两位元小数，后端存十进制整数字符串分；不接受负数、0、非 CNY、溢出值。
- 批准后本期不可改日期、对象或预算；需要更正由新申请表示，不能改历史批准快照。

| 当前状态 | 动作 | 下一状态 / 约束 |
|---|---|---|
| draft / returned / withdrawn | save | 保持状态、version + 1 |
| draft | oa.submit | pending_manager，冻结快照并建经理 task |
| returned / withdrawn | oa.resubmit | pending_manager，新审批轮次 |
| pending_manager | approval.approve | approved，task approved，保存批准快照 |
| pending_manager | approval.return | returned，理由 1–1,000 字 |
| pending_manager | oa.withdraw | withdrawn，当前 task cancelled |
| approved | save / withdraw / resubmit | INVALID_STATE |

### 6.2 报销匹配与额度原子性

| 检查 | 条件 | 失败表现 |
|---|---|---|
| 状态 | OA 当前 state=approved | OA_NOT_APPROVED 字段错误 |
| 申请人 | claim.applicant_id = oa.applicant_id | OA_OWNER_MISMATCH；不泄漏其他 OA 主体 |
| 日期 | expense.incurred_date = oa.entertainment_date | OA_DATE_MISMATCH，展示已授权日期差异 |
| 类型 | meals + business_entertainment | 其他费用不能用 OA 豁免自己的规则 |
| 金额 | consumed + reserved + 本次新增 <= approved budget | OA_BUDGET_EXCEEDED |
| 版本 | 引用 approved version 与当前对象匹配 | VERSION_CONFLICT 或 REVALIDATION_REQUIRED |

额度变动锁定 OA 额度行，按 claim submission_id 幂等；重试 reservation 不再次扣减。
已有同一 submission 的 reservation 应先排除自身再判断余额；不会重试时误报额度不足。
审批完成将 reserved 变 consumed；退回 / 撤回变 released；历史记录追加保留，不删除消费事实。
M09 与 M10 在模块化单体内共享 UnitOfWork，通过服务接口协作；不互相更新私有表。

## 7. HTTP、动作与适配器接口

所有端点位于 `/api/v1`，修改统一 Idempotency-Key；创建后更新使用 expected_version。

| 端点 | 输入 | 响应 |
|---|---|---|
| POST /oa/entertainment | 可空草稿字段 | OA id、version、state |
| GET /oa/entertainment/:id | 无 | 当前对象、批准摘要、可用动作 |
| PATCH /oa/entertainment/:id | expected_version、允许字段 | 持久化对象 |
| GET /oa/entertainment | cursor、limit、state | 授权列表，最大 100 条 |
| POST /oa/links/validate | claim / OA refs、费用日期金额 | 结构化关联校验；不占额度 |
| POST /oa/messages | kind、业务 ref、recipient_ids、文案 | 消息 draft |
| PATCH /oa/messages/:id | expected_version、收件人与文案 | 新 draft version |
| GET /oa/messages | inbox / sent、cursor、limit | 仅本人可见列表 |
| POST /oa/messages/:id/read | 本人 delivery 的 expected_version | 首次 read_at；幂等，不改变他人的消息版本 |
| POST /confirmations | oa.submit / resubmit / withdraw / oa.message.send | 统一 confirmation |
| GET /actions/:id | 无 | 发送或业务动作真实结果 |

```json
{
  "action":"oa.message.send",
  "resource_refs":[{"type":"expense_claim","id":"clm-004","version":3}],
  "args":{"message_draft_id":"msg-draft-1","expected_draft_version":2,
    "recipient_ids":["u-li"],"subject":"请补充票据信息",
    "body":"请补充本单缺失的发票号码，并在退回后更新材料。"}
}
```

确认服务绑定草稿内容 hash、收件人、业务对象版本和 actor；发前修改一个字也需要重新准备确认。
消息 id 不扩展公共 ResourceRef 类型；作为 action args 的领域引用，M11 用 extra version guard 绑定其版本。

```ts
interface OaAdapter {
  get(ctx: ActorContext, id: string): Promise<EntertainmentRequest>;
  validateClaimLink(ctx: ActorContext, input: OaClaimLinkInput): Promise<LinkValidation>;
  execute(ctx: ActionContext, command: OaCommand): Promise<ActionReceipt>;
  getReceipt(ctx: ActorContext, id: string): Promise<ActionReceipt>;
}
async function reserveOaBudget(tx: UnitOfWork, ctx: ActorContext, input: ReserveInput): Promise<Reservation>;
async function releaseOaBudget(tx: UnitOfWork, input: ReleaseInput): Promise<void>;
async function consumeOaBudget(tx: UnitOfWork, input: ConsumeInput): Promise<void>;
async function sendDemoMessage(ctx: ActionContext, input: SendMessageInput): Promise<ActionReceipt>;
```

reserve/release/consume 是内部服务端调用，不开放给模型直接改变额度；仍记录调用 actor 与关联 action id。
发送事务写入消息及所有接收人投递记录后才成功；数据库超时无法判断时返回 unknown 并以 action_id 查证。

## 8. 代码建议与 Codex 实施步骤

| 文件 | 责任 |
|---|---|
| packages/contracts/src/oa.ts | OA、消息、关联校验与额度命令 schema |
| apps/api/src/modules/oa/{schema,service,budget}.ts | 申请聚合、额度锁与幂等 |
| apps/api/src/modules/oa/{messages,action-handlers}.ts | 消息草稿、投递、业务动作注册 |
| packages/business-adapters/src/{ports,demo}/oa.ts | 可替换端口，不接真实 IM |
| apps/web/src/features/oa/{EntertainmentEditor,MessageComposer,MessageInbox}.tsx | 共用业务组件 |
| tests/integration/oa-budget.test.ts | 并发占用、退回释放、重提幂等 |

1. 建 OA、批准快照、额度与消息表，先完成范围查询和 Money / 日期校验。
2. 实现基本页面和 CAS 保存；复用 M11 handler 完成单经理审批链。
3. 实现 validate / reserve / release / consume，并联调 M09 提交事务。
4. 实现消息草稿和参与人选人器，接 M11 确认发送；以站内投递记录作为成功证据。
5. 接深链接、已读和错误重试；同一链接在原始页面与 Agent 抽屉显示相同业务对象。
6. 接 M15 故障与场景，验证超时核实不重复投递，禁止任何真实 IM 网络调用。

## 9. Given When Then 验收

| 编号 | Given | When | Then |
|---|---|---|---|
| OA-A01 | 李娜创建并保存招待申请 | 重载页面和 Agent 抽屉 | 日期、对象、预算、version 一致 |
| OA-A02 | 提交日为 2026-11-05 | 提交招待日期 2026-11-04 | 新申请拒绝事后补批，历史 approved 不受此限制 |
| OA-A03 | OA 处于 pending_manager | 张伟确认批准 | approved 且当前 task 完成，不能重复产生批准日志 |
| OA-A04 | OA 已 approved | 前端旧表单试改预算 | INVALID_STATE，批准快照保持原值 |
| OA-A05 | OA 日期 2026-11-04、预算 1,500 元 | 关联 11-05 发生的招待费用 | 日期不匹配，不能提交 |
| OA-A06 | OA 剩余额度 300 元 | 两张报销并发各占 200 元 | 只一项成功，不能超出批准额度 |
| OA-A07 | 报销已占 1,200 元 OA 额度 | 经理退回后原单修改重提 | 先释放，再按新 submission 重新占用，历史可追溯 |
| OA-A08 | 消息只有草稿且未确认 | 模型称“我已提醒李娜” | UI 不显示发送成功，收件箱无投递记录 |
| OA-A09 | 消息确认绑定 v2 与李娜 | 发前修改正文或改收件人为王强 | 旧确认拒绝，必须按新内容重新准备 |
| OA-A10 | 张伟已成功发 clm-004 补件通知但响应丢失 | 查询 / 重试同 action | 找到同一消息和回执，李娜只收到一份 |
| OA-A11 | 李娜从旧补件消息打开链接 | 单据已重提到新版本 | 打开同一 claim 的新版本并提示已有更新 |
| OA-A12 | 赵磊拥有运维权限 | 读取 OA 或消息正文 | 404，不因管理员身份获得业务读权 |
| OA-A13 | 同名人员存在两个部门 | 用户只说提醒该名字 | 展示候选并待选择，不能默发 |

## 10. 完成条件

可运行 Demo 必须展示批准申请被报销引用、并发额度保护和真实站内消息回执。
所有界面标明演示通知；M02 主动提醒、M01 聊天与 M10 业务消息分别保留自己的记录与权限，不通过复制正文伪造联动。
