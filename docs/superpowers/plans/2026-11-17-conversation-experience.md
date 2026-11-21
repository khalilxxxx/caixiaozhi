# 财小智对话过程优化实施计划

目标：将现有 Agent 对话优化为轻量、可读且真实反馈的交互。

架构：延用 React、既有运行事件与工作区状态，不新增依赖。直接在当前工作区做限定文件改动，保留正在进行的其他功能。

设计依据：`docs/superpowers/specs/2026-11-17-conversation-experience-design.md`。

最新用户要求：先交付三版独立交互预览供选择。下方正式实施任务暂不执行，本轮仅创建 `apps/web/public/demos/conversation-comparison/`，验证播放、选择、停止与恢复及桌面/窄屏。原正式应用文件未改动。

## 实施

- [ ] 更新 `RunProgress.tsx` / `run-progress.css`：真实当前动作、并行计数、计时、工作记录层次与运行指示；保护终态和历史记录。补充已有 `agent-run-progress-ui.spec.ts` 的关键状态测试。
- [ ] 更新 `Chat.tsx` 并新增限定对话的样式文件：消息节奏、输入运行态、复制就地反馈、流式正文与助手身份。保留所有业务入口和草稿行为。
- [ ] 类型检查、构建及相关单元回归；浏览器检查桌面、窄屏、键盘、真实运行与完成折叠。独立审查改动并修正实际问题。

## 检查重点

终态不能被成功的工具步骤覆盖；没有时间戳不虚构总耗时；历史重试仍保留；输入草稿不因运行/停止丢失；长文本不压缩主要操作；未接入能力不装成完成。

## 验证命令

`node node_modules/typescript/bin/tsc -p apps/web/tsconfig.agent.json --noEmit`

`node apps/web/node_modules/vite/bin/vite.js build --config apps/web/vite.agent.config.ts`

`node node_modules/vitest/vitest.mjs run tests/unit/agent-run-progress.spec.ts tests/unit/agent-run-progress-ui.spec.ts tests/unit/agent-runtime-client.spec.ts`
