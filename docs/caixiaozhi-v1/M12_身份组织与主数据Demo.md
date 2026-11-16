# M12 身份、组织与主数据 Demo

版本：1.0｜深度：简易可运行 Demo｜依赖：01 公共契约、02 固定夹具。本文规定真实授权边界，身份来源可以在演示环境模拟。

## 1. 目标、依赖和边界

提供可信 ActorContext、签名会话、租户与部门权限、人员目录、成本中心和城市映射，让全部模块使用同一身份来源。
演示选择一个人物并不意味着浏览器获得构造角色的能力；服务端按该人物的有效 grants 重新生成会话。
平台管理员只拥有连接器、运行元数据和演示控制权限，不默认读取员工报销、附件、对话和个人记忆。
身份可替换为公司 SSO/OIDC；未配置生产身份提供方时应用启动失败，不自动回退到演示登录。

| 依赖 / 调用方 | 本模块提供 | 约束 |
|---|---|---|
| M01/M02 | 当前用户、可用权限、会话失效信号 | 对话、记忆、收件箱按本人隔离 |
| M03/M05/M06 | 规则、Skill、知识访问范围 | 搜索结果也先按权限过滤，不能只隐藏执行按钮 |
| M07 | 分析部门范围、analytics.export 独立授权 | 汇总、下钻、下载逐次鉴权 |
| M08/M09/M10 | 用户部门、经理、成本中心、城市候选 | 所有关联使用 ID，不能从展示名推断审批人 |
| M11 | 当前审核人、动作权限、authz_version | 确认与执行前再校验；撤权立即使旧确认不可执行 |
| M13/M14 | 工具授权、内部执行上下文、scope 版本 | Worker 不持久缓存永久有效的用户授权 |
| M15 | 七名种子身份、generation、角色跳转 | 仅隔离 Demo 环境允许切换；业务字段不可跨环境混用 |

不做员工薪酬、人事档案、复杂组织历史图、真实账号密码管理或自动推断同名用户。
组织目录为本期演示提供有效部门、岗位关系和审批人；真实组织系统通过 DirectoryProvider 替换。

## 2. 编号功能与固定身份

| 编号 | 功能 | 验收输出 |
|---|---|---|
| IAM-01 | 演示登录和角色切换 | 新的后端签名 session，旧 session 失效 |
| IAM-02 | 可信身份上下文 | /me 返回服务端角色、范围与 authz_version |
| IAM-03 | 资源授权 | 同租户、本人 / 部门 / 当前任务范围检查 |
| IAM-04 | 撤权传播 | API、下载、SSE、Worker 后续调用拒绝旧授权 |
| IAM-05 | 目录查询 | 按姓名 / 部门查候选，显示可区分的组织信息 |
| IAM-06 | 成本中心与项目 | 用户可选有效成本中心和同组织项目 |
| IAM-07 | 城市和别名映射 | 多候选、父城市与映射来源结构化返回 |
| IAM-08 | grants 定义与校验 | 明确 capability 和 scope，拒绝隐含通配业务授权 |
| IAM-09 | 生产身份适配边界 | 未配置 / issuer 不符 / disabled user 均失败关闭 |

固定 seed 为七人，不能为方便测试增加第八个“全能管理员”；部门与角色严格跟随 02。

| ID | 名称 | 所属部门 | 角色 | 数据边界 |
|---|---|---|---|---|
| u-li | 李娜 | dept-sales | employee | 本人业务与个人空间 |
| u-wang | 王强 | dept-sales | employee | 本人业务与个人空间 |
| u-zhang | 张伟 | dept-sales | employee、manager | 本人 + 销售部当前审批及授权分析 |
| u-liu | 刘敏 | dept-finance | employee、finance | 本人 + 显式授予销售和技术的财务审核 / 分析 |
| u-zhao | 赵磊 | dept-it | platform_admin | 运行元数据、连接器与 Demo 控制 |
| u-chen | 陈杰 | dept-tech | employee | 本人业务与个人空间 |
| u-sun | 孙静 | dept-tech | employee、manager | 本人 + 技术部当前审批及授权分析 |

finance 用户本人的 department_id 是 dept-finance；她的业务可读部门是显式 grants，不可将两者混为一个字段。
张伟和孙静的 employee 角色不自动授予对方部门；平台 admin 角色不能隐含本人或部门业务读写权限。
公司规则 / 制度维护若授予刘敏，必须在 seed manifest 中列为独立 capability，不能从 finance 自动推断。
报表导出也为单独 grant；角色名称相同的用户可以拥有不同导出权限。

## 3. 页面、抽屉与身份旅程

### 3.1 演示身份页

`/auth/demo` 仅在 APP_MODE=demo 且 DemoAccessGate 已授权本隔离环境时存在。
提供七个人物卡片，显示姓名、部门、演示角色和简短范围；不能输入任意 tenant_id、roles 或 permissions。
点击人物后发后端登录请求，后端从种子身份表读取其有效状态和 grants，再设置签名 Cookie。
顶部始终显示“演示环境 / 当前身份”；切换是明确动作，不能由 Agent 为了读更多数据自行执行。
初次访问和切换后回到当前人物首页；业务深链接重新鉴权，不在切换页把旧正文继续留在屏幕上。

### 3.2 人员与主数据选择

人员选择器输入“李”只返回授权目录的简洁候选：姓名、部门、岗位；同名必须选 ID，不自动选第一项。
成本中心下拉只包含当前用户有权使用且在业务日期有效的中心；失效项显示原因并要求重选。
城市选择器展示“输入名称 → 标准城市 / 区县 / 父城市”的解释，不能把区县名称静默替换为城市。
“余杭”可返回区县余杭及标准城市杭州；用户看到“按所属城市杭州匹配差旅城市标准”的解释后采纳。
“朝阳”返回候选集合，标记 requires_selection=true；在未选择前不能写城市 ID 或提交行程。
主数据抽屉只用于选择与说明，不能变成能任意编辑公司目录的管理器。

### 3.3 权限查看与异常

`/settings/access` 展示当前用户的有效权限说明和可访问部门，不泄露其他人的业务内容。
拥有明确 identity.grant.manage 的已配置管理主体才可访问 grants 编辑端点；该权限不在七人默认 seed 中授予。
平台管理员可以看自己无业务读取权的说明，但不能通过这个页面给自己增加员工报销权限。
实际授权管理主体在部署阶段配置；本期 Demo 用受版本控制的 grant manifest 和 M15 受控撤权场景验证。

| 失败状态 | UI 与 API 行为 |
|---|---|
| 会话缺失 / 签名无效 / 已注销 | 401，清理界面缓存并回登录，不使用浏览器旧角色 |
| 访问不属于自己的单据 | 404，与不存在对象一致；不返回申请人、金额或部门 |
| 能读单据但无批准权限 | 403，保留允许读取部分，解释当前不能执行该动作 |
| 目录服务不可用 | 明确无法验证，不保存猜测的经理或成本中心 |
| 城市多候选 | 显示候选与父城市，等待选择；不把模型置信度当用户选择 |
| 组织 / 授权在运行中变化 | 提示权限已更新，取消后续未执行步骤并清缓存 |
| 生产无身份提供方 | 服务启动检查失败，健康状态不可就绪；无 Demo 按钮和路由 |

## 4. 数据模型、校验与状态

所有业务授权数据有 tenant_id；每次查询先约束租户，再应用 capability 和资源 scope。

| 表 / DTO | 字段 | 规则 |
|---|---|---|
| identities | id、external_subject、display_name、department_id、state、authz_version | state=active/disabled；external_subject 同租户唯一 |
| organizations | id、name、parent_id、manager_user_id、state | 无循环父关系；经理必须是同租户 active identity |
| authorization_groups | id、name、state、source、version | 同租户有效授权组；Demo 可静态 seed，禁止任意字符串当作组 |
| group_membership | group_id、user_id、valid_from、valid_to、version | 同租户有效成员唯一；变更递增受影响用户 authz_version |
| role_assignments | user_id、role、valid_from、valid_to | role 限公共四种；有效期不交叉重复 |
| grants | subject_id、capability、scope_type、scope_ids、effect、version | effect 采用 allow；默认拒绝，无匹配即无权限 |
| sessions | id、actor_id、authz_version、generation、expires_at、revoked_at、signature_key_id | 只存哈希令牌；使用真实服务器时间 |
| subscription_delegations | id、owner_id、subscription_id、allowed_capabilities、scope、state、generation | 用户显式启用订阅时建立；M02 暂停 / 删除时撤销，只读白名单 |
| cost_centers | id、name、department_id、valid_from、valid_to、state | id 唯一；用户和业务日期都要匹配 |
| projects | id、name、department_id、state | 不因项目名相似跨部门关联 |
| cities | id、standard_code、name、level、parent_city_id、state | 可校验行政层级；代码字段与展示名称分开 |
| place_aliases | id、alias、target_place_ids、source、mapping_version | 多候选保留集合，不覆盖为一个猜测结果 |
| authz_audit | actor_id、target_user_id、before/after_version、reason、trace_id | 不含发票正文或个人聊天内容 |

ActorContext 直接 import 01 对应的 packages/contracts/src/common.ts 完整类型，不在本模块复制精简版。
包含 tenant_id、user_id、roles、department_ids、permissions、authz_version、session_id:string|null、invocation_origin、delegation_id:string|null。
其中 department_ids 是本次有效授权范围的投影，不等于人的所属部门；各资源仍根据 scope 细分。
角色只是权限组合输入；employee 的本人单据权限不能被投影成所有所属部门单据可读。
权限名仅从 packages/contracts/src/permissions.ts 导入，严格复用 01，不建立同义枚举。

| 固定 capability | 资源 / 节点守卫 |
|---|---|
| travel.read.own、travel.write.own | 本人差旅，写入仍查合法状态 |
| expense.read.own、expense.write.own | 本人报销 / 票据，附件查父对象 |
| oa.read.own、oa.write.own | 本人招待申请和有权参与的站内通知 |
| travel.read.department、expense.read.department、oa.read.department | 显式部门范围，不从角色名放宽 |
| approval.decide | 当前 task.assigned_to、pending、stage 与资源范围均符合；经理 / 财务不另设权限名 |
| analytics.query、analytics.export | 查询与导出分别授权，附指标 / 维度范围 |
| rule.manage.personal、rule.manage.company、knowledge.manage | 本人规则或明确公司 / 制度维护范围 |
| skill.use、skill.manage | use/source_read/maintain/review/publish 授权分别检查 |
| integration.manage、operations.read、operations.manage、demo.control | 连接配置、运维读 / 管理、演示控制独立；不授业务正文读权 |
| identity.grant.manage | 部署配置的授权管理主体与可授予范围 |

### 4.1 scopes 的具体含义

| scope_type | scope_ids | 例子 / 判断 |
|---|---|---|
| self | 当前 subject 的 user_id | owner_id 必须等于 actor.user_id |
| department | 显式部门 ID 集合 | 张伟只有 dept-sales，孙静只有 dept-tech |
| assigned_task | 当前有效任务关系 | 刘敏可处理分配给她且在授权部门的财务任务 |
| named_resource | 明确业务资源或可共享文档 ID | 用于受控知识 / Skill 授权，不扩大到同部门全部资料 |
| operations | 受管理的连接器 / 环境 ID | 只返回脱敏运行元数据，不投影为业务读取权 |

M05 的 skill_grants.subject_type=user/group/tenant 由本目录验证；group 必须存在、active、同租户，执行时重新解析有效成员。
固定组 g-finance-demo={u-liu}、g-sales-managers={u-zhang}、g-tech-managers={u-sun}；只增加组记录，不增加七名用户数量。
组仅作为 Skill 授权主体集合，不自动扩大业务部门 / 审批范围；成员退出使旧 Skill 访问缓存失效。生产由 DirectoryProvider 替换静态组来源。
grants 变更以 expected_version CAS，并递增受影响用户 authz_version；无权限主体不能提交变更请求。
若将来开放授权编辑，交给 M11 的专用权限动作 handler 记录确认与审计；不复用普通业务批准权限。
禁止自助授予自己原本没有的业务范围；需由部署配置的授权管理主体在其管理边界内授予。

### 4.2 状态变化

identity active→disabled：撤销会话、增 authz_version、停止后续工具调用；历史业务 owner_id 保留。
用户切换：旧 session revoked→新 session active；不修改业务归属，不迁移旧 thread 的所有者。
grants 更新：新版本立即生效；缓存按 tenant/user/authz_version 分区，旧版本缓存不可继续读。
主数据 active→inactive：历史快照仍可解释；新保存 / 提交必须使用当日有效值，不能删除历史引用。
经理变更：未开始的业务提交采用最新经理；已存在 task 的指派变更必须走受控任务迁移，不随目录读取静默改审。
Demo reset 换 generation 后所有旧会话失效；浏览器需要重新选择当前 generation 的种子人物。

## 5. 会话、授权与生产适配

### 5.1 Cookie 与 CSRF

使用后端签名的不可预测 session token，Cookie 为 HttpOnly、Secure、SameSite=Lax、Path=/，推荐 `__Host-caixiaozhi_session`。
浏览器 JS 不读取会话令牌，不将角色凭证放 localStorage；开发也提供 HTTPS，避免靠关闭 Secure 模拟认证。
交互请求验证签名、session 存在、未撤销、真实过期时间、generation、identity active 后才生成 ActorContext；invocation_origin=interactive。
写请求使用与 session 绑定的 CSRF token，并校验 Origin；签名密钥仅在服务端，支持 key_id 轮换。
演示会话默认 8 小时有效，闲置 30 分钟后需重新选择；这些时间不受 M15 business clock 影响。
客户端 body/query 的 tenant_id、owner_id、user_id、roles、permissions 一律不作为身份依据；所有权由后端写入。

### 5.2 查询、附件、SSE 与 Worker

业务查询把授权谓词放入数据库访问层，不能先读全公司记录再在前端过滤。
附件、导出文件和引用解析先取其父对象并鉴权；短时下载链接应经鉴权代理或可撤销下载入口。
SSE 连接建立时鉴权，授权更新时主动断开；重连必须取当前会话，不能用旧 cursor 获取已失权 payload。
Worker 存 actor reference 和 authz_version，不保存永久有效授权快照；每次工具调用与有影响写入前重新解析。
切换身份不把原交互 run 改成新 actor；原交互 run 停止未执行步骤，在途写入按 M11 核实，结果只归原主体。
日程由有效 subscription_delegation 构造 invocation_origin=subscription、session_id=null 的 ActorContext，绑定 delegation_id。
执行范围取订阅白名单、授权时范围和用户当前 grants 的交集；每次读取 / 投递重验用户 active、订阅启用与 delegation 未撤销。
退出或切换浏览器不删除原用户有效订阅；停用用户、暂停订阅、撤销委托会阻止后续读取和投递，并关闭相应任务。
订阅身份不得获取 M11 confirmation_token、确认写入或调用审批 / 发布 / 发送动作；inbox 投递由 M02 受控内部服务完成。
平台管理员只能看 run/action 的脱敏状态、耗时、错误码；读原始 args、结果或提示词需要另行业务授权。

### 5.3 IdentityProvider 端口

```ts
interface IdentityProvider {
  authenticate(input: AuthCallbackInput): Promise<ExternalIdentity>;
  resolveSubject(subject: string, issuer: string): Promise<ExternalIdentity>;
}
interface DirectoryProvider {
  searchPeople(ctx: ActorContext, input: PeopleQuery): Promise<PersonCandidate[]>;
  resolveManager(ctx: ActorContext, departmentId: string): Promise<PersonRef>;
  listGroups(ctx: ActorContext, input: GroupQuery): Promise<AuthorizationGroupPage>;
  isGroupMember(ctx: ActorContext, groupId: string, userId: string): Promise<boolean>;
  resolvePlace(ctx: ActorContext, text: string): Promise<PlaceResolution>;
}
async function getActorFromSession(req: Request): Promise<ActorContext>;
async function getActorFromSubscription(delegationId: string): Promise<ActorContext>;
async function assertResourceAccess(ctx: ActorContext, operation: string, ref: ResourceRef): Promise<void>;
async function replaceGrants(ctx: ActorContext, input: GrantChange): Promise<AuthzChangeReceipt>;
async function switchDemoIdentity(gate: DemoAccess, input: SwitchDemoInput): Promise<SessionView>;
```

ProductionOidcProvider 预留 issuer、audience、授权端点、JWKS、redirect URI 与受控凭据配置。
接入时必须验证签名、issuer、audience、nonce/state、有效期和身份映射；不得只 base64 解码令牌即认为有效。
生产未实现 authenticate 或缺必要配置时 startup validation 失败，不能返回固定 ExternalIdentity。
APP_MODE=production 与 demo_auth_enabled/demo_faults_enabled 任一同时出现时失败启动；不是单纯隐藏菜单。

## 6. HTTP 样例与主数据契约

所有路径加 `/api/v1`；写操作带 Idempotency-Key 与需要的 expected_version，响应使用公共 envelope。

| 端点 | 输入 | 输出 |
|---|---|---|
| POST /auth/demo/login | demo_environment_id、generation、selected_user_id | Cookie + /me 投影；需 DemoAccessGate |
| POST /auth/demo/switch | selected_user_id、generation | 原会话撤销、新会话与缓存失效信号 |
| POST /auth/logout | 当前 CSRF | 撤销会话；重复注销幂等 |
| GET /me | 无 | 当前服务端身份、所属部门、有效范围、能力 |
| GET /directory/people | q、department_id、cursor、limit | 目录候选，不含财务记录 |
| GET /directory/departments | cursor、limit | 可见组织与经理引用 |
| GET /directory/groups | q、cursor、limit | 同租户可选 active 组的 id、name、version；用于 M05 授权选择，不含业务数据 |
| GET /master-data/cost-centers | business_date | 当前有效且可使用中心 |
| GET /master-data/projects | business_date | 当前可选项目 |
| GET /master-data/places/resolve | q | 候选、父城市、映射版本、是否需澄清 |
| GET /auth/grants/me | 无 | 本人有效 grant 解释 |
| PUT /auth/grants/:subjectId | expected_version、完整授权变更 | 需独立管理能力，默认 seed 拒绝 |

```json
{
  "data":{"input":"余杭","mapping_version":"city-map-v1","requires_selection":false,
    "candidates":[{"place_id":"district-yuhang","name":"余杭","level":"district",
      "parent_city":{"id":"city-hangzhou","name":"杭州","standard_code":"330100"},
      "reason":"行政区所属城市映射；差旅城市按杭州解释"}]},
  "meta":{"request_id":"req-place-1","trace_id":"trace-place-1","server_time":"2026-11-05T01:00:00Z","data_mode":"demo"}
}
```

候选 ID 以主数据接口返回为准；示例映射并不授权模型直接覆盖已有城市，M08 仍需 diff 采纳。
成本中心固定有 cc-sales、cc-tech、cc-finance；prj-market 属销售、prj-infra 属技术，均来源于 02。
“朝阳”候选须同时包含区县 / 城市层级、所属省市与标准城市关系；不足以唯一判定时不写默认值。

## 7. 建议代码与 Codex 分步实施

| 文件 | 责任 |
|---|---|
| packages/contracts/src/{identity,permissions,master-data}.ts | ActorContext、grant、目录与城市 schema |
| apps/api/src/modules/identity/{session,csrf,actor,authorizer}.ts | 签名会话、请求身份、资源守卫 |
| apps/api/src/modules/identity/{schema,grants,directory,master-data}.ts | 组织表与可替换查询服务 |
| apps/api/src/modules/identity/providers/{demo,oidc}.ts | 两种身份提供方及启动校验 |
| apps/web/src/features/identity/{DemoLogin,IdentitySwitcher,AccessView}.tsx | 明确角色选择与权限解释 |
| packages/fixtures/src/seed/identities.ts | 七人、部门、grants、成本中心与城市夹具 |
| tests/integration/authz-boundary.test.ts | 跨部门、附件、工具、导出、SSE 与撤权负例 |

1. 实现身份、会话、grants 和静态授权组 / 成员表，按 02 seed 七人四部门及本文三组；所有资源查询加入 tenant 条件。
2. 实现签名 Cookie、CSRF、注销和 /me；验证客户端伪造字段无效。
3. 用统一 authorizer 接业务读取、动作、下载、预审、分析与工具网关，不分散编写角色 if 判断。
4. 实现目录与城市候选，给 M08/M09/M10 联调成本中心、经理、余杭映射和朝阳澄清。
5. 接 authz_version 失效、SSE 断开、Worker 重新解析与 M11 确认拒绝。
6. 增加生产启动门槛与 OIDC 端口失败占位；生产认证配置完成前不启用真实业务入口。
7. 跑下面权限负例和 02 关键旅程，证据包含状态码、审计、缓存清理与后端无副作用检查。

## 8. GWT 验收

| 编号 | Given / When / Then |
|---|---|
| A12-01 | Given 李娜登录；When body 伪造 user_id=u-wang、roles=finance 创建单据；Then owner 仍为 u-li，非法字段被拒绝或忽略且不提升权限。 |
| A12-02 | Given 张伟仅销售范围；When 列表、详情、预审、附件请求 clm-006；Then 列表不包含，具体资源 404，不泄露陈杰信息。 |
| A12-03 | Given 孙静仅技术范围；When 请求 clm-001 的单据与财务图表；Then 无销售明细和金额，不能仅靠隐藏按钮处理。 |
| A12-04 | Given 赵磊 platform_admin；When 查询员工统计、个人记忆或发票正文；Then 拒绝，运行元数据仍可看。 |
| A12-05 | Given 刘敏明确两部门分析授权；When 查 11 月 completed；Then 1090000 分；移除技术范围后重查为 590000 分。 |
| A12-06 | Given 当前用户有只读分析无 analytics.export；When 下载报告；Then 403，前端已有链接不绕过下载鉴权。 |
| A12-07 | Given 张伟有旧确认和运行中任务；When 撤销其销售范围再执行；Then 确认拒绝，后续工具和 SSE 不继续返回正文。 |
| A12-08 | Given 李娜已打开会话；When 明确切王强；Then 旧 session 失效、缓存清理，新首页不显示李娜的对话或记忆。 |
| A12-09 | Given Cookie 签名改一位或 session 已注销；When 请求 /me；Then 401，不接受浏览器缓存的 actor。 |
| A12-10 | Given 成本中心 cc-tech；When 李娜用于销售差旅；Then 保存 / 提交校验拒绝，不自动替换为名称相近中心。 |
| A12-11 | Given 输入朝阳；When 城市解析；Then 返回多候选 requires_selection=true，未选不能提交；余杭映射显示父城市杭州说明。 |
| A12-12 | Given production 且未配置 OIDC；When 启动；Then readiness 失败且无演示认证路由；不能签发模拟用户 Cookie。 |
| A12-13 | Given demo 业务时钟被回拨；When 已过期会话请求 API；Then 仍按真实时间过期，不能恢复会话有效性。 |
| A12-14 | Given 赵磊无 identity.grant.manage；When 调用 grants 修改给自己加业务权；Then 403，权限版本和业务可读范围均不变。 |
| A12-15 | Given 张伟已启用有效订阅后退出浏览器；When 到期调度；Then session_id=null 且合法 delegation 的只读任务可运行；不能获取确认令牌或审批。 |
| A12-16 | Given 离线订阅正在取数；When 撤销授权 / 暂停订阅；Then 后续读取与投递停止，不能沿用旧 scope。 |
| A12-17 | Given Skill 指定 g-finance-demo；When 刘敏与张伟分别查询 / 使用；Then 仅刘敏匹配该组授权；张伟不因 manager 角色加入财务组。 |
| A12-18 | Given 不存在或跨租户 groupId；When 建立 Skill grant；Then 字段校验拒绝；移出有效组后旧缓存不能继续使用。 |
