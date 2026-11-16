# 输入框技能选择调整

目标：依据用户补充，将技能选择反馈放回底部工具入口，附件与业务引用仍在输入材料区；保持 PC 对话优先。

依据：Claude 官方 Research 文档明确底部状态标识；WorkBuddy 桌面新建任务栏文档明确非默认模式在输入框下方显示。两者支持入口与状态相邻，但不证明所有竞品的技能选择都采用相同方式。本轮为财小智的设计判断。

方案：底部“选择技能”打开可搜索的小浮层；即时多选，单项显示技能名，多项显示数量。原位置可清除，浮层中可逐项取消。保留技能权限与版本限制，不改自动调用策略。快捷功能继续追加需求，不作为持久模式。

- [x] Skills.tsx 新增 ComposerSkillPicker，复用技能数据和权限，兼容历史已选技能。
- [x] Chat.tsx 拆分附件与技能展示，统一浮层关闭/焦点处理；App.tsx 提供当前草稿引用更新。
- [x] styles.css 与 DESIGN.md 同步底部选中状态和浮层。
- [x] 验证多选/取消/搜索/键盘/草稿保留，1440与1280桌面宽度、类型与构建。

备份：artifacts/composer-selection-20261116/before/。低风险呈现调整不新增镜像实现单测；使用实际 UI 操作验证，并运行现有单测。

验证结果：TypeScript通过、Vite构建通过、17个测试文件146项通过。UI已确认单选名称、多选数量、原位清除、文字不丢失、搜索无结果、未发布/仅存储禁用、菜单互斥和Escape回焦点。历史会话添加技能后经全部对话恢复仍保留选择，未生成新会话。1280×800和1440×900无横向溢出，笔记本技能浮层底部630px，保持在视口内。独立只读复核未发现实质P1/P2。

截图：artifacts/composer-selection-20261116/home-desktop.jpg、skills-desktop.jpg、skills-laptop.jpg。验证后清除测试选择，首页保留为空白新会话。

官方参考：https://support.claude.com/en/articles/11088861-use-research-on-claude；https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Task-Bar。
