"""Progressive skill access over the local execution boundary."""
from __future__ import annotations

from functools import partial

from skill_workspace import SkillWorkspace

BUSINESS_INPUT_TOOLS = frozenset({
    'query_documents', 'analyze_expenses', 'search_policies', 'get_submission_draft',
    'validate_submission', 'preaudit_documents', 'list_materials', 'read_uploaded_file',
    'extract_expense_materials', 'summarize_expense_csv', 'read_expense_summary',
    'get_submission_receipt', 'read_current_rules',
})


def callable_version(skill, version):
    return bool(skill.get('view', True) and skill.get('call') and version
                and version.get('status') == 'published' and version.get('mode') == 'runnable'
                and all(version.get(key) == 'pass' for key in ('business', 'security', 'technical', 'compatibility')))


class SkillToolset:
    def __init__(self, store, data_dir, run, sync_call, async_call):
        self.store = store
        self.job = SkillWorkspace(store, data_dir, run['task_id'], run['id'], run['request'].get('refs', []))
        self.sync_call, self.async_call = sync_call, async_call
        self.loaded = set()
        self.executable = False

    def capture_result(self, name, result):
        """Backend-only capture: the model cannot supply or relabel source data."""
        if name not in BUSINESS_INPUT_TOOLS or not isinstance(result, dict) or result.get('error') or result.get('status') in {'failed', 'cancelled'}:
            return None
        return self.job.capture_business_result(name, result)

    def catalog(self):
        result = []
        for skill in self.store.get_state()['data'].get('skillsHub', {}).get('skills', []):
            versions = [v['version'] for v in skill.get('versions', []) if callable_version(skill, v)]
            if versions:
                result.append({'id': skill['id'], 'title': skill['title'], 'description': skill.get('description', ''), 'versions': versions})
        return {'skills': result}

    def activate(self, skill_id, version=None):
        skill = next((s for s in self.store.get_state()['data'].get('skillsHub', {}).get('skills', []) if s['id'] == skill_id), None)
        selected = next((v for v in (skill or {}).get('versions', []) if (v['version'] == version if version else callable_version(skill, v))), None)
        if not skill or not callable_version(skill, selected):
            raise ValueError('技能版本暂不可调用，请选择已上架且审核通过的版本。')
        info = self.job.add_package(skill, selected)
        if len(info['instructions']) > 24000:
            info['instructions'] = info['instructions'][:24000]
            info['instructionsTruncated'] = True
            info['instructionPath'] = info.get('basePath', '') + '/SKILL.md'
        if len(info.get('files', [])) > 100:
            info['files'] = info['files'][:100]
            info['fileListTruncated'] = True
        self.loaded.add(skill_id)
        self.executable = self.executable or bool(selected.get('file', {}).get('id'))
        from skill_executor import LocalSkillExecutor
        info['environment'] = LocalSkillExecutor().environment()
        return info

    def require_loaded(self):
        if not self.executable:
            raise ValueError('请先加载已发布的上传技能，再使用工作文件或执行脚本。')

    def guarded(self, fn, *args):
        self.require_loaded()
        return fn(*args)

    async def get_skill_instructions(self, skill_id: str, version: str | None = None) -> dict:
        """加载已发布技能的准确版本、完整业务指令、资源目录和本机运行能力。执行或创建文件前必须加载；技能名称不能当作函数调用。"""
        return self.sync_call('get_skill_instructions', '加载技能', self.activate, skill_id, version)

    async def list_skill_files(self) -> dict:
        """列出当前任务的输入文件、技能资源、工作文件、输出文件，以及当前会话历史成果。路径均相对于任务目录。"""
        return self.sync_call('list_skill_files', '查看工作文件', partial(self.guarded, self.job.files))

    async def read_skill_file(self, path: str, offset: int = 0) -> dict:
        """读取技能参考资料、脚本或任务文本文件；每次最多24000字符，truncated时用nextOffset继续。二进制文档用脚本和文档库读取。"""
        return self.sync_call('read_skill_file', '读取技能文件', partial(self.guarded, self.job.read), path, offset)

    async def write_skill_file(self, path: str, content: str) -> dict:
        """在work/保存脚本或数据，在output/保存文本成果。不能改input/或skills/。脚本可使用本机已安装文档库，文件路径相对于当前任务目录。"""
        # Runtime hashes arguments for retry identity; safe traces omit bodies.
        return self.sync_call('write_skill_file', '保存工作文件', partial(self.guarded, self.job.write), path, content)

    async def run_skill_script(self, path: str, args: list[str] | None = None, timeout: int = 60) -> dict:
        """在无网络的受限任务环境执行Python、Node或Shell脚本，读取input/与技能资源并将成果写入output/。path为技能scripts目录或work下的脚本；args是命令行参数数组。查看exitCode和stderr，失败须修复后重跑；退出成功也要发布真实成果。"""
        self.require_loaded()
        return await self.async_call('run_skill_script', '执行技能脚本', self.job.execute, path, args, timeout)

    async def publish_skill_artifact(self, path: str) -> dict:
        """发布output/真实成果，检验文件结构并返回不可变下载卡。金额表先调用validate_skill_artifact；结构通过不代表业务与版面验收。没有发布不得宣称可下载。"""
        return self.sync_call('publish_skill_artifact', '保存生成文件', partial(self.guarded, self.job.publish), path)

    async def validate_skill_artifact(self, path: str, snapshot_path: str, amount_column: str,
                                      amount_unit: str = 'yuan', sheet: str | None = None) -> dict:
        """核对CSV/XLSX明细金额列之和与业务快照totalMinor。snapshot_path来自list_skill_files的businessInputs，禁止转抄数据；amount_column是首行唯一列名，amount_unit为yuan元或fen分，多表XLSX须指定sheet。只接受完整明细列，不接受公式、合计行或空金额；结果只证明合计一致，不证明逐笔业务或版面正确。"""
        return self.sync_call('validate_skill_artifact', '核对成果金额', partial(self.guarded,
            self.job.validate_artifact), path, snapshot_path, amount_column, amount_unit, sheet)

    async def import_skill_artifact(self, artifact_id: str) -> dict:
        """将当前会话历史成果复制为本轮只读输入，用于继续修改。只能导入list_skill_files返回的当前会话成果。"""
        return self.sync_call('import_skill_artifact', '读取历史成果', partial(self.guarded, self.job.import_artifact), artifact_id)

    def tools(self):
        return [self.get_skill_instructions, self.list_skill_files, self.read_skill_file, self.write_skill_file,
                self.run_skill_script, self.validate_skill_artifact, self.publish_skill_artifact, self.import_skill_artifact]
