import { describe, expect, it } from 'vitest';
import {
  skillExecutionBlock,
  inspectedSkillDraft,
  type SkillInspection,
} from '../../apps/web/src/demos/agent-workspace/skill-package-model';

const inspection: SkillInspection = {
  packageId: 'package-1',
  name: '月报生成',
  description: '根据费用表生成月报。',
  instructions: '读取 input 中的费用表，将月报保存到 output。',
  files: [{ path: 'SKILL.md', size: 120, kind: 'instructions' }],
  scripts: ['scripts/report.py'],
  references: [],
  requirements: ['python-pptx'],
  missingDependencies: [],
  status: 'ready',
  warnings: [],
};
const file = {
  id: 'file-1',
  name: 'report.zip',
  size: 220,
  type: 'application/zip',
};

describe('技能包检查与版本草稿', () => {
  it('仅说明资源包的依赖警告不阻止使用已通过检查的指令', () => {
    expect(
      skillExecutionBlock({
        ...file,
        inspection: {
          ...inspection,
          scripts: [],
          missingDependencies: ['optional-office-helper'],
          warnings: ['当前技能仅含说明和资源，可继续读取。'],
        },
      }),
    ).toBeNull();
  });

  it('缺依赖或检查阻断时不允许标记为可执行，已有纯文本继续兼容', () => {
    expect(skillExecutionBlock({ ...file, inspection })).toBeNull();
    expect(
      skillExecutionBlock({
        ...file,
        inspection: { ...inspection, missingDependencies: ['python-pptx'] },
      }),
    ).toBeTruthy();
    expect(
      skillExecutionBlock({
        ...file,
        inspection: { ...inspection, status: 'blocked' },
      }),
    ).toBeTruthy();
    expect(skillExecutionBlock(file)).toBeTruthy();
    expect(
      skillExecutionBlock({ ...file, name: 'SKILL.md', text: '生成摘要。' }),
    ).toBeNull();
    expect(
      skillExecutionBlock({
        ...file,
        text: '生成摘要。',
        inspectionError: '检查未完成',
      }),
    ).toBeTruthy();
    expect(skillExecutionBlock(undefined)).toBeNull();
  });

  it('上传包使用实际指令补齐空字段，但保留用户填写的名称与用途', () => {
    const draft = inspectedSkillDraft(
      { name: ' ', description: '', file: null },
      file,
      inspection,
    );
    expect(draft.name).toBe('月报生成');
    expect(draft.description).toBe('根据费用表生成月报。');
    expect(draft.file?.text).toBe(
      '读取 input 中的费用表，将月报保存到 output。',
    );
    expect(draft.file?.inspection?.packageId).toBe('package-1');
    const edited = inspectedSkillDraft(
      { name: '我的月报', description: '内部核对', file: null },
      file,
      inspection,
    );
    expect(edited.name).toBe('我的月报');
    expect(edited.description).toBe('内部核对');
  });
});
