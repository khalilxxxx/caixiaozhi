# 本机通用技能运行环境实施计划

目标：按用户授权，利用本机环境完善当前财小智 Demo，实现技能文本/ZIP 导入、完整资源读取、Python/Node/脚本执行、会话材料输入、生成文件预览与下载。保持现有财务、翻译和材料流程。当前交付仍为本机单用户版本，不宣称生产多用户隔离。

方案：采用可替换的本地受限执行器；本机 macOS 使用 sandbox-exec，禁止网络及访问任务外私人文件，清理继承环境。依赖预装并锁定，不运行上传包的安装命令。技能加载遵循 SKILL.md 与 references/scripts/assets 目录；不直接启用 Agno 的宿主裸脚本执行器。会话选中已发布技能后开放渐进读取和通用执行工具。没有执行隔离能力时明确拒绝运行，保留资料读取。

原工作区已有未提交业务改动，需要用于当前运行；原位增量修改，先备份至 artifacts/general-skills-20261117/before，不覆盖已有改动。

## 分工与接口

- [x] 技能包：新增 skill_packages.py 与 tests/test_skill_packages.py。`SkillPackageService(store, data_dir).inspect(file_id) -> dict` 返回 packageId/name/description/instructions/files[{path,size,kind}]/scripts/references/requirements/missingDependencies/status；`root(file_id) -> Path`；`read(file_id,path) -> dict`。ZIP 防穿越、链接、嵌套炸弹/配额，支持单层外目录；依赖仅检查不安装。原件存储保持共用 files 接口。
- [x] 执行器：新增 skill_executor.py、skill_process.py 与 tests/test_skill_executor.py。`LocalSkillExecutor().environment() -> dict`；`async execute(workspace:Path, script:str,args:list[str],timeout:int=60) -> dict`，相对路径，workspace 内 skills/input 只读，work/output 可写；支持 py/js/mjs/sh，超时/取消终止进程组，输出截断、限额、环境清洗。不依赖 package/store。
- [x] 界面：修改 Skills.tsx、analytics-skills.css；新增 SkillArtifactPanel.tsx 与样式。上传后调用 POST /skills/inspect {fileId}，使用返回 inspection.instructions 及 metadata，显示实际兼容检查及文件列表；继续人工审核发布。成果抽屉 GET /artifacts/{id}，下载 /artifacts/{id}/download，预览 /artifacts/{id}/preview；结果卡 kind=artifact，保留使用指引默认关闭。
- [x] 主线程集成：新增 skill_workspace.py、skill_artifacts.py、skill_routes.py，修改 server.py、agent_runtime.py、file_service.py、App.tsx、Chat.tsx。技能工具：读取指令/资源、查看工作文件、写入 work/output、运行脚本、发布 output 成果；实际文件绑定当前 task/run，输入只复制本次引用材料；前轮成果仅从同会话恢复。生成文件登记独立 SQLite 表，客户端不可覆盖；HTML 预览隔离，PPT/Word 转 PDF、图片预览，其他文件可下载。执行活动写入现有 SSE，技能运行预算独立扩展。
- [x] 本机依赖与样例：为服务安装锁定 python-pptx/openpyxl/reportlab/Pillow 等文档库，复用本机 LibreOffice。提供两个可上传的普通技能 ZIP，用真实模型分别完成 PPT 与表格/文本成果，不将技能内容写死进执行器。
- [x] 验证与复核：先运行缺失功能的失败测试，再实现。覆盖 ZIP 越界/符号链接、缺依赖、工作区越界、密钥与网络不可访问、真实子进程/超时/取消、成果越界与预览、重启持久化。执行 Agno 后端全套、前端相关单测、类型检查、构建；真实浏览器完成上传审核选择、执行、预览下载及窄屏检查；独立代码复核后修正并更新交付记录。

## 重点边界

用户代码不得读取项目 .env、其他任务或用户主目录；同一会话每轮生成独立目录。仅限制工作目录、venv 或普通进程不能作为隔离证明。脚本输出不伪造成功；非零退出、缺依赖、渲染失败需显示真实反馈。未知平台不降级为裸执行。现有数据不重置、模型密钥不输出。
