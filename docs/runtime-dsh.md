# dsh 运行底座与恢复记录

记录日期：2026-11-07。真实模型配置缺失；本文件明确区分真实 SDK 传输验证与真实模型验收。

## 实际锁定版本

- Node.js：24.22.1；官方 dsh 要求 >=24.9.0，22.16.0 会被运行预检拒绝。
- 官方 `@deepseek-ai/dsh-sdk-client`、`@deepseek-ai/dsh`、`@deepseek-ai/dsh-llm-pi-ai`、协议与会话包均为 `0.2.2-rc.1`。
- 官方仓库：[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，npm 元数据 repository.directory 与发布 tarball 类型声明、README 均已实际读取。
- `dsh` 是另一个 2016 年的 shell 包；`@deepseek-ai/dsh-sdk` 不存在，本实现没有使用它们。
- SDK 客户端是纯 TypeScript/Node 路线；不要求 Python。其依赖加载原生 subprocess、PTY 服务，安装时需允许对应官方包与 node-pty/koffi 构建。

## 配置与受控 profile

设置 `DSH_API_KEY`、`DSH_BASE_URL`、`DSH_MODEL`、`DSH_CONTEXT_WINDOW`。协议 `DSH_API_PROTOCOL` 默认为 `openai-completions`，另外支持官方 pi-ai 适配器的 `openai-responses`、`anthropic-messages`。地址和模型是部署配置，模型/HTTP 客户端不能覆盖它们。

SDK 以 `sdk-minimal` 启动，并使用服务器生成的 `finance-sdk-v1` patch：关闭 persistent-bash/pwsh、文件工具、working_directory 工具、自动模型摘要和独立重试，只注入已授权财务工具与官方 pi-ai 网关 provider。每个 run/epoch 有独立 0700 目录和 home；patch 与 bridge 使用 0600。子进程环境只传明确必需项和本项目模型凭据，不继承其他账号凭据。

财务工具通过每 run 独立的 127.0.0.1 临时端口及随机令牌回到宿主，模型只提交 arguments。宿主重新校验目录、版本、租约、当前身份和工具预算。普通业务领域作业使用 `durable_jobs`，不创建 Agent run、不占 dsh 槽。

## 已验证事实

`tests/integration/dsh-runtime.spec.ts` 的确定性传输用例实际启动官方 SDK/CLI 子进程，连接明确标注的测试模型 HTTP 夹具。两次模型请求完成一次 `finance.health.read` 往返；两轮模型均仅看到此工具，没有 shell/fs 工具；中文增量、最终文本、usage、宿主回调及正常关闭可用。此测试验证 SDK 和 profile，不证明真实模型服务可用。

`tests/integration/run-recovery.spec.ts` 使用真实 PostgreSQL，通过幂等、同线程唯一、双 Worker 单所有者、旧 epoch 拒绝、等待释放槽、跨用户取消隔离、每用户 2 槽/10 未终结、公平排队、普通作业去重/fencing、事件重放/过期快照、unknown 写入不重放、预算以及缺模型明确失败断言。`tests/unit/runtime.spec.ts` 验证工作目录隔离、版本/配置预检、记忆重读和上下文预算。

2026-11-08 的真实模型预检因缺少四项 `DSH_*` 配置返回 `DEPENDENCY_UNAVAILABLE`。2026-11-12 已完成下述官方 DeepSeek 连接验证。

## 2026-11-12 官方 DeepSeek 接入

本机 `.env` 使用 `https://api.deepseek.com`、`deepseek-flash` 和 `openai-completions`。官方 `/models` 实际返回 HTTP 200，模型元数据给出上下文上限 1,048,576 tokens、输出上限 393,216 tokens。运行配置采用该上下文上限，单次输出继续受应用预算约束。当前模型标识与元数据可在官方接口核对。[模型列表文档](https://api-docs.deepseek.com/api/list-models/)

实际联调发现官方接口要求函数名匹配 `^[a-zA-Z0-9_-]+$`。适配层现将规范能力名称和版本映射为稳定的 51 字节内部别名，注册描述保留规范能力名。loopback 将当前别名和精确版本解析回规范工具，再执行原有授权派发。工具事件、回执与审计继续记录规范名称。

六项确定性 SDK 验证通过，覆盖协议名称合法性、清洗后同名的不同能力、目录换序、续接稳定、未知别名和版本错配拒绝。加载本机环境后，`dsh_real_tool_roundtrip` 通过实际官方模型完成流式调用和只读工具往返，耗时 3.276 秒。API、Web 与 Worker 已重启，Worker 确认模型配置已加载，真实浏览器页面检查通过。脱敏记录保存在 `docs/verification/deepseek-connection-latest.json`，原始技术验证日志保存在 `.runtime/deepseek-real-connection.log`。八条完整业务旅程与 20 run / 100 SSE 容量仍待单独执行。

## 持久化与恢复

PostgreSQL 是产品状态真相源：runs/jobs/events/checkpoints/leases/usage/tool 调用和审计均持久化。创建先提交 run、job、事件、outbox，再返回 202。线程非终结部分唯一索引覆盖 interrupted 与所有等待状态。领取在短事务中以配额锁和 `SKIP LOCKED` 确保用户 2 槽、租户 20 槽及公平排队。租约默认 30 秒、10 秒续约；每次工具提交核验 epoch 与有效期。

所有真实模型调用另经共享 `model_slots`：对话 run、结构化生成、Skill 验证合并计算每用户 2、每租户 20 个占位。领域 durable_job 不申请模型槽；同一占位幂等获取、过期重取递增 epoch，旧 Worker 的释放不能清除新租约。运行续接只取得累计预算的剩余额度；模型与工具派发先预留，已经实际发生的 token 和活动时间即使超额也先持久记账，再终止后续调用。

输入按实际messages/system/tools保守估算并限制为窗口70%；单次输出同时受窗口剩余30%与当前run剩余输出预算约束。宿主在每轮模型前分配额度，bridge使用该版SDK公开的`LlmRuntime.stream`重新绑定受限请求，不修改已准备调用的冻结配置。实际SDK测试网关已验证两轮请求的输出上限从25降到15（首轮真实usage为10），工具往返与确认暂停仍通过。SDK JSONL不作为应用配额真相源，实际usage与剩余额度由应用持久账本控制。

每次领取的 epoch 共享一个活动时间结算事务。确认、用户或领域等待的 checkpoint 在释放租约前先结算本段活动耗时；挂起后的等待时间不计入活动预算，旧所有者也不能再记账。正常完成、异常和停机复用同一结算，避免并发退出重复累计；多次续接仍受同一 run 的累计 `active_ms` 限额约束。

等待用户/确认/领域作业均保存结构化 checkpoint 并释放模型槽；领域等待保留 running/phase，但 `runtime_active=false`。领域完成使用 run/checkpoint/job/generation 去重后重新鉴权，再入同一 run 队列。取消先落 `cancel_requested_at`，拒绝新工具；已有未知写入进入 reconciling，不能显示 cancelled 掩盖回执。只读崩溃自动重新排队一次，后续保持 interrupted；未决写入只查询动作回执。

SSE 按单 run seq 持久回放，发送前重取身份，断线不取消。过期返回 409/REVALIDATION_REQUIRED、`EVENT_CURSOR_EXPIRED`、最新 seq 与快照入口。最终消息和卡片不随过期 token 清理。

事件、助手消息和卡片各自保留不可变 `authz_version`。权限版本变化时 SSE 返回 `PERMISSION_CONTEXT_CHANGED` 和当前鉴权快照入口；旧助手内容不再进入线程快照或后续模型上下文，旧卡片显示不可用占位。续接更新 run 的权限版本不会重新授权既有内容。

## SDK 的真实限制

该版客户端没有单 prompt 的原生取消 RPC；超时仅停止本地等待，不会停止运行。`DeepSeekHarness.close()` 负责 SDK 自有子进程的 shutdown → EOF → SIGTERM → SIGKILL 清理。每 run 独占 harness，避免误停其他用户。强制停止是否完整 flush 无公开可核验证据，`stop()` 保守返回 `persistence_state=uncertain`。

官方提供 `resumeSession()` 与 JSONL 持久化，但最终写入屏障仍依赖成功 shutdown；本实现不抢占未知旧进程的 JSONL。新 epoch 使用新 session，从应用 checkpoint、资源引用和已完成调用结果恢复语义。完整模型业务旅程、多机持久卷、磁盘满、OS 容器资源限制与 20 run + 100 SSE 容量尚需部署环境验证。

## 运维操作

滚动升级先停止领取，持久检查点并关闭拥有的独占 harness，释放租约或记录 interrupted；不得直接删除进程后假称恢复完成。未知动作只能通过原 action/idempotency key 查询回执，禁止重发原写命令。15 分钟仍未知须人工核查。

Worker 的独立回执巡检使用 `createReceiptReconciler`：每次领取一项到期核实，`action_attempts` 的递增 attempt 与 30 秒到期时间构成持久租约。首次 unknown 后等待 2 秒，后续按 5/15/30/60/300 秒退避；超过 15 分钟写一次 `reconciliation.manual_required` 元数据审计，仍保留 unknown 并每 5 分钟查询。每次查询最长 15 秒，提交前重新核对当前身份、资源读取权、权限版本、代际和最新核实租约。进程重启复用原 external_request_id；失去租约的旧 Worker 不发布结果。

`actions.listReconciliation` 仅向 `operations.read` 返回 action/trace/状态/次数和时间元数据，不提供参数、摘要或正文。对象已审批或提交后，历史动作、确认重读及核实按当前读取权限检查；首次确认和实际执行仍按原写动作授权。已核实的关联 run 由 `RunService.reconcileRun` 转入安全续接；已取消的 run 不因晚到回执恢复。演示维护屏障中不能领取普通核实作业时，保留 unknown 阻塞，使用原 action 的直接核实入口查清回执后再继续 reset。

密钥轮换只更新部署 secret，重建 Worker，不写数据库、工具结果、日志或文档。先暂停有问题的能力/配置的新调用，再核实已有未决写入。备份 PostgreSQL 与受保护运行卷时记录共同时间点；恢复后先隔离旧 Worker，再以新 epoch 启动。日志只记 run/trace/错误分类，不记录会话正文、token 或附件内容。
