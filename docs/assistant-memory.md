# 会话、个人记忆和只读摘要

本轮实现位于 `packages/assistant`。API/Worker 共用同一服务，不依赖浏览器常驻或业务 localStorage。

首页 GET 只读取授权待办和未读数，不创建会话。发送消息时，同事务保存 thread/message、Agent run/job、持久事件与 outbox；Idempotency-Key 与 client_message_id 双重去重，线程唯一活动 run、版本 CAS 和数据库锁防止两标签页竞争。queued/running 的补充消息保存为 pending_consumption，在安全完成点重新排入同一 run；waiting_user 直接续接原 run；interrupted 需要显式继续。

`assistant.message` 与严格校验的十一类 `card.upsert` 在 run 事件的同一事务投影。最终文本使用稳定消息 ID，卡片仅接受更高 revision。快照只读取本人会话，资源逐个重新鉴权和比较版本；无权卡片清除旧标题、摘要和动作。前端按连续 seq 去重归并，乱序最多缓存一百条，缺口/断线读取持久快照；断线不取消任务。

记忆只接受明确保存事件或手工保存。审核金额与风险条件返回 RULE_THRESHOLD_REQUIRES_RULE 并指向规则中心；普通聊天不会自动存入记忆。保存、编辑、删除、过期或来源会话删除均推进 memory_epoch；每次 ContextBuilder 读取当前有效项，最多八条。Worker 在每次模型、工具、流式事件和最终回复前调用 validateContext，核对当前权限、memory_epoch 与租约，旧生成不能继续发布。恢复记忆是新的版本写入，重新检查来源和有效期。

日程支持 daily/weekdays、HH:mm 和 IANA 时区；工作日固定周一至周五。DST 重复时间取第一次 UTC，不存在时间顺延首个有效时刻。发生唯一键包含订阅、日程版本、本地日期和时间。scheduler 在同一事务建立 occurrence、普通 durable_job 并推进 next_run_at；补跑仅保留最近一个且不超过六小时，其他明确记录 skipped。

时钟有两个边界：业务时钟决定 `scheduled_at`、日程槽和六小时补跑窗口；真实 UTC 决定 occurrence 的 `created_at`（接纳时间）、失败后六小时自动退避窗口、二十四小时显式重试期限和生成快照的 `generated_at`。投递有效期从真实 `generated_at` 起算二十四小时。推进演示时钟不会让刚接纳的实例过期，回拨不会重建已存在的日程槽。

后台摘要通过当前有效订阅委托读取，Skill 的完整能力集合必须只读；暂停、版本变化和撤权后发布前再次检查。生成与投递分开：快照+outbox 原子落库，投递用 occurrence/channel 去重，网络重试不会再查一次业务或产生第二条未读。生成失败有限退避，终态失败可投递可信失败摘要；显式重试复用发生实例和收件箱项，内容修订使未读最多增加一条。领域摘要走普通作业，不占 dsh 槽；只有确需模型整理时另由 M14 的后台 run 管理。

待办摘要使用 `ApprovalService.list` 的订阅只读分支：按 travel/expense/oa 的实时部门读取范围筛选，并始终限制 `assigned_to` 为订阅者、状态为 pending。它不要求或添加 `approval.decide`；交互审批列表仍要求审批决定权限及 assigned_task 范围。`skills.validateForSubscription` 复用当前 use 授权、版本生效、真实验证与依赖检查，再检查包括可选工具在内的全部效果必须为 read，仅返回效果元数据。只有选定 Skill 的订阅委托才包含既有只读许可 `skill.use`，不会因此获得 `source_read`、manifest 或 Markdown 源码。

收件箱送达只改变个人列表和未读数。用户点击查看后才创建一条本人会话和 reminder_summary，重复打开复用绑定。前端在成功呈现摘要后单独记录 read_revision。权限版本变化时旧预览立即清除，不在计数或搜索结果泄露旧范围信息。

确定性验证包括真实 PostgreSQL 的会话原子性/恢复、card stale/隔离、记忆失效、调度去重、投递/打开去重、暂停与撤权，及 DST、SSE 归并单元用例。真实模型集成单独验收；缺模型时聊天 run 明确 failed/DEPENDENCY_UNAVAILABLE，不返回固定智能答案。摘要的模板整理可以来自权威业务读取，页面显示只读性质。
