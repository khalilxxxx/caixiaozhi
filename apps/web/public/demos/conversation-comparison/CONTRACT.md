# 三版交互预览实现接口

这是独立、明确标识的本地交互预览，不接真实 Agent，不修改正式应用。用户最新要求先看三版再选。A 专业有温度、B 陪伴感更明显、C 极简高效。

每版导出 `export const css = '...'; export function renderAssistant(view, ui) { return 'HTML'; }`。分别保存到 variant-a.js / variant-b.js / variant-c.js。全部选择器以 `.variant-a` / `.variant-b` / `.variant-c` 为范围。主程序将类名放在产品容器上。返回 HTML 是用户消息下面的助手区域；建议助手头像身份、运行/等待状态、业务进度、完成回答。三版需有明显的交互结构差别。

`view` 字段：
- `phase`: thinking / working / waiting / checking / responding / completed / failed / stopped
- `title` 当前动作中文、`detail` 业务细节中文、`elapsed` 已用秒数
- `steps`: `{ id, label, detail, status }[]`；status 为 pending / running / completed / failed。提供四步：读取费用、核对制度、比较月份、整理报告。
- `recordOpen`: 工作记录展开状态
- `answer`: 用户选项或空字符串
- `copied`: 复制完成布尔值

`ui` 方法：
- `icon(name, size=16)`: SVG，name 支持 spark/check/clock/down/chevron/stop/alert/file/search/chart/arrow/copy/refresh/plus/close/up/book/chat/pause/play。
- `escape(text)`: HTML转义
- `mascot(className='')`: 已有蓝白小智 img
- `records(view)`: 完整可展开工作记录（summary 按钮 data-action="records"），样式与行为由主程序处理。可不用此方法自行绘制，但须让收起/展开依赖 view.recordOpen。
- `result(view)`: 已完成或 responding 的业务结果正文与可点报告卡，其他阶段返回空字符串。
- `questionNotice(view)`: waiting 时返回定位到底部问题的轻提示，其余空字符串。

可使用 `data-action="records" / "focus-question" / "resume" / "retry" / "report" / "copy"`，主程序事件委托。停止与失败需要恢复入口。不要添加没有实现的按钮。不自行注册计时器或事件监听。所有动态内容可用 escape。视图会定时重新渲染，展开状态由 view 管理。

共享CSS提供 `.assistant-identity`, `.assistant-avatar`, `.assistant-body`, `.phase-indicator`, `.muted`, `.text-action`, `.assistant-result`, `.result-card`, `.records`, `.record-toggle`, `.step-list`, `.step-row`, `.step-dot`, `.step-copy`, `.step-meta`。每版可覆盖，专属类应加 a-/b-/c- 前缀。css 内动效尊重 prefers-reduced-motion，页面隐藏由 body[data-motion=paused] 统一暂停。

中性灰白 #fafaf9，正文 #29292d，副文字 #66666b，珊瑚操作 #dc4043，小智仍蓝白。无阴影叠卡、无彩色渐变文字、无可爱玩笑、无技术内部日志。正文14px以上，状态12-13px；页面头部无解释副标题。
