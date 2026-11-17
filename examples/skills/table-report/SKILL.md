---
name: table-report
description: 适用于用户要求将当前材料中的明细整理为 Excel、将 CSV 转成工作簿，或对明确字段进行分组汇总并提供可下载表格时。
---

# 明细与汇总工作簿

将用户输入整理成真实 `.xlsx` 文件。保留标识符、来源、空值和负数；仅按用户明确选择的字段汇总。此包是财小智的普通技能样例。

## 执行顺序

1. 读取 `references/content-schema.md`，查看本任务 `input/` 的实际文件。简单 CSV 转工作簿可直接把引用的 CSV 作为脚本输入；需要指定列类型、列名或汇总时，先写 `work/content.json`。
2. 在 JSON 中准确列出用户给出的行数据。编号、账号、日期、备注使用 `text`；需要运算的数值才使用 `number`。缺失金额保留空值，不能补为零；只有用户明确指定分组与金额字段时才增加 `summary`。
3. 从**当前任务根目录**执行脚本，脚本路径使用加载技能返回的 `basePath`：`run_skill_script('<basePath>/scripts/build.py', ['work/content.json', 'output/明细汇总.xlsx'])`。例如 basePath 为 `skills/table-report` 时，使用 `skills/table-report/scripts/build.py`。直接 CSV 输入时，将第一项参数换成文件列表中的实际 `input/` 路径。
4. 确认 `exitCode` 为 `0`，检查输出文件与实际记录行数。错误时保留原数据，根据错误定位字段后修正并重试。
5. 调用 `publish_skill_artifact` 发布 `output/明细汇总.xlsx`。取得真实成果卡后说明生成的工作表及计算范围，不把没有数据支持的业务原因写成事实。

依赖已安装的 `openpyxl`。不安装依赖、不联网、不读取任务目录外文件。字符串按文本写入，用户单元格中的公式样式内容不会被当作 Excel 公式执行。精度要求超出普通 Excel 数值能力的编号或金额应保留为文本并提示用户核对。
