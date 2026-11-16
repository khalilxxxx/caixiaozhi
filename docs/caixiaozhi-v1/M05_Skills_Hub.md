# M05 Skills Hub：能力选择、个人创建与共享治理

版本：1.0｜建设深度：产品级｜实施输入，不包含应用实现。
前置阅读：[公共契约](01_总体架构与公共契约.md)、[联调基准](02_联调验收与演示数据.md)、M01、M03、M11、M12、M13、M14。

## 1. 上下文、依赖与边界

Skills Hub 把经过验证的任务说明、输入输出约束和工具范围组织成可发现、可选择、可复用的能力。普通用户看到“待办预审”“费用分析”等自然名称；作者可以编辑 Markdown 说明和结构化配置，平台负责校验、授权、固定版本和停用。
共享 Skill 可以指导工作方法，但不能替代公司制度、审批状态机、工具网关或用户本人授权。个人私用同样要通过基本校验，不能把“只给自己用”当成执行任意代码的入口。
本模块管理能力档案和使用授权；M13 管理工具与 MaaS capability，M14 经内部适配器把冻结版本加入 dsh 运行上下文。前端不直接读取 dsh 技能目录，也不把用户上传内容安装为 dsh 插件。
首期接受结构化 manifest、Markdown 和 JSON 示例；不运行上传的 JS/Python/shell，不接受依赖安装、执行文件、任意 HTTP/SQL、MCP 地址或新的底层工具。
M03 决定审核规则语义和启用，M04 决定预审分类与证据，M06 决定政策适用与引用，M07 决定分析口径，M08/09 决定草稿字段与保存，M11 决定确认和真实写入。

## 2. 编号核心需求

| 编号 | 核心需求 | 可验收结果 |
|---|---|---|
| SKL-01 | 可发现的能力目录 | 搜索前执行租户、可见范围和使用授权过滤；无权对象名称不泄露 |
| SKL-02 | 用户显式选择 | 输入框选择器、目录“使用”与深链接进入同一选择流程，显示版本及影响 |
| SKL-03 | 可解释自动匹配 | 只在授权候选内匹配，说明匹配原因；歧义时让用户选择 |
| SKL-04 | 完整档案 | 标题、用途、说明、输入、输出、工具、范围、示例、负责人和版本齐全 |
| SKL-05 | 私用基本校验 | 无效 schema、未登记工具、危险内容或失败示例阻止激活 |
| SKL-06 | 共享发布审核 | 校验、审查、作者确认发布是独立环节，发布范围可复核 |
| SKL-07 | 使用权分离 | 能使用不等于能查看 Markdown 源码，也不授予业务数据权限 |
| SKL-08 | 冻结运行版本 | run 固定 Skill 内容、manifest 和 capability 版本，处理中不热升级 |
| SKL-09 | 停用即时阻断 | 新调用、等待续接、确认执行均复核；既有在途写入继续核实 |
| SKL-10 | 工具范围约束 | 所选 Skill 白名单与用户、profile、环境授权取交集，不能自动绕出 |
| SKL-11 | 输出可验证 | 数据型结论来自真实工具结果；不符合输出 schema 的内容不能成为成功卡 |
| SKL-12 | 版本维护 | 编辑生成新版本，旧版本和使用记录可追溯，回退也须通过当前兼容校验 |
| SKL-13 | 五个预置能力 | 预审、规则、差旅填单、费用分析、制度问答跑通真实模块流程 |
| SKL-14 | 可审计与可运维 | 知道谁选了哪个版本、用了哪些工具、失败在哪里；默认不泄露正文 |
| SKL-15 | 隔离 Demo | 可选新闻能力仅在明确模拟场景出现，不能冒充真实财经新闻服务 |

## 3. 用户、权限与范围

公共 `skill.use`、`skill.manage` 是入口权限。以下 use/source_read/maintain/review/publish 是本模块资源授权动作，交 M12 执行 action-resource-scope 检查；不新增可以天然越权的角色。

| 身份或授权 | 可执行动作 | 明确边界 |
|---|---|---|
| 普通员工/主管/财务 | 使用被授权且有效的 Skill；拥有 skill.manage 时创建个人版本 | 业务访问继续按当前身份，不能因为 Skill 作者是财务就继承财务范围 |
| 个人作者 | 维护本人源码、验证、激活/停用个人版本、申请共享 | 不能自行批准共享审查；不能改其他人的私人档案 |
| 指定审查人 | 对被分配的共享候选读取源码、示例和测试结果，批准/驳回 | 仅对审查任务临时取得候选 source_read；不能看作者其他 Skill/对话/记忆 |
| 被授权发布者 | 对审核通过的版本申请指定范围发布，并确认影响 | 发布范围必须是自己可管理的组织范围；不能越过 M11 确认 |
| 平台管理员 | 停用异常能力、查询调用元数据、维护平台目录策略 | 默认无私人源码、用户问题、业务结果权限；内容排障须另行授权和审计 |

档案 scope 为 personal/group/tenant。personal 的 owner 固定，group 使用 M12 已验证组织组 ID，tenant 只覆盖当前租户。展示范围和使用授权都要满足；没有授权时搜索、推荐、计数、详情和直接 ID 均不可枚举。
`source_read` 与 `use` 分别授权；共享页面默认只显示公开元数据、已审查输入输出和工具影响摘要。不得通过“查看运行日志”“复制技能”“导出配置”变相取得源码。
有 `use` 而缺某项必需工具业务权限时，详情显示“缺少所需业务权限”，使用按钮不可执行；不得返回对象名称或金额作为缺权说明。选填工具缺权时可运行受限分支，但该分支必须在版本的输出约束中明示。
`scope_policy` 是上界：self、current_approval_assignments、authorized_departments 三种预设；可额外限制已授权部门，不能输入“全部部门”放大。运行时最终范围仍以 M12 和目标业务服务实时判定为准。

## 4. 界面与完整用户旅程

### 4.1 发现与选择

入口位于主导航“能力”，不是另建巨型管理后台。桌面内容最大 1120px，顶部搜索框 360–480px；“可用能力/我创建的/待我审查”按权限显示，默认显示可用能力。
目录卡片宽 280–340px、高约 180px，包含标题、两行用途、负责人、当前版本、作用范围及“使用”；每页 20 个，详情使用 M01 640px 抽屉。默认不展示调用曲线或排行榜。
标题最多 32 字，简介最多 120 字；状态使用文字和图标。禁用项在自己的维护列表可见，在普通候选列表移除；已固定的会话显示“已停用”并解释恢复方式。
输入框左侧“选择能力”打开宽 360px、最大高 420px 的键盘可搜索弹层；选择后呈现一个可移除标签“费用分析 · v1”。只允许一个活动 Skill，辅助能力必须预先列入该版本工具白名单。
“使用”只是选定能力，不自动发送空消息。存在参数默认值时展示可编辑输入；缺必填项进入表单或询问，用户提交后才创建 M14 run。
显式选择优先于自动推荐；用户输入与能力用途明显冲突时解释冲突并提供“更换能力/继续澄清”，不偷偷切回基础助手。

### 4.2 费用分析主旅程

张伟选择“费用分析”，输入“看本月部门餐饮排行”。服务端以当前身份解析到已发布冻结版本，记录选择来源 explicit，并确定所需分析权限。
M07 明示 completed、11 月截至 5 日、销售部口径，返回 analysis snapshot；卡片展示王强 1,800 元、李娜 500 元，抽屉明细来自同一快照。待审 clm-002 的 1,200 元不混入。
追问“做一份费用月报”时沿用这次能力版本和资源引用，调用预先列明的 finance.report.create，生成私人草稿。导出另查 analytics.export，发送报告仍走 M11 明确确认。
用户打开“本次使用了什么”只看 Skill 名称/版本、选择原因、工具名称、来源和影响摘要；没有 source_read 时不返回 Markdown、隐藏配置或模型完整上下文。

### 4.3 创建个人能力

用户点“创建能力”→填写标题、用途、目标用户和任务说明→从有权引用的 M13 工具目录勾选工具→填写输入输出 schema 和示例→保存新版本。
编辑器三栏流程为“基本信息”“工作说明与工具”“输入输出与测试”；主编辑区至少 560px，窄屏顺序堆叠。Markdown 编辑同时提供可读预览，禁用原始 HTML、远程图片和可执行链接。
用户可以从预置空白模板开始；复制他人 Skill 要同时有 source_read 与可复制声明，复制形成新档案且不带原授权、审查结果或凭据。
点“检查”触发持久验证任务，显示各检查项及字段路径；修改后生成新内容版本并重验。通过后显示“仅我可用”；明确点“启用个人版本”即可激活，不弹财务审批式确认。
个人激活不会出现在团队目录，不会自动创建首页能力卡。用户可将它收藏到选择器；收藏只影响个人排序。

### 4.4 共享发布与升级

作者在通过校验的版本上选择共享目标组或租户，提交发布说明和三个必备样例。后端验证可管理范围后创建审查任务，候选仍不可被目标用户调用。
审查人看到版本差异、工具新增/删除、读写影响、输入输出变化、范围扩大和测试结果；只能批准当前 content_hash。驳回必须有定位到章节/字段的原因。
作者修改后必须新建版本重新审查；批准不等于已发布。发布者点“发布”，M11 服务端生成包含版本、目标范围、工具和影响的确认，确认后才写入发布指针与使用授权。
共享 v2 发布后，新的未固定任务使用 v2；已经运行或等待中的 v1 任务保持 v1。用户在选择器明确固定 v1 时，只有 v1 仍允许新调用才可使用。
回退选择曾发布且当前仍可兼容的版本，显示变化并经过同一确认；不能直接改数据库指针绕过兼容校验，也不篡改历史 v2 使用记录。

### 4.5 详细状态与可访问性

| 页面状态 | 呈现 | 可操作和恢复 |
|---|---|---|
| 首次加载 | 3 个骨架卡、明确“正在加载能力” | 不显示虚构数量或示例调用成功 |
| 无可用能力 | 说明当前没有可用能力，保留基础对话入口 | 有创建权时显示创建；不列出无权能力 |
| 搜索无结果 | 保留查询文本，提供清空 | 不自动扩展到无权范围 |
| 检查中 | 每项 queued/running/通过/失败文字，最近更新时间 | 可离开，返回读任务结果；取消只停止未开始验证 |
| 检查失败 | 错误路径、原因、可修复建议 | 定位字段；禁用激活/提交审查 |
| 待审查/被驳回 | 展示本版本、提交人、时间、意见 | 可以复制生成新版本；不修改已提交源码 |
| 已发布/有更新 | 当前版本与可选更新说明 | 新任务可换版本；活动 run 只能继续当前版本或取消后重开 |
| 依赖停用/缺权 | 明确哪类能力不可用，不暴露敏感对象 | 刷新权限、联系授权方，不能“忽略继续” |
| 已停用 | 停用理由、时间，已产生结果仍可在权限内查阅 | 停止新调用；旧在途动作查看回执 |
| 保存冲突/离线 | 留存本地未保存文本，说明未保存 | 重新读最新状态、另存新版本；不覆盖远端 |

弹层支持 Arrow/Enter/Escape，焦点返回触发按钮；抽屉遵循 M01 焦点陷阱和关闭规则。错误使用 aria-describedby，异步完成用 polite live region；按钮触达区域至少 44px，文本达到 WCAG AA 对比度目标。

## 5. 首期预置能力与输出责任

| 名称 | 白名单工具 | 作用与输出 | 边界 |
|---|---|---|---|
| 待办预审 | finance.todo.list、finance.document.get、finance.preaudit.start/get、finance.action.prepare/status | 当前本人审批任务、四级分组、证据和待确认动作 | action.prepare 仅允许审批/退回当前选中对象；必经 M04/M11 前置条件 |
| 规则助手 | finance.rules.propose/test、finance.knowledge.search、finance.action.prepare/status | M03 结构化候选、边界测试、启用确认 | 只允许当前用户有权管理的个人/公司规则，不能写 memory 代替规则 |
| 差旅填单 | finance.document.get、finance.travel.propose_patch、finance.knowledge.search、finance.action.prepare/status | 最新草稿差异、缺字段、采纳与提交确认 | 只允许差旅相关 operation；手工值优先，禁止覆盖无关字段 |
| 费用分析 | finance.analytics.query、finance.report.create、finance.action.status | 授权 analysis snapshot、图表/下钻、私人报告草稿 | 无默认对外分发；导出独立授权；不查询任意 SQL |
| 制度问答 | finance.knowledge.search | 结论、有效日期、适用范围、版本/段落引用 | 无证据时明确未知；无任何业务写入工具 |

工具版本必须从 M13 已发布目录获取并冻结；表中 `start/get` 等斜线只是同前缀两个工具的文字缩写，manifest 必须逐个写完整工具名。
预置版本通过与用户自建共享版本同等的校验和审核流程；seed 可写入预审查记录，但必须标记合成基准和具体 manifest/hash，不能用 `is_builtin=true` 绕过校验。
联调数据固定五个共享 Skill；受限的 `skill-finance-private` 只授权给刘敏等指定财务组，张伟目录和搜索不返回其名称、简介、数量或源码。
可选“新闻摘要”只在 M15 选定的模拟场景登记单独模拟 capability，并在卡片、来源和调用记录标注“模拟新闻”。没有真实数据接入时不提供“实时财经新闻”承诺，也不加入默认五个能力。

## 6. Skill manifest、Markdown 和校验

### 6.1 冻结 manifest

```ts
type SkillManifest = {
  manifest_schema_version: 1;
  title: string; summary: string; intent_examples: string[];
  input_schema: object; output_schema: object;
  tools: { capability_version_id: string; required: boolean }[];
  scope_policy: {
    preset: 'self'|'current_approval_assignments'|'authorized_departments';
    department_ids?: string[];
  };
  allowed_action_operations: string[]; // M11 operation 目录校验后的子集
  output_card_types: AgentCard['type'][];
  examples: {
    name: string; input: unknown; expected: unknown;
    expected_tool_names: string[]; expectation: 'success'|'clarify'|'deny';
  }[];
};
type FrozenSkill = {
  skill_id: string; skill_version_id: string; version_number: number;
  content_hash: string; markdown: string; manifest: SkillManifest;
  capability_versions: string[]; revocation_epoch: number;
}; // 仅服务端内部；客户端无源码权时不返回 markdown
```

JSON Schema 首期采用统一锁定的 Draft 2020-12 实现，关闭外部 `$ref` 解析，只允许同一 schema 内部引用。输入对象 `additionalProperties:false`，最大嵌套深度 8、数组上限明确、每个字符串有长度限制；Money 引用公共结构，不接受浮点金额。
manifest 整体最大 128 KiB、Markdown 最大 64 KiB UTF-8、工具最多 12 个、示例 1–5 个、intent_examples 1–8 条。达到上限返回带路径的 VALIDATION_ERROR，不截断内容后悄悄保存。
Markdown 必须有“任务目标”“适用范围”“工作步骤”“需要询问的情况”“输出要求”“禁止事项”六节；这些节用于可读性和校验定位，不会高于平台系统策略。
工具描述、权限要求和 effect 来自 M13，作者只能收窄；不能把 write 声明为 read 或通过别名加入未登记工具。finance.action.prepare 还按 allowed_action_operations 校验，不允许空列表表示所有操作。
作者不能声明 token、actor、tenant_id、permission override、base_url 为工具执行参数。普通业务字段中出现同名文本也不会变成系统权限；敏感凭据扫描发现疑似密钥时阻止存储并提示删除该字段。

### 6.2 制度问答版本示例

下面 capability ID 是联调夹具别名，实施 seed 从 M13 登记结果生成真实 ID；不是 dsh SDK API。生产选择器从目录返回值填写 ID，不硬编码推测。

```json
{
  "manifest_schema_version": 1,
  "title": "制度问答",
  "summary": "查询当前适用制度，返回条款出处和生效时间",
  "intent_examples": ["下周去杭州，住宿标准是多少？"],
  "input_schema": {
    "type": "object", "additionalProperties": false,
    "required": ["question"],
    "properties": {"question": {"type": "string", "minLength": 1, "maxLength": 2000}}
  },
  "output_schema": {
    "type": "object", "additionalProperties": false,
    "required": ["answer", "evidence_refs", "needs_clarification"],
    "properties": {
      "answer": {"type": "string", "maxLength": 4000},
      "evidence_refs": {"type": "array", "maxItems": 20, "items": {"type": "string", "maxLength": 128}},
      "needs_clarification": {"type": "boolean"}
    }
  },
  "tools": [{"capability_version_id": "cap-knowledge-search-v1", "required": true}],
  "scope_policy": {"preset": "self"},
  "allowed_action_operations": [],
  "output_card_types": ["policy_answer"],
  "examples": [{
    "name": "缺少城市时澄清",
    "input": {"question": "住宿标准是多少？"},
    "expected": {"answer": "请提供出差城市和日期。", "evidence_refs": [], "needs_clarification": true},
    "expected_tool_names": [], "expectation": "clarify"
  }]
}
```

此处 self 表示以当前用户身份解析其适用政策，不能解释成只能检索 owner=用户的制度；政策组织范围由 M06 当前授权与适用性策略判定。共享审核需在此个人最小示例外补足成功与越权两个样例。

### 6.3 校验分层和审查准入

1. 解析与静态检查：版本 schema、大小、章节、输入输出、例子 JSON、引用完整性；禁止 HTML 脚本、外部 schema、执行声明和未知工具。
2. 能力检查：每个 capability 已发布、版本存在、环境正确、作者可引用；action operation 属于 M11 注册目录且没有扩大写入影响。
3. 范围检查：目标组织可管理、required 工具权限可描述、输出卡类型已登记；依赖已停用时不允许通过。
4. 示例检查：输入/expected 均过 schema；使用隔离测试 actor/fixture 的 dry-run 验证工具范围、澄清、拒绝和输出事实。测试替身只替换模型/外部依赖，领域服务仍执行约束。
5. 模型检查：有限预算下至少一次真实受控模型试运行，输出 schema、引用有效性和越权工具拒绝通过；模型未配置时结果为 blocked，不能宣称验证成功。
6. 个人激活需要 1–5 全部通过；共享还需要成功、缺字段、越权三类样例和独立审查。测试环境明确标识，任何有影响动作只停在准备/确认，绝不自动执行业务写入。

验证结果绑定 `content_hash + validator_version + profile_version + capability_version_ids`。任一内容或依赖发生变化不能沿用通过记录；运行时权限动态变化仍需重新判定，不要求为每次授权改变重跑全部模型测试。
规则检查是可审计门槛，不承诺靠扫描识别所有恶意提示；M13 工具强制授权、M11 确认和 M14 上下文隔离仍是执行边界。

## 7. 关键字段、表与约束

以下表带公共 id、tenant_id、version、created_at、updated_at；owner_id/actor_id 来自服务端。审查和调用记录为追加式，关联采用含 tenant_id 的组合外键。

| 表 | 关键字段 | 约束 |
|---|---|---|
| skills | owner_id, slug, title, summary, scope, state, published_version_id, revocation_epoch, archived_at | UNIQUE(tenant_id,owner_id,slug)；state=enabled/disabled/archived；归档不物理删除历史 |
| skill_versions | skill_id, version_number, manifest_json, markdown, content_hash, status, validation_id, base_version_id | UNIQUE(tenant_id,skill_id,version_number)；内容写入后不可变；status 变化走 CAS |
| skill_validation_runs | skill_version_id, content_hash, validator/profile版本, capability_snapshot, status, checks, test_run_ids, error_code | 同一个有效检查 key 只存在一个非终结验证任务；过期/失败可新建 attempt |
| skill_reviews | skill_version_id, requested_scope, requested_grants, reviewer_id, status, decision_reason, decided_at, reviewed_hash | review_pending/approved/rejected/withdrawn；批准者不能等于该版本作者 |
| skill_grants | skill_id, subject_type, subject_id, action, expires_at, revoked_at | user/group/tenant + use/source_read/maintain/review/publish；去重同有效授权，默认无源码权 |
| skill_activations | user_id, skill_id, active_version_id, selection_policy | UNIQUE(tenant_id,user_id,skill_id)；pin/follow_published；个人只能激活本人 validated 版本 |
| skill_publications | skill_id, skill_version_id, previous_version_id, scope_snapshot, confirmation_id, action_id, published_by | UNIQUE(action_id)；使用 M11 已确认账本，发布与授权/outbox 同一事务 |
| skill_invocations | run_id, skill_version_id, content_hash, selected_by, selection_reason, scope_snapshot, revocation_epoch, status | 每 run 至多一个主 Skill；selected_by=explicit/automatic/continuation；金额结果不重复存档 |
| skill_audit_events | skill_id, skill_version_id, actor_id, operation, before_hash, after_hash, reason, trace_id | 只追加；不保存确认 token、完整私有源码或个人记忆 |

Skill version.status：draft → validating → validated；失败回 draft 并保留失败记录。validated 个人可激活；申请共享变 review_pending → approved/rejected；approved 经确认后 published。rejected 修改生成新版本，不原地修改已审内容。
内容不可变意味着“保存编辑”总是新增 version_number；不用数据库公共 version 代表 Skill 内容版本。公共 version 只用于当前行状态/指针的并发控制。
身份不可空、工具必需项不可重复、父版本必须属于同租户同 Skill、发布指针必须指向该 Skill 已发布版本；删除 capability 不允许破坏已被引用历史，只能停用。
使用记录关联 M14 run 和 M13 call，业务事实保留 ResourceRef；manifest/hash 可验证但不作为授权凭据。授权撤销或停用事务递增 revocation_epoch，并写失效 outbox。

## 8. HTTP/API 与内部工具契约

以下接口均加 `/api/v1` 前缀，资源路径统一 `/skills`；鉴权、响应 envelope、Money、分页、错误、Idempotency-Key 和 expected_version 遵循公共契约。查询只返回当前用户可见字段。

| 接口 | 入参重点 | 返回与行为 |
|---|---|---|
| GET /skills | q, scope?, cursor, limit | 授权目录摘要；可用/缺工具权限状态，不返回 Markdown |
| GET /skills/{id} | version_id? | 档案、当前可使用版本、公开 IO/工具摘要 |
| GET /skills/{id}/versions/{version_id}/source | 无 | source_read 后返回 manifest/Markdown；无权统一 404 |
| POST /skills | title, summary, slug | 本人 personal 档案，默认未激活 |
| POST /skills/{id}/versions | expected_version, base_version_id?, manifest, markdown | 新不可变内容版本；返回校验待办入口 |
| POST /skills/{id}/versions/{version_id}/validate | expected_version | 202 validation_id；相同内容有效检查返回既有任务 |
| GET /skills/{id}/validations/{validation_id} | 无 | 检查状态、字段路径、脱敏失败依据 |
| POST /skills/{id}/activate | expected_version, version_id, selection_policy | 个人 validated 或已获 use 的 published 版本；无业务写入 |
| POST /skills/resolve | message, explicit_version_id?, resource_refs | 受权限过滤的选择计划或歧义候选，不启动 run |
| POST /skills/{id}/reviews | expected_version, version_id, requested_scope, grants | 校验通过才受理，记录拟共享对象和变更摘要 |
| POST /skills/{id}/reviews/{review_id}/decide | expected_version, decision, reason | 独立审查人批准/驳回 reviewed_hash；不自动发布 |
| POST /skills/{id}/publication-intents | expected_version, version_id, review_id | 由 M11 创建服务端 confirmation/action，返回可见摘要 |
| POST /skills/{id}/disable | expected_version, reason | 维护者/授权管理员立即停止新调用，返回受影响 run 计数 |
| POST /skills/{id}/enable | expected_version, reason | 重核有效校验、发布/激活资格和依赖；不自动恢复旧 run |
| PATCH /skills/{id}/grants | expected_version, add/remove | 新增共享受发布范围和确认约束；撤销即时生效、保留 owner |
| POST /skills/{id}/archive | expected_version, reason | 停用并归档；仅所有者/授权维护者，历史引用保留 |
| GET /skills/{id}/invocations | cursor, limit | 作者只看脱敏使用指标；本人只看自己可读 run；正文另查授权 |

publication-intents 的最终点击仍调用公共 `/confirmations/{id}/confirm`，并从 `/actions/{id}` 读取真实回执；M05 不创建平行确认服务。源码不包含 confirmation token，模型也不能从“用户已同意”文本构造确认。

```json
{
  "data": {
    "selection": "clarify",
    "candidates": [
      {"skill_id": "skill-preaudit", "version_number": 1, "title": "待办预审", "reason": "检查当前待办单据并查看证据"},
      {"skill_id": "skill-rules", "version_number": 1, "title": "规则助手", "reason": "创建或测试审核规则"}
    ],
    "question": "你想检查待办单据，还是修改审核规则？"
  },
  "meta": {"request_id": "req-51", "trace_id": "trace-51", "server_time": "2026-11-05T02:00:00Z", "data_mode": "demo"}
}
```

```ts
interface SkillService {
  validateVersion(actor: ActorContext, input: ValidateInput): Promise<ValidationJob>;
  resolve(actor: ActorContext, input: ResolveInput): Promise<SelectionPlan>;
  freezeForRun(actor: ActorContext, runId: string, selection: SelectionPlan): Promise<FrozenSkill>;
  assertUsable(ctx: ExecutionContext, frozen: FrozenSkill): Promise<void>;
  publishConfirmed(action: ConfirmedAction): Promise<ActionReceipt>;
  disable(actor: ActorContext, input: DisableInput): Promise<DisableReceipt>;
}
```

这是财小智内部服务签名，不是 dsh SDK 方法。`freezeForRun` 在创建 run 的事务内验证选择仍有效并写 invocation；此前 resolve 返回值不能当长期授权票据。
M13 `listAllowedTools/dispatchTool` 读取 frozen 的 capability ID 集合并与实时权限取交集，模型仅提供各工具业务 arguments；执行身份、run/call/lease、Skill 版本均由服务器补齐。

## 9. 自动选择、续接与运行时停用

自动匹配先过滤 personal 激活版本、被授权共享已发布版本、环境和必需工具可用性，再对标题、用途、intent_examples 检索最多 8 个候选。可用现有内网模型做结构化意图选择，但返回只能是候选 ID 或 none/clarify。
匹配理由必须由用户任务与公开用途生成，例如“你要比较部门费用，这个能力提供已授权部门统计”；不暴露私人源码、其他用户使用频率或无权候选。排序不得把模型自报置信度当成授权证据。
多候选覆盖不同业务影响、缺少业务对象、日期或范围时输出 2–3 个可用选项；没有匹配则保留基础助手，不虚构已调用的 Skill。选定后在首个处理状态中显示“使用：费用分析 v1”，不必创建额外聊天卡。
活动 run 不允许替换 selected_skill_version_id。切换能力先让用户明确保留任务并开新会话，或取消当前任务后创建新 run；同 thread 的 interrupted/waiting 状态仍占一个未终结任务位置。
普通追问在任务范围和工具白名单内续接；超出白名单时解释需要改用何种已授权能力，不能调用未声明工具完成“顺手操作”。
停用、撤销 use、依赖 capability 停用均在下一次 prompt、工具派发、用户可见结果提交和确认执行前检查；缓存键带 actor.authz_version、Skill revocation_epoch，TTL 只能优化，不能取代数据库拒绝。
queued 任务在取出时阻止启动；running 在安全点停止新步骤；waiting 任务续接前阻止。无未决动作时设 interrupted 并带公共 run.error 的 details.reason=SKILL_DISABLED/ACCESS_REVOKED，用户可取消或修复后显式恢复原版本。
若禁用时有已发出的写入，M14 保持 reconciling 或跟踪执行，M11 按实际回执判断；既有成功不撤销，unknown 不重放。停用不能关闭回执查询的系统核实能力。
Skill 重新启用不会恢复已失去的业务权限，也不自动重启旧任务。版本更新仅影响后续新任务；确认摘要绑定的版本停用/失效时返回 REVALIDATION_REQUIRED，不自动换版本继续确认。
源码保密通过 API/文件隔离和日志脱敏落实；模型可能依据说明生成面向用户的过程解释，不能宣称“提示词绝对不可推测”。受保护秘密本来就不得写入 Skill。

## 10. 异常、恢复、审计与保留

| 异常 | 用户状态 | 恢复策略 |
|---|---|---|
| Markdown/schema 不合法 | 定位章节/JSON path 的校验失败 | 另存修正版本再验，保留旧激活版本 |
| 工具被移除/版本不可用 | 依赖失效，不可新启用 | 作者替换依赖生成新版本，共享重新审查 |
| 模型验证超时 | 检查未完成，可重试 | 沿用 validation_id 续查；确认失败后新 attempt，不自动判通过 |
| 输出 schema 不符/引用不存在 | 当前步骤失败，不展示成功结果 | 在 M14 总预算内最多一次结构化修复，仍失败则保留真实工具结果并提示 |
| 检查结果与当前内容不一致 | REVALIDATION_REQUIRED | 使用新内容 hash 重新检查，不能只点重试发布 |
| 审查批准后扩大发布范围 | 旧审查无效 | 新 requested_scope/review，确认展示变化 |
| 双窗口发布 | 一次成功、一次 VERSION_CONFLICT | 重新读取指针和回执，不能覆盖他人发布 |
| 发布提交回包丢失 | 结果核实中 | 同 action/idempotency 查询，发布记录与授权最多一份 |
| 发布后个人缺业务权限 | 运行被拒绝 | 申请实际业务权限或换任务，Skill 作者授权无效 |
| 作者离职或账号停用 | 私人版本不可新调用；共享进入维护待接管 | 共享负责人由有权管理者显式转交并审计，不授予作者私人源码集合 |

审计包括创建、编辑版本、查看源码、验证、申请审查、审查决定、发布/回退、授权变化、停用/启用、匹配、使用、工具拒绝。字段含 actor、tenant、Skill/version/hash、run/call/action、范围摘要、reason、trace_id。
运行诊断遵循公共 90 天默认，SSE 7 天；业务结果由各领域留存。被历史 run/action 引用的已发布版本保持只读可追溯；未引用私人草稿归档后 30 天可清理正文，保留必要操作元数据。
指标只聚合成功/失败、验证耗时、调用耗时、缺权/停用拒绝，不把金额和聊天原文做排行榜。platform_admin 只看元数据；受控查看源文需要授权理由并记录。

## 11. 分阶段 Codex 实施清单

### P05-1 档案、schema、授权和目录

- [ ] 新建 `packages/contracts/src/skills.ts`：ManifestSchema、版本/验证/审查枚举、SelectionPlanSchema；引用 common/cards，禁止复制 Money 或扩大卡片类型。
- [ ] 新建 `apps/api/src/modules/skills/{repository,authorization,catalog-service}.ts`，实现 `listVisibleSkills(actor,query)`、`getSkillSource(actor,id,versionId)`；查询层预过滤租户和 grants。
- [ ] migration 建 skill_* 表、组合 FK、内容不可变约束、有效 grant 去重、发布指针 CAS；seed 按 02 建五个共享和受限财务 Skill。
- [ ] `tests/integration/skills-access.spec.ts`：`use_without_source_denies_source` 返回 404；`private_finance_not_searchable` 张伟搜不到受限名称/摘要/数量；`admin_no_private_source` 拒绝默认管理员。

### P05-2 编辑、验证和个人激活

- [ ] 新建 `apps/api/src/modules/skills/{version-service,validator,validation-service}.ts` 和 `apps/worker/src/runner/skill-validation.ts`，所有验证结果绑定内容/依赖/profile hash。
- [ ] `validateVersion` 只排队，复用 M14 租约与预算；`activatePersonalVersion(actor,input)` 只允许当前本人 validated 版本；验证环境不产生业务提交。
- [ ] 新建 `apps/web/src/features/skills/{SkillEditor,ValidationPanel,SkillDetailsDrawer}.tsx`，完成错误定位、离开保留、版本对比、键盘操作。
- [ ] `tests/contracts/skills-manifest.spec.ts`：`unknown_tool_rejected`、`external_ref_rejected`、`floating_money_rejected`；`tests/integration/skills-validation.spec.ts`：`invalid_private_cannot_activate`、`changed_hash_cannot_reuse_validation`。

### P05-3 共享审核、发布和撤销

- [ ] 新建 `apps/api/src/modules/skills/{review-service,publication-service,grant-service}.ts`；实现 `publishConfirmed` 并复用 M11，不编写客户端签名 token。
- [ ] 审查、scope、工具差异和 hash 绑定；确认成功同事务写 publication、发布指针、有效 grants 和 outbox；停用/撤销更新 revocation_epoch。
- [ ] `tests/integration/skills-publication.spec.ts`：`author_cannot_self_approve`、`scope_change_requires_review`、`lost_reply_publishes_once`、`stale_confirmation_cannot_publish`，断言授权集合及指针只改变一次。

### P05-4 运行接入、选择器与端到端

- [ ] 新建 `apps/api/src/modules/skills/{resolver,runtime-policy}.ts` 与 `packages/agent-runtime/src/context/skill-loader.ts`；内部 freeze/load 接口对接 M14，SDK调用仅放已验证 dsh adapter。
- [ ] 新建 `apps/web/src/features/skills/{SkillPicker,SkillLibrary,SkillUseDetails}.tsx`，M01 输入框挂载；选择后不自动提交，活动任务切换有明确决策。
- [ ] `tests/integration/skills-runtime.spec.ts`：`pinned_run_stays_v1`、`tool_scope_intersection`、`disable_blocks_waiting_resume`、`disable_preserves_unknown_reconciliation`；断言旧版本不热换、未决 action 继续查询而非重发。
- [ ] `tests/e2e/skills-analysis.spec.ts`：跑 02 E2E-06，王强 180000 分/李娜 50000 分，报告与分析同 snapshot；`tests/e2e/skills-private-authoring.spec.ts` 覆盖创建→检查→激活→运行→停用。

## 12. Given / When / Then 验收

| 编号 | Given | When | Then |
|---|---|---|---|
| A05-01 | 张伟具备共享分析使用权 | 选择费用分析但未发送问题 | 输入框出现能力标签，不创建 run/message |
| A05-02 | 基准数据和张伟权限 | 发送本月餐饮排行 | completed 口径仅王强 1800、李娜 500，证据指向真实 snapshot |
| A05-03 | 受限 skill-finance-private 仅财务组有权 | 张伟搜索名称或直接请求 ID | 搜索无结果、详情 404，无摘要或计数泄露 |
| A05-04 | 用户仅有 use | 读源码、复制或导出 manifest | 404，正常运行仍可在自身业务权限内执行 |
| A05-05 | 私人版本引用未登记工具 | 点检查/激活 | 校验失败定位 tools 路径，激活被拒绝 |
| A05-06 | Markdown 包含上传脚本/任意执行声明 | 保存并检查 | 拒绝危险执行配置，无进程/网络/安装副作用 |
| A05-07 | 私人校验任务被模型超时阻塞 | 点击启用 | 未通过不能启用，用户可恢复检查且不会生成假成功结果 |
| A05-08 | 作者提交共享版本 | 作者尝试批准自己的审查 | 403，版本保持待审查 |
| A05-09 | 审查批准 v1/范围甲 | 发布前改为范围乙 | REVALIDATION_REQUIRED，需新审查和新确认 |
| A05-10 | 共享发布确认成功但响应丢失 | 同 key 重试和查询 | 同一个 ActionReceipt，一条 publication，一组授权 |
| A05-11 | run 已冻结 v1 | 维护者发布 v2 | 旧 run 仍用 v1，新的 follow_published 任务使用 v2 |
| A05-12 | Skill 宣称可看全部部门 | 张伟调用分析 | 仍限销售部，M13/M07 拒绝技术部读取 |
| A05-13 | 用户显式选择制度问答 | 输入要求审批单据 | 澄清或提示更换能力，不调用 action.prepare |
| A05-14 | 两个授权候选均符合模糊问题 | 自动选择阶段 | 展示 2–3 个候选与用途差异，不先执行高影响分支 |
| A05-15 | 等待确认的 run 固定某 Skill | 管理员停用后用户点确认/续接 | 阻止新执行，要求重新验证；thread 非终结约束保持 |
| A05-16 | 停用前审批请求已发出且 unknown | 停用能力并重启 Worker | 继续核实同 action，不再发送审批；真实成功仍可显示回执 |
| A05-17 | 输出声称政策有例外但无引用 | 校验最终结果 | 不能发布可信政策卡，修复失败后说明缺少依据 |
| A05-18 | 用户在工作中切换登录身份 | 旧选择器、缓存和 Worker 继续请求 | 旧身份上下文失效，新身份重新筛选，没有跨人结果/源码 |
| A05-19 | 个人版本已通过检查 | 新保存的版本改了一个工具 | 旧通过记录不可复用；旧激活版本仍可用直至显式更换 |
| A05-20 | 默认种子和普通运行模式 | 打开能力目录 | 五个共享能力按授权出现；模拟新闻不在默认列表 |

## 13. 完成标准

四阶段清单和全部验收有可复现 API/数据库/浏览器证据；五个预置能力各至少一次真实 dsh+内网模型链路，不以完整 Agent 替身替代通过。工具参数、权限拒绝、金额、引用与回执做确定性断言，生成措辞不要求逐字相同。
私人创建也有校验/激活门槛，共享发布具备独立审查、确认、不可变版本、范围授权和停用；M01 显式选择/自动解释、M13 工具交集、M14 固定版本与等待恢复均联通。
缺模型、缺业务工具、撤权、停用、发布冲突、unknown 回执均有可恢复状态；不存在上传代码执行、模型制造确认 token、Skill 授予业务权限、静默热升级或通过源码接口泄露私人内容的路径。
