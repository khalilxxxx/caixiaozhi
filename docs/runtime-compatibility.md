# 运行环境兼容记录

记录日期为 2026-11-07，范围为 T01。

## 实际使用版本

| 项目 | 版本与依据 |
|---|---|
| 应用 Node.js | v22.16.0，node --version 与 pnpm exec node --version 实测 |
| pnpm | 11.25.0，packageManager 与安装输出 |
| pnpm 启动器内部 Node | v24.22.1，桌面环境自带 pnpm 包装器，应用脚本 PATH 仍使用 v22.16.0 |
| TypeScript | 5.9.3 |
| React / react-dom | 19.3.1 |
| Vite | 7.3.7 |
| @vitejs/plugin-react | 5.2.0，peerDependencies 支持 Vite 7 |
| Fastify | 5.12.8 |
| Zod | 4.6.7 |
| Drizzle ORM | 0.45.4 |
| pg / @types/pg | 8.23.1 |
| @aws-sdk/client-s3 | 3.1164.0 |
| dotenv | 18.0.9 |
| pino | 10.4.0 |
| Vitest | 3.2.7 |
| tsx | 4.23.15 |
| Prettier | 3.9.10 |
| concurrently | 10.0.6 |
| PostgreSQL | 17.6，原生服务 postgres --version 实测 |
| RustFS | 1.0.4，原生服务 --version 实测 |

依赖版本经 npm registry 查询并实际安装，顶层版本均精确固定，全部传递依赖见 pnpm-lock.yaml。Compose 的 PostgreSQL、RustFS、AWS CLI 镜像固定 tag 与多架构 manifest digest，镜像元数据已在线查询，本机缺 Docker，容器启动与 Linux 行为待补验。

## 本机原生服务验证路径

PostgreSQL 使用 `@embedded-postgres/darwin-arm64@17.6.0-beta.15` 携带的真实 PostgreSQL 17.6 二进制。beta 属于分发包版本。执行分发包的 hydrate-symlinks.js 后可加载配套动态库。数据在项目 `.runtime/pg-data`。

RustFS 使用 GitHub 1.0.4 release 的 macOS arm64 构建，下载 ZIP 的 SHA256 为 `49057482769d7904ef95dc40457d71122f48cbb8e9e0725a0817a3ec6daf8270`，与发布的 SHA256SUMS 一致。

该 RustFS 原生构建从中文可执行路径启动时出现路径解码 panic，使用 `/tmp/caixiaozhi-t01-tools/rustfs` 的 ASCII 路径后运行成功。此限制属于本机原生运行路径，Compose 使用固定 Linux 路径。本次临时对象数据也位于 `/tmp/caixiaozhi-t01-tools/data`，后续重建或清理临时目录前应自行备份。

本机端口为 PostgreSQL 55432、S3 59000、API 3000、Web 5173。标准 Compose 默认 PostgreSQL 5432、S3 9000。服务端读取同一 `.env` 配置，密钥未写入本文件。

## dsh 兼容性

状态为待 T03 验证。本轮未安装 dsh SDK，后续需在真实模型环境锁定 SDK/运行时/profile 版本，验证中文、流式、受控工具、持久化续接、取消与运行目录隔离。兼容性结论以届时实测方法和限制为准。

## 数据库执行时限

本轮连接池使用 query_timeout=3000ms、statement_timeout=2500ms，真实慢查询约2.53秒取消且连接可继续查询。该限制也作用于T01迁移，后续长迁移需增加独立且有界的配置。

## 后续阶段更新（2026-11-07）

后续真实 dsh SDK 核验要求 Node>=24.9，应用现统一固定24.22.1，并通过pnpm的devEngines.runtime分发；上方22.16记录保留为T01历史。已安装官方SDK 0.2.2-rc.1；实际dsh确定性传输、tool往返、安全暂停和关闭记录见runtime-dsh.md。@opentelemetry/api固定1.9.0以满足该版SDK传递依赖的peer范围，`pnpm peers check`实际无问题。Playwright Test固定1.65.0，本机Chrome已验证Secure loopback Cookie、真实会话、身份切换和抽屉恢复。真实模型配置缺失不代表SDK传输已替代模型验收。
