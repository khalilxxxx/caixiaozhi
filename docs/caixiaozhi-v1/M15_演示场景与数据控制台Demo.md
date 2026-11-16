# M15 演示场景与数据控制台 Demo

版本：1.0｜深度：简易可运行 Demo｜固定数据：02 `finance-agent-v1.0`｜业务基准日：2026-11-05，Asia/Shanghai。
本文定义可重复的演示和故障恢复设施；不是静态对话播放器，也不代替各模块真实状态逻辑。

## 1. 目标、依赖与隔离边界

通过一键 seed/reset、场景切换、显式身份跳转、模拟业务时钟和故障注入，让演示可以从同一组数据重复进行。
控制台可简化为一个页面和几个抽屉，但每一步必须由后端生成任务、持久化状态并返回可查询回执。
应用代码不能根据 clm-001 这样的 ID 返回预设风险；夹具只提供输入，结论仍由 M03/M04 真实规则计算。
所有 Demo 运行在与生产连接、数据库和对象存储隔离的环境；生产部署不注册本模块路由和 Worker handler。

| 依赖 | 控制台可调用的能力 | 必须保持的边界 |
|---|---|---|
| M12 | 七人 seed、显式模拟身份切换、有效 grants | 切换创建新登录会话，不替换运行中的 actor |
| M08/M09/M10/M11 | 实体种子、状态机、动作回执、消息 | 场景旅程通过正式 API，不用前端直接改状态 |
| M02 | 已配置订阅的调度与 inbox | 初始订阅关闭；触发摘要不创建新订阅、不审批 |
| M03/M04 | 规则创建场景、字段映射、预审 | 场景换规则修订使旧结果 stale，不能覆盖证据 |
| M07 | 固定统计断言、报告与明细 | 统一 completed_at / submitted_at 口径 |
| M13/M14 | 停止新任务、租约、重放、故障恢复 | reset 先处理在途写入，不能删完数据后放旧 Worker 写回 |

固定业务租户为 t-demo；并行测试优先使用独立数据库，或环境隔离的命名空间加 alias→实际 ID 映射。
环境命名空间由服务端生成和白名单解析；用户输入不能直接拼接 SQL schema、存储 bucket 或文件路径。
业务主体仍遵循公共 tenant_id 契约；环境 ID 和 generation 额外放在执行上下文、队列、会话与控制表中。

## 2. 编号功能与权限

| 编号 | 功能 | 结果 |
|---|---|---|
| DEMO-01 | 查看环境 | 当前 seed、generation、业务时钟、任务状态和连接模式 |
| DEMO-02 | 初始化 seed | 持久化同一套完整业务对象和材料，返回 manifest hash |
| DEMO-03 | 安全 reset | 停止 / 核实旧工作，生成新数据 generation，再切换入口 |
| DEMO-04 | 选择场景 | 基准 / 规则创建 / 八条旅程；明确是否需 reset |
| DEMO-05 | 角色跳转 | 调 M12 显式切换到指定的七名种子人物之一 |
| DEMO-06 | 模拟业务时钟 | 变更本环境业务日与调度基准，不改变服务器时间 |
| DEMO-07 | 手动触发摘要 | 对既有订阅执行一次到期检查，按原订阅人授权生成 |
| DEMO-08 | 故障注入 | 限环境、限定类型、次数和期限的可复现故障 |
| DEMO-09 | 恢复与核实 | 关闭注入，查询在途动作回执，不冒充已经恢复成功 |
| DEMO-10 | 旅程证据 | 每步保存资源引用、状态、版本、trace 与断言结果 |

赵磊拥有 demo.control，可 seed/reset、选择注入、看控制任务元数据；不因此读取报销正文、个人对话或摘要内容。
业务旅程必须明确切换到李娜、张伟、刘敏等真实演示身份，再按各自业务权限操作。
普通业务用户可看到当前演示标识和自己的进度，不默认拥有 reset、任意注入和他人摘要内容访问权。
自动化旅程 runner 具有隔离环境控制能力，逐步以明确 seed actor 调正式 API；没有“跳过鉴权”参数。
控制台管理与业务会话各自审计；控制台不得借调试按钮返回任意原始数据库记录。

## 3. 页面、抽屉和关键旅程

### 3.1 页面结构

`/demo` 首屏四块：环境状态、场景选择、业务时钟、故障与恢复；状态栏始终显示“合成演示数据”。
环境卡显示 seed_version、manifest_hash、generation、最近一次 reset job 和七人 / 十一张基线校验结果。
角色卡显示姓名和部门，跳转使用 M12 的显式 switch；不得在前端只修改 role 字符串。
“开始场景”先给出前置状态和将重建本演示环境的范围；用户点击 reset 才提交有影响环境命令。
reset 进度抽屉显示停止接单、等待在途、核实回执、构建夹具、验证、切换 generation 六步。
“场景证据”抽屉按步骤显示 pass/fail、对象 ID/version、状态与 trace；无正文权限的操作者只见元数据。
“故障”抽屉使用预设下拉与次数 / TTL，提供明确恢复按钮；不提供任意脚本、SQL 或公网地址输入。

### 3.2 reset 的用户旅程

赵磊选择恢复基准 → 页面显示当前环境和在途任务数 → 明确点击 reset → 获得 job_id 和 202。
页面等待服务端事件或轮询；期间业务写入被拒绝为环境正在维护，旧页面不能继续操作。
若有未知业务结果，进度停在“核实在途结果”，展示受权限约束的状态和重查入口。
新 generation 完整验证成功后才显示“基准已就绪”；七人十一单和金额断言由后端校验完成。
旧身份会话失效，用户重新选择演示人物；不自动继承上一个人的对话和确认 token。

### 3.3 故障与失败状态

| 失败 / 变化 | 界面与恢复行为 |
|---|---|
| seed 不完整或 manifest 不匹配 | 显示 failed，当前 generation 不可标记 ready；保留诊断 |
| 旧任务无法结束 | 显示 draining / blocked，不先删除其业务对象 |
| 外部写入结果未知 | 持续核实；没有明确隔离证据不能强制 reset |
| 新夹具构建失败 | 保留旧 generation 只读及控制记录，重试 reset job |
| reset 请求重发 | 同幂等键返回原 job，不并行创建两个 generation |
| 角色切换后旧链接 | 重新鉴权，旧 generation 的业务 ref 不迁移到新对象 |
| 恢复故障后仍 unknown | 保留真实未知状态，恢复网络不代表业务失败或成功 |
| 生产访问 /demo | 404；服务端无 handler，不能只靠隐藏导航 |

## 4. 控制模型、版本与状态

控制表独立于可重建的业务命名空间，reset 不能删除自己的幂等账本、审计与在途核实证据。

| 模型 | 关键字段 | 约束 |
|---|---|---|
| demo_environments | id、logical_tenant_id、active_generation、write_fence、lifecycle、version | logical_tenant_id=t-demo；生命周期守卫所有写入 |
| seed_manifests | seed_version、content_hash、schema_version、expected_counts、assertions、alias_map | 固定输入可复现；hash 不同不能冒充同一基线 |
| reset_jobs | env_id、old/new_generation、state、phase、idempotency_key、requested_by、error_code | 每环境最多一个非终结 reset |
| generation_manifests | env_id、generation、seed_hash、namespace_ref、state、verified_at | 新 generation 验证后才可成为 active |
| demo_clocks | env_id、business_now、timezone、version | RFC3339 业务时刻；timezone 默认 Asia/Shanghai |
| fault_injections | env_id、generation、kind、scope_alias、remaining_hits、expires_at、state | expires_at 是真实时间；不能作用于别的环境 |
| scenario_runs | env_id、generation、scenario_id、actor_steps、state、trace_ids、assertion_results | 保存引用与结果，不伪造成功步骤 |
| control_audit | actor_id、operation、before/after_generation、job_id、occurred_at | 使用真实 UTC 时间，脱敏且不随 reset 丢失 |

lifecycle：ready → draining → resetting → verifying → ready；失败进入 failed/blocked，需要原因明确的恢复。
reset job：queued → running → succeeded/failed/blocked；blocked 可在核实障碍排除后继续同一 job。
fault：armed → exhausted/expired/disabled；恢复只是 disabled，不抹掉已产生的失败与动作回执。
scenario run：queued → running → passed/failed/cancelled；这是测试运行状态，不扩展公共 Agent run 状态枚举。
所有控制写入带 Idempotency-Key、expected_environment_version 和 expected_generation。
新的 seed_version 不覆盖已有同名版本；通过新的 manifest 和 reset 请求形成可追踪升级。

## 5. seed 与 reset 的实现安全顺序

### 5.1 seed 幂等与一致性

seed 使用固定 manifest 生成身份、grants、主数据、单据、行项目、票据材料、任务、规则、政策和 Skill 对象。
同一环境同 seed hash 已 ready 时重复 seed 返回当前 manifest，不重复插入用户、发票或任务。
基线所有业务单据 version=1；初始 pending task 必须真实关联该单，完成单据必须有完整费用与材料对象。
seed 内部导入可保存历史已提交单据；不能把这条导入路径开放为绕过普通提交校验的业务 API。
clm-004 保留已知费用 90000 分，但票据关键佐证未取得、verification_state=pending、核验事实 unknown。
不得为了让普通提交校验过关而把 clm-004 改成低风险，或把已知行金额改成 null。

### 5.2 reset 的锁、停止和防陈旧写入

1. 验证 APP_MODE=demo、当前环境隔离、控制权限、预期版本与幂等键，获取该环境 reset 独占锁。
2. 以环境控制行锁切 lifecycle=draining，停止接受新的 run、调度、OCR、预审及业务写入。
3. 所有本地写事务先取控制行共享锁，检查 ready、generation、write_fence；reset 等已开始事务退出后提升 write_fence。
4. 通知 M14 停止未来步骤并撤销旧 lease；关闭旧 SSE。已执行或在途有影响动作进入 M11 核实流程。
5. 等待 Worker 的 lease / 心跳确认和本地事务收束；旧令牌恢复时必须因 fence/generation 不符被拒绝。
6. 对外部 unknown 逐项查询回执；仅在明确核实或证明旧外部命名空间完全隔离并隔离其后续写入后继续。
7. 将旧动作账本、回执、控制审计和必要核实映射留在只读归档；不删除无法判断结果的唯一证据。
8. 在新 namespace 构建 next_generation 的完整 seed，材料对象使用新 generation 的私有存储前缀。
9. 验证外键、七用户十一报销、金额、待办、规则分类与附件可读性；失败不切 active_generation。
10. 单事务切 active_generation、业务时钟和 lifecycle=ready；新建会话方可进入新数据，原会话全部失效。
11. 旧业务 namespace / 文件在无在途引用后按保留策略清理，控制幂等记录永不被本次 reset 自删。

Demo 默认不启用任何真实外部写入；故障测试的外部 adapter 也必须带环境和 generation 隔离标识。
若某 adapter 无法证明幂等、回执查询和隔离，reset 保持 blocked，并报告具体待核实项；不提供“忽略所有未知”按钮。
已成功的旧动作只是归档到旧 generation，不可谎称被业务撤销；新数据恢复是演示环境重建。

## 6. 业务时钟、摘要触发与故障注入

### 6.1 时间边界

BusinessClock 返回本环境业务时刻，供“今天 / 本月 / 下周”、订阅到期判断、差旅日期校验和固定分析窗口使用。
基准固定 2026-11-05 11:00:00 Asia/Shanghai（03:00:00Z），在当日 completed 夹具 10:00 之后；与 02 共用同一配置。
系统 UTC 时钟用于 Cookie、confirmation_token、确认有效期、租约、重试退避、审计、fault TTL 和真实操作发生时间。
不能改操作系统时间、数据库 now()、JWT / Cookie 时间或 action receipt occurred_at 来推进演示。
02 的历史 completed_at 固定为对应日期北京时间 10:00，提交时间也按夹具；正常新操作记录真实 UTC。
分析筛选仍使用 completed_at / submitted_at；模拟时钟只决定查询区间，不能额外引入替代统计日期列。
在非 2026-11-05 实际日期运行财务完成示例时，选择包含实际完成时间的查询区间并显示口径；不能改写审计日期凑断言。

摘要触发只处理已经开启且到期的订阅；初始关闭的订阅返回 no_due_subscription，不能自动替用户创建。
调度去重键至少包含 env_id、generation、subscription_id、scheduled_for；同一计划时点只生成一份摘要。
控制台触发只是调度请求；生成时按订阅所有者重新鉴权，结果进入其 M02 inbox，不返回管理员正文。
业务时钟回拨不会删除已投递记录；再次经过相同计划时点不重复投递，reset 新 generation 才形成新夹具世界。

### 6.2 故障允许清单

| kind | 注入位置 | 期待行为 |
|---|---|---|
| ocr.timeout | M09 OCR provider | 真实任务重试 / 失败，页面状态持续可查 |
| ocr.low_confidence | 合成票据识别候选 | 待人工确认类型 / 字段，不能自动完成绑定 |
| preaudit.check_unavailable | 指定必查读取能力 | incomplete / partial_failed，不能归 low |
| action.response_lost_after_commit | 本地业务已提交后响应 | 客户端 unknown，查询恢复同一成功回执 |
| adapter.write_outcome_unknown | 隔离 mock adapter | action unknown→reconcile，不自动重发 |
| maas.read_unavailable | M13 受控只读能力 | 依赖失败并保留错误，不伪造工具数据 |
| sse.disconnect_once | 当前环境流连接 | 游标 / 快照恢复，无重复卡片 |
| worker.interrupt_once | M14 指定检查点 | 从 checkpoint 和公共 action 恢复 |

注入 scope_alias 只能选 manifest 中允许的场景别名；命中次数 1–10、真实 TTL 1–30 分钟，默认一次 / 五分钟。
关掉注入后新请求恢复正常；原 failed 任务按显式重试继续，原 unknown 动作仍需核实。
版本冲突与撤权用真实并发编辑 / M12 受控 grant 变更制造，不用伪造 HTTP 409 当作完整验证。

## 7. 固定基线与八条端到端旅程

### 7.1 基线账本

| 范围 | 固定对象 / 断言 |
|---|---|
| 身份 | 02 的七名用户；销售、技术为业务隔离部门，另有财务和 IT 所属部门 |
| 销售待主管 | clm-001/002/003/004/005；680/1200/2200/900/560 元，共 5540 元 |
| 技术待主管 | clm-006 陈杰 300 元，孙静审核；张伟不可见 |
| 待审分类 | risk=003、incomplete=004、attention=002、low=001/005；低风险 1240 元 |
| 销售本月完成 | clm-007=3500、clm-008=2400，合计 5900 元；11 月 5 日完成 |
| 销售上月完成 | clm-009=1000、clm-010=800，合计 1800 元；10 月 5 日完成 |
| 技术本月完成 | clm-011=5000；刘敏授权两部门合计 10900 元 |
| 草稿 / OA | trv-001 李娜北京→杭州、11 月 10–12 日；oa-001 李娜 11 月 4 日批准、预算 1500 元 |
| 其他 | pol-expense、company-rules-rev-1、rule-personal-meals、map-expense-v1、五共享 Skills 与一个私有 Skill |

全部待审报销 11 月 4 日提交；消费日期按 02，clm-002 为 11 月 4 日，其余为 11 月 3 日。
金额在数据库、HTTP 和断言值中使用分字符串；本表的元仅用于人读的验收对照。
七人十一张是每次 reset 后的基线；正常“发票到新报销”旅程创建的新单必须记录返回 ID，不纳入初始基线计数。
八条主旅程严格对应 02 的 E2E-01 至 E2E-08；每条独立从基线开始，避免上一场景修改污染下一条。

| 旅程 | 入口与真实操作 | 核心断言与失败分支 |
|---|---|---|
| E2E-01 制度问答与来源 | 李娜询问下周杭州住宿标准；点引用打开右抽屉；追问超标准处理 | 返回演示 800 元/间夜与可访问出处；无来源例外不编造；权限变化重新鉴权 |
| E2E-02 差旅与手改 | trv-001 手改保存 v2；说返程改 13 号；读取 v2、采纳 diff 为 v3；确认提交；张伟批准 | 手改保留；稳定 leg_id；两窗口 CAS 冲突；同 ID 变 approved |
| E2E-03 发票到报销 | 李娜上传 02 交通 180 元 / 11 月 3 日和含糊餐饮 200 元 / 11 月 4 日；异步 OCR、人工选餐饮、一票一行；餐饮连 oa-001 后提交 | 合计 38000 分；OA 原剩 30000 分仅占用餐饮 20000 分，剩 10000 分；新单 pending_manager；刷新保留任务；SRS 只收 JSON |
| E2E-04 个人规则 | 选择规则创建场景；张伟生成每单餐饮 gt 1000 规则；测试边界和缺值；确认启用；重做预审 | 999/1000 不触发、1001 触发；clm-002 attention；旧预审 stale；不覆盖公司制度 |
| E2E-05 低风险审批 | 张伟五张待办预审；看四组证据；选择 clm-001/005 并一次确认；查看逐项回执 | 124000 分转 pending_finance；经理剩 3、财务新增 2；销售完成仍 590000 分 |
| E2E-06 Skill 分析与报告 | 张伟选费用分析 Skill；查本月餐饮排行；下钻、生成月报草稿；授权导出 | 王强 180000、李娜 50000 分；图表 / 报告 / 明细同 snapshot；不能看到私有财务 Skill |
| E2E-07 记忆与隔离 | 张伟明确保存摘要优先 / 金额元偏好；新会话使用；切李娜验证；回张伟修改或删除 | 本人偏好有回执；李娜不继承；修改后新 run 生效，历史报告不改 |
| E2E-08 日报与收件箱 | 张伟明确开工作日 09:00 订阅；推进至次工作日 2026-11-06 09:00 并触发；读摘要、打开最新待办 | 仍在当前有效委托与授权内；同时点只一条；首页仅未读 / 数字变化；旧快照标时间；摘要不审批 |

规则创建场景使用同一组十一单，只停用 / 移除未被引用的个人测试规则；不能一边说尚无规则一边按它分类。
E2E-03 两票及 OA 兼容性严格取 02 同 fixture；交通不占招待额度；客户端不能为了成功改日期、金额或清除 clm-002 的既有占用。
E2E-05 的财务延伸由刘敏单独确认；若查询窗口包含实际完成时间，销售完成金额为 714000 分，全授权为 1214000 分。
02 的固定 completed 断言先在 reset 后执行；运行中新增对象和实际时间导致的变化必须以新快照单独报告。
每条旅程的证据包含请求 / 回执、对象版本、当前任务、实际断言；截图或模型说“完成”不能替代这些证据。

## 8. HTTP、服务签名与代码建议

| 端点（均加 /api/v1） | 输入 / 返回 |
|---|---|
| GET /demo/environments/current | 当前环境元数据、generation、seed hash、lifecycle；无业务正文 |
| POST /demo/seed | seed_version、expected_generation、expected_environment_version → job / 当前 manifest |
| POST /demo/reset | 同上、scenario_id、显式重建意图 → 202 job_id |
| GET /demo/reset-jobs/:id | 当前 phase、阻塞原因、进度与核实状态 |
| GET /demo/scenarios | 八条旅程、基准与规则创建场景元数据 |
| POST /demo/scenarios/:id/start | 当前 generation、actor steps → scenario_run_id |
| PUT /demo/business-clock | expected_version、business_now、timezone → 新 clock version |
| POST /demo/summary-triggers | subscription_id、scheduled_for、expected_generation → 去重调度结果 |
| POST /demo/faults | kind、scope_alias、hits、ttl_minutes、expected_generation → injection_id |
| POST /demo/faults/:id/disable | expected_version → disabled；已有动作状态独立返回 |

```json
{"seed_version":"finance-agent-v1.0","expected_generation":3,
 "expected_environment_version":7,"scenario_id":"baseline","intent":"reset_demo_environment"}
```

```ts
async function seedEnvironment(ctx: DemoControlContext, input: SeedInput): Promise<SeedJobView>;
async function requestReset(ctx: DemoControlContext, input: ResetInput): Promise<ResetJobView>;
async function runResetJob(lease: ControlLease, jobId: string): Promise<void>;
async function assertGenerationWritable(tx: UnitOfWork, ctx: ExecutionContext): Promise<void>;
interface BusinessClock { now(envId: string): Promise<BusinessInstant>; }
async function triggerSubscription(ctx: DemoControlContext, input: TriggerInput): Promise<TriggerReceipt>;
async function armFault(ctx: DemoControlContext, input: FaultInput): Promise<FaultView>;
```

| 文件 | 责任 |
|---|---|
| packages/fixtures/src/{seed,scenarios,clock}/ | 同一 manifest、八旅程步骤、业务时钟实现 |
| apps/api/src/modules/demo/{routes,service,schema}.ts | 环境控制 API 与权限 / 版本守卫 |
| apps/api/src/modules/demo/{reset,fault-registry,evidence}.ts | 安全重建、受控注入、测试证据 |
| apps/worker/src/{runner/generation-guard,scheduler/demo-clock}.ts | 防旧写入与模拟调度 |
| apps/web/src/features/demo/{DemoConsole,ResetProgress,FaultPanel}.tsx | 状态化控制台 |
| tests/e2e/scenarios/*.spec.ts | 02 八旅程共享同一 fixture 的完整验证 |

1. 建控制表、环境隔离和公共 generation/fence 守卫，再实现 seed；先断言七人十一单。
2. 将全部写路径、Worker、OCR、预审与动作服务接入 generation 守卫，拒绝旧上下文。
3. 实现 reset 分阶段任务与回执核实，验证旧 Worker 恢复后不能写新数据。
4. 接 BusinessClock 与既有订阅去重；保持真实系统时间不变。
5. 接故障注册表、期限 / 次数和恢复界面；各故障只替换声明的 provider 或 transport 层。
6. 按 02 实现八旅程 runner 和浏览器脚本，记录引用证据；再验证 reset 与异常矩阵。

## 9. GWT 验收

| 编号 | Given / When / Then |
|---|---|
| A15-01 | Given 空隔离环境；When seed 两次相同 manifest；Then 仍恰好七用户十一报销，所有基线单据 v1，第二次无重复对象。 |
| A15-02 | Given clm-004 夹具；When 真实预审；Then 行金额为 90000 分、票据核验 unknown，分类 incomplete，不改金额凑结果。 |
| A15-03 | Given OCR、Agent 与审批在途；When reset；Then 先停止接单并处理在途，旧租约不能写入新 generation。 |
| A15-04 | Given 外部 unknown 且未隔离；When reset 到核实阶段；Then blocked，业务数据和唯一回执证据不被删除。 |
| A15-05 | Given reset 请求网络重发；When 相同幂等键重试；Then 同一 job 和 generation；换参数同键返回 IDEMPOTENCY_CONFLICT。 |
| A15-06 | Given 新夹具构建中断；When重启恢复；Then 接续同一 job 或确定失败，active_generation 不指向半套数据。 |
| A15-07 | Given session / confirmation 即将过期；When 业务时钟回拨一月；Then 仍按真实时间过期，审计 occurred_at 未改变。 |
| A15-08 | Given 订阅初始关闭；When 管理员触发摘要；Then no_due_subscription；张伟明确开启后同计划时点只投递一次。 |
| A15-09 | Given 赵磊触发张伟订阅；When 查看控制结果；Then 只有任务元数据，正文只在张伟 inbox 可读。 |
| A15-10 | Given response_lost_after_commit；When 审批后恢复并查询；Then 原回执成功、仅一条决策，不重复增加财务任务。 |
| A15-11 | Given 故障仅一次且 TTL 五分钟；When 命中或过期；Then 后续调用正常，原 unknown 仍需核实，不能自动改成失败。 |
| A15-12 | Given 低风险两单刚通过经理；When 查销售 completed；Then 仍 590000 分，财务确认后才按实际完成时间计入新增金额。 |
| A15-13 | Given production 配置；When 注册 Demo auth/reset/fault 或访问 /demo；Then 启动校验拒绝错误配置或路由 404，无隐藏 API 可调用。 |
| A15-14 | Given 八条旅程逐条重置执行；When 汇总报告；Then 每条起点都是相同七人十一单，新增单只记入该次运行产物。 |
