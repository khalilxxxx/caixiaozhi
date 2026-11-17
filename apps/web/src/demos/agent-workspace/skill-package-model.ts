export interface SkillInspection {
  packageId: string;
  name: string;
  description: string;
  instructions: string;
  files: { path: string; size: number; kind: string }[];
  scripts: string[];
  references: string[];
  requirements: unknown;
  missingDependencies: string[];
  status: 'ready' | 'blocked';
  warnings: string[];
}

export interface SkillFile {
  id?: string;
  name: string;
  size: number;
  type: string;
  text?: string;
  sha256?: string;
  inspection?: SkillInspection;
  inspectionError?: string;
}

export function skillExecutionBlock(file?: SkillFile): string | null {
  if (!file) return null;
  if (file.inspectionError) return '包检查未完成，请重新检查；当前仅支持存储。';
  if (file.inspection) {
    if (
      file.inspection.missingDependencies.length &&
      file.inspection.scripts.length
    )
      return `缺少依赖：${file.inspection.missingDependencies.join('、')}。当前仅支持存储。`;
    if (file.inspection.status !== 'ready')
      return '包检查未通过，当前仅支持存储。';
    if (!file.inspection.instructions.trim())
      return '未读取到技能指令，当前仅支持存储。';
    return null;
  }
  if (/\.zip$/i.test(file.name) || !file.text?.trim())
    return '未读取到可执行技能指令，请检查文件；当前仅支持存储。';
  return null;
}

export function inspectedSkillDraft<
  T extends { name: string; description: string; file: SkillFile | null },
>(
  draft: T,
  file: SkillFile,
  inspection: SkillInspection,
): Omit<T, 'file'> & { file: SkillFile } {
  return {
    ...draft,
    name: draft.name.trim() ? draft.name : inspection.name || '',
    description: draft.description.trim()
      ? draft.description
      : inspection.description || '',
    file: {
      ...file,
      text: inspection.instructions,
      inspection,
      inspectionError: undefined,
    },
  };
}
