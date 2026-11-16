# 财小智

当前产品入口为 [本地 Agno Demo](http://127.0.0.1:5190/agent.html#home)，使用真实 Agno 智能体、工具调用、持久化会话和本地模拟业务接口。

```sh
pnpm demo:agent
```

启动、模型配置、完整流程、数据边界和验收记录见 [Agno 本地 Demo 运行与验收](docs/Agno本地Demo运行与验收.md)。本入口无需启动下面的旧工程基础服务。

## 原工程（5173）

财小智是使用 dsh 的 B/S 财务个人助理。当前仓库包含 React 工作空间、Fastify API、持久 Worker，以及身份授权、单据、文件、确认与回执、制度规则、预审、分析、Skill、记忆订阅和演示控制的实现。各阶段的实现、实测结果及未交付项见 [后续阶段总验收](docs/后续阶段总验收.md)。未配置真实模型时，Agent 明确报告依赖不可用；演示业务页面仍可独立操作。

原始设计 ZIP 和 `docs/caixiaozhi-v1` 保留原样。`docs/T01-验收报告.md` 是第一阶段的历史记录，不能代替后续总装验收。设计优先级为公共契约、模块领域规则、联调夹具、实施步骤。

## 环境与依赖

- Node.js **24.22.1**；真实 dsh SDK 要求至少 24.9。根 `devEngines.runtime` 和 `.node-version` 已固定，使用 `pnpm exec node --version` 确认应用运行时。
- pnpm **11.25.0**，使用已有 `pnpm-lock.yaml` 安装。
- PostgreSQL **17.6**、RustFS **1.0.4**；Compose 镜像固定版本及 digest。
- TypeScript 5.9.3、React 19.3.1、Vite 7.3.7、Fastify 5.12.8、Drizzle 0.45.4、Zod 4.6.7。
- 官方 `@deepseek-ai/dsh-sdk-client` **0.2.2-rc.1**；受控 profile 为 `finance-sdk-v1`。实际兼容记录见 `docs/runtime-dsh.md`。

## 配置与启动

在项目根目录执行，保留已有 `.env`：

```sh
pnpm install --frozen-lockfile
cp -n .env.example .env
```

编辑 `.env`，设置 PostgreSQL、S3 私有桶连接信息，以及至少 32 字符的稳定 `SESSION_SECRET`。可用 `pnpm exec node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 在本机生成秘密。不要把输出提交进仓库。

本地演示需要 `APP_MODE=demo`、`DEMO_ACCESS_ENABLED=true`。默认 `APP_ORIGIN=http://127.0.0.1:5173`、`COOKIE_SECURE=true`；当前 Chrome 已实测支持 loopback 上的 Secure Cookie。远程部署必须使用 HTTPS。不要将服务端秘密放入 `VITE_` 变量。

```sh
docker compose --env-file .env -f infra/compose.yaml up -d
docker compose --env-file .env -f infra/compose.yaml ps -a
docker compose --env-file .env -f infra/compose.yaml logs storage-init
pnpm db:migrate
pnpm db:seed
pnpm dev
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。`pnpm dev` 同时启动 Web、API 和 Worker；Vite 代理 `/api` 到本机 API。`/status` 显示真实数据库与文件存储状态。API/Worker 修改源代码后重启该命令，Web 支持热更新。

`db:seed` 首次初始化完整合成基准，并验证 7 个身份、11 张报销单、销售待审 5 张/554000 分、销售本月完成 590000 分等断言；已有完整环境时幂等返回，不覆盖用户的演示操作。`docs/demo-invoices` 提供 4 个明确标注合成的上传样例，重复样例与交通样例字节一致；OCR 按真实 SHA256 匹配夹具，未知文件只能明确失败或由本人手录。

`pnpm db:reset` 通过正式演示屏障重建下一代基准。它先停止新业务，检查未知结果，建立独立租户并验证后原子切换入口；保留旧代数据和审计，旧会话失效。仍有 unknown 写入时返回阻塞，不能删除账本绕过。也可由有 `demo.control` 授权的身份在控制台明确确认重建。

按 Ctrl+C 停止应用。保留基础服务数据时使用：

```sh
docker compose --env-file .env -f infra/compose.yaml stop
```

不要使用 `down -v` 清空卷。编译后可分别运行 `pnpm --filter @caixiaozhi/api start` 和 `pnpm --filter @caixiaozhi/worker start`；Web 的生产静态托管需同时配置 HTTPS 与同源 API 反向代理，不能把开发代理当作生产网关。

## dsh 与模型

仅真实 Agent/结构化生成/Skill 模型验证需要以下配置：

```dotenv
DSH_API_KEY=自行填写
DSH_BASE_URL=https://你的兼容模型网关/v1
DSH_MODEL=实际可用的模型标识
DSH_CONTEXT_WINDOW=实际模型上下文上限
DSH_API_PROTOCOL=openai-completions
```

协议另支持该版已核验的 `openai-responses` 和 `anthropic-messages`。这些是受控 dsh 网关配置，不是允许模型自行更换 URL 或凭据的工具参数。T03 的实际 SDK 启动、测试传输、工具往返和安全暂停已有确定性验证；真实模型语义、内网网关及成本验收须由 `pnpm test:agent:real` 实际调用完成。缺配置时命令非零退出，不能据此宣称真实 Agent 已验收。

共享模型槽把对话 run、结构化生成与 Skill 验证一并计入每用户 2 / 每租户 20 的上限，租约丢失后停止发布结果。此上限是实现的准入规则，实际硬件吞吐须另行实测。

规则中心可独立于模型进行声明式编辑、金额边界验证和人工专用样例验证。复杂条件的人工样例需自行填写完整合成输入和独立预期，绑定当前草稿后经持久队列产生证明；失败证明不能发布。规则停用和字段映射发布均需本人通过统一确认。内置 Demo 来源的映射只能保留规范财务含义；其他来源标为 `sample_only`，需接入正式业务适配器后另行验收。详情见 [M03 治理补齐记录](docs/M03-治理补齐记录.md)。

## 命令

| 命令 | 当前执行内容 |
|---|---|
| `pnpm dev` | 启动 Web、API、Worker；无模型配置也能启动 |
| `pnpm build` | 构建全部共享包与三个应用 |
| `pnpm db:migrate` | 按校验和串行应用 SQL，重复执行安全；已应用 SQL 不可原地修改 |
| `pnpm db:seed` | 合成演示初始化及完整性核验；production 拒绝 |
| `pnpm db:reset` | 带代际屏障、未知回执检查的演示重建；production 拒绝 |
| `pnpm typecheck` | 共享包、应用、测试和浏览器测试的严格 TypeScript 检查 |
| `pnpm test:unit` | 确定性业务/配置/规则/事件单元测试 |
| `pnpm test:contracts` | 公共协议及能力目录正反例 |
| `pnpm test:integration` | 真实 PostgreSQL/S3、动作/授权/租约/恢复/预审等集成测试 |
| `pnpm test:e2e` | 本机 Chrome 的真实页面/会话/HTTP/Worker 测试；自动启动应用 |
| `pnpm test:agent:real` | 强制检查模型配置，先真实 dsh 工具往返，再跑八条正式API旅程；未配置非零退出 |
| `pnpm test:load` | 独立测试租户的真实 20 run / 100 SSE 容量验收；缺模型配置非零退出 |
| `pnpm test:load:http` | 对已启动服务实测 HTTP+数据库/S3 就绪探测，写出负载记录 |

集成测试需要迁移后的专用本地数据库和私有 S3。最终集成回归时先停止常驻 Worker；测试使用真实队列，避免其他进程在断言前抢占同名任务。部分用例已经用注入的真实队列命名空间隔离。

浏览器测试使用本机已安装的 Google Chrome；没有 Chrome 时可安装 Playwright Chromium 并相应调整 `playwright.config.ts` 的 channel。截图、trace 和 HTML 报告在被忽略的 `test-results` / `playwright-report`。

`test:load:http` 默认 20 并发、200 次真实就绪请求，可用 `LOAD_BASE_URL`、`LOAD_CONCURRENCY`、`LOAD_REQUESTS` 调整；它不代表 Agent 容量。

`test:load` 在独立测试租户建立至少十个只读身份，以真实 dsh、20 并发 Worker 和 100 条 SSE 测量共同活跃峰值、排队、HTTP/模型限流、CPU 与内存。默认要求联合目标持续至少 1 秒；真实模型过快、限流或超时而未达到目标会如实非零退出。`LOAD_TIMEOUT_MS`、`LOAD_RUNS`、`LOAD_USERS`、`LOAD_SSE` 和 `LOAD_MIN_JOINT_MS` 可调整有界参数；不会重建默认演示环境。报告位于 `docs/verification/agent-capacity-latest.json`，未配置模型返回 blocked/退出码2且不会启动工作负载。

重复执行含样例票据的浏览器测试前，先通过 `pnpm db:reset` 恢复合成基准；同一票据再次被业务确认时，真实重复校验会拒绝。八条正式旅程各自也会受控重建下一代，旧数据与审计保留。请在专用演示环境运行这些测试。

## 数据与权限边界

金额保存为 CNY 整数分字符串，使用 BigInt 计算。审计、租约和确认有效期使用真实 UTC；演示业务日期与订阅计划另取业务时钟，默认 Asia/Shanghai，回拨不会延长租约或确认期限。

浏览器只持有 HttpOnly 签名会话和 CSRF 校验值；ActorContext 由服务端读取。角色不等同于数据授权，平台管理员没有业务正文或财务私有 Skill 源码的默认权限。文件只有鉴权代理可读，私有桶不提供匿名业务上传/下载。身份切换、撤权和重置会使旧运行、流与缓存失效。

所有提交、批准、发布和消息发送都经过统一确认与逐项回执。unknown 只查询原结果，不重发原写入。制度是检索证据，规则是声明式 AST，记忆不能代替审核规则；任何模型结果都不能自动确认业务动作。

## 本机验证环境与常见故障

本次机器没有 Docker，实际基础服务使用原生 PostgreSQL 17.6 和 RustFS 1.0.4，端口分别为 55432 / 59000。仅本机已有工具可执行 `pnpm exec tsx --conditions=development scripts/dev-services-native.ts` 恢复服务；下载文件位于被忽略的 `.runtime` 与 `/tmp/caixiaozhi-t01-tools`。跨机器请使用 Compose 标准步骤，容器实际启动仍需在有 Docker 的机器补验。

- 页面显示依赖未就绪：检查服务端口、私有桶初始化和 `pnpm db:migrate`；存活检查通过不代表依赖就绪。
- 登录入口未启用：检查 APP_MODE、DEMO_ACCESS_ENABLED、当前环境 seed 和 APP_ORIGIN。
- 修改 `.env` 后：重启 API/Worker；不要用 `source .env` 执行配置文本。
- 端口占用：停止此前的 `pnpm dev`，或同步修改 API_PORT 与代理目标。
- 对象存储 403：核对服务端账户、私有桶及 S3_REGION；匿名访问被拒绝是预期结果。
- 迁移校验和不一致：恢复已应用 SQL，新增下一号迁移；不要删除迁移账本。
- 模型任务失败/Skill blocked：检查真实模型配置、网络及该能力的真实验证记录；blocked 不会被当成 published。
- production 模式拒绝 demo 登录、seed、reset。外部 SSO、真实 OA/票据提供方与部署秘密须通过相应受信端口配置，未接入保持失败关闭。
