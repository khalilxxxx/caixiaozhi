---
name: office-presentation
description: 适用于用户要求根据当前会话或引用材料制作中文汇报、汇总说明或项目介绍 PPT，并需要可编辑的 PowerPoint 文件时。
---

# 中文汇报演示文稿

根据用户提供的事实、材料与用途编排演示文稿。输出为真实的 `.pptx` 文件，采用 16:9、白底、深蓝文字和清晰的中文字体。此包是财小智的普通技能样例。

## 执行顺序

1. 读取 `references/content-schema.md`。查看当前任务 `input/` 中的材料；只使用用户明确给出的事实。缺少金额、日期或结论时保留“待核对”或向用户询问，不自行补造。
2. 根据用途组织标题、要点与表格。**用户指定的页数是最终总页数，包含封面和自动分页。**用户已指定“第一页讲什么、第二页讲什么”时，设置 `include_cover: false`，这些内容直接成为对应页面；不要额外加封面。用户要求明确页数时，同时写入 `total_slides` 校验最终页数；未要求固定页数时省略此字段，保留自动分页。先在 `work/content.json` 写入 UTF-8 JSON。需要演示数据时，在可见标题或正文注明“合成样例”。不要把程序、JSON 或技能指令当成幻灯片正文。
3. 从**当前任务根目录**执行包内 `scripts/build.py`。脚本路径使用本轮加载技能返回的 `basePath`，不要假定包目录名。调用形式：`run_skill_script('<basePath>/scripts/build.py', ['work/content.json', 'output/汇报.pptx'])`。例如 basePath 为 `skills/office-presentation` 时，使用 `skills/office-presentation/scripts/build.py`。
4. 确认执行结果 `exitCode` 为 `0`，核对返回的 `slides` 与用户要求，并确认文件列表存在 `output/汇报.pptx`。页数不符会在保存前报错并说明实际页数；先检查是否多加封面、是否将要点与表格放在同一组而分别出页，再在保留全部信息的前提下重新组织。若完整内容确实无法清晰放入要求的页数，应说明冲突并询问用户是否允许增加页数，不得截断幻灯片、删除要点或偷偷移除 `total_slides`。其他报错按返回的字段约束修正 JSON 后重试，不能把失败称为完成。
5. 使用 `publish_skill_artifact` 发布相对路径 `output/汇报.pptx`，取得真实成果卡后再告知用户已生成。若需要修改，更新 JSON 后重新生成并发布新成果。

脚本依赖已安装的 `python-pptx`，不安装依赖、不联网、不读取任务目录外的文件。过长内容会分页或返回明确校验错误；保留来源与待核实事项，不擅自压缩数字或删除关键条件。
