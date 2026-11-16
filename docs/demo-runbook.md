# 演示环境操作与恢复

本说明对应 `finance-agent-v1.0`，只用于合成演示数据。生产环境不注册 `/api/v1/demo/*`，服务和受控 seed 入口也拒绝运行。

首次初始化通过应用提供的受控 seed 命令调用 `demo.initialize()`。它真实写入七名身份、十一张报销及材料，检查初始版本、销售待审 5 张/554000 分、销售当月审批完成 590000 分，以及 clm-004 的 90000 分与票据核验 pending。任一断言失败时保持 failed，不显示已就绪。重复初始化已就绪的同一清单不会再次添加对象。

重建由有 `demo.control` 的演示管理员发起，提交当前 environment version/generation、种子版本、场景及 `intent=reset_demo_environment`。相同 Idempotency-Key 复用原任务；变更内容使用原 key 返回冲突。API 返回 202 后，Worker 的 `demo.runNextReset()` 处理持久作业。

系统先进入 draining，提升 write_fence，拒绝新的领域写入。数据库触发器覆盖迁移时已有的 tenant_id 领域表，对 pg 与 Drizzle 采用相同共享 advisory 事务锁和环境行锁；控制命令取得对应排它锁。旧 Worker、旧确认和旧会话无法向激活后的新租户写回。后台普通作业与 Agent 租约也会撤销。

未核实的 executing/unknown 动作会阻塞重建，保留原业务对象、动作账本、回执和审计。管理员应通过 M11 原 action 查询回执，不能重发原写命令。核实完成后调用 reset job 的 resume 接口继续同一任务。维护期间只开放会话簿记、旧在途动作的回执核实与审计追加；普通业务写入仍被屏障拒绝。

下一 generation 使用服务端生成的新 tenant 命名空间。它先登记为 building，由私有 seed 回调初始化，不允许普通 API 身份访问；完整性验证通过后，在同一事务中切换 active_tenant_id、generation、manifest hash 与 ready。旧数据归档保留，已成功的业务动作没有被声称撤销。构建失败时不会切换到半套数据；查询 reset job 的 phase/error_code 后重新发起受控重建。

应用接入 `demo.gate.assertCurrentActor(actor)` 拒绝过期或维护中的业务身份；领域事务可额外调用 `assertGenerationWritable(tx,scope)`。Demo 控制台的身份检查应使用原始 IdentityService，以便 blocked 时仍可查看和恢复控制任务。`demo.gate.currentTenant()` 返回当前有效登录租户与 generation，身份列表和登录必须使用该结果。

Demo Worker 每次 tick 使用当前环境的 active tenant 作为 SQL 领取范围，覆盖 Agent run 及过期恢复、财务领域作业、普通队列、日程调度、摘要生成和待投递 outbox。`createWorkerRunner.claimScope` 每次 tick 重读范围；范围过滤发生在排序、限量和加锁之前，因此其他环境或归档租户的旧任务不会阻塞当前环境，也不会使用当前环境的业务时钟处理。生产环境省略单代 scope，保留普通生产租户的多租户调度；摘要调度、生成和投递仍在排序/限量前排除已归档或维护中的 Demo 租户。

业务时钟只改变查询区间和日程计划，不改变服务器、数据库 now()、Cookie、确认 token、租约、故障 TTL 或真实审计时间。M02 日程创建使用独立 businessNow 端口；记忆到期与投递保留仍用真实时钟。`POST /api/v1/demo/summary-triggers` 原子保存控制请求与 `demo.summary` 持久作业，返回 202 和 `request_id/job_id/status=queued`。Worker 的 `processNextSummaryTrigger()` 在控制事务外执行限定 tenant/subscription 的调度，并在提交前重新核验环境与租约；`GET /api/v1/demo/summary-triggers/:id` 查询 `scheduled/no_due_subscription/failed/cancelled`。控制结果仅包含入队数量，不保存个人摘要正文。重建取消旧代触发请求。

故障注入仅支持固定八类，scope_alias 必须来自当前 manifest，命中 1–10 次、真实 TTL 1–30 分钟。业务适配器通过 `consumeFault(tenantId,kind,scopeAlias)` 原子消费命中。恢复操作只停用后续注入，不改写已经产生的 failed/unknown 结果。

真实验证见 `tests/integration/demo-control.spec.ts`：使用真实 PostgreSQL、Identity seed、业务夹具及私有对象存储，覆盖种子幂等与基线、业务时钟与真实 TTL、raw pg 陈旧写入被 DB fence 拒绝、旧租约失效、新代原子激活、unknown 阻塞与继续、构建失败不切换、production 拒绝。

八条旅程必须各自在基线 reset 后，通过正式业务 API 与显式演示身份逐步运行。场景控制记录只保存引用、trace 和实际断言；启动场景不等于验收通过。当前真实模型缺配置，真实自然语言旅程与 20 活跃 run/100 SSE 的容量验收仍需独立执行，不能由控制台初始化成功推断通过。
