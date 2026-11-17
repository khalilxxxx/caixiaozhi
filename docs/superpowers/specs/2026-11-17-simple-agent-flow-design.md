# 简化报销流程与费用汇总工具

用户已明确授权：去掉查验，采用“提取→核对→填单→提交”；由实施方选择一个简单小工具；不引入 Agno 高级能力。沿用本地单用户 FastAPI、Agno Agent、SQLite 和现有界面。

## 实施选择

保留原有金额、必填项、重复附件与人工确认，移除发票有效性查验规则、生成能力、相关入口与阻断。已有数据库做幂等迁移，历史回执不改写。材料先按已有可读文本格式提取费用字段，保存待核对条目；原件无可解析文字时显示真实原因，不生成样例识别结果。暂不新增 OCR。

小工具选择 CSV 费用汇总，比两表核对更少输入、比自由报告更容易验收。服务端用整数分计算合计和类别小计，页面和 Agent 调用同一实现，结果持久化且能下载。界面沿用“技能·工具→小工具”，新增原生小工具入口，既有工具保留。

## 接口契约与职责

- `material_service.extract_materials(store, file_ids)`：异步，读取上传文本并用结构化 Agent 提取，保存 `materials.items`，返回 `{items, files, cards}`，卡片 kind=`materials`。重复提取不得覆盖已核对条目；未知金额/日期等必须要求人工补齐。
- `POST /api/local/materials/extract`：`{fileIds: string[]}`；返回上述结果和最新 `workspace`。
- `expense_summary.summarize_csv(store, file_id)`：同步，真实读取CSV原件/文本、校验金额，保存 `data.toolResults`，返回 `{result, cards}`；卡片 kind=`tool`、id为结果ID。
- `GET /api/local/tools/results`、`GET /api/local/tools/results/{id}`、`GET /api/local/tools/results/{id}/download`：历史、单项、CSV下载。
- `POST /api/local/tools/expense-summary`：`{fileId}`，返回结果和workspace。
- Agent 新增提取材料、费用汇总、读取汇总结果工具，模型无提交能力。

## 验收

新上传可读材料提取后逐项核对，转入右侧报销抽屉，经基础校验和用户确认取得本地回执；不依赖发票查验。简单CSV从界面及对话均可汇总，金额一致，刷新与重启结果保留；无效金额明确报错。既有提交幂等、重复票据保护与历史快照继续有效。
