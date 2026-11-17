# 输入格式

脚本支持 UTF-8 或 GB18030 编码 CSV，以及 UTF-8 JSON。

CSV 第一行必须是非空、无重复的列名，每行列数一致。自动识别纯数值列；带前导零的编号保留为文本。若列是账号、编号等标识符，请优先用 JSON 明确指定 `text`。

JSON 格式如下；示例仅说明结构，不提供真实业务数据：

```json
{
  "title": "用户指定的报表名称",
  "source": "来源：用户提供材料",
  "columns": [
    {"key": "category", "label": "分类", "type": "text"},
    {"key": "amount", "label": "金额", "type": "number"},
    {"key": "reference", "label": "原始编号", "type": "text"}
  ],
  "rows": [
    {"category": "合成样例", "amount": "12.50", "reference": "0012"}
  ],
  "summary": {"groupBy": "category", "valueKey": "amount"}
}
```

- `columns` 支持 1 至 30 列，key 和 label 分别唯一；类型仅为 `text` 或 `number`。
- `rows` 支持 1 至 10000 行，按 columns 的 key 读取；不要在输入中遗失用户要求的列。
- 缺失数值使用 `null` 或空字符串，保留为空单元格。非有限数值和无法解析的数字会报错，不会静默改成零。
- `summary` 可省略。存在时 groupBy/valueKey 必须是实际列，valueKey 必须是 number；脚本按有值行使用 Decimal 汇总后写入“汇总”工作表。数值缺失时显示缺失行数；整个分组都缺失时合计保留空白。最多 20 个分组时绘制柱状图。没有币种或单位时不自行补造。
- 日期、账号和长编号使用 text；输出保留为文本，不转换成公式。
- 文件只能生成到 `output/`，脚本使用任务根目录作为当前目录。

生成成功时输出 JSON，包含文件名、明细行数、工作表名称和字节数。零退出码与实际文件存在是发布成果前的必要检查。
