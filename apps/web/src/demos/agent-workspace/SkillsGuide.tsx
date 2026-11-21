import { useState } from 'react';
import { Button } from './ui';
import { useToolCatalog, setToolPersona, TOOL_PERSONAS } from './tool-catalog';

const sampleCsv =
  'data:text/csv;charset=utf-8,' +
  encodeURIComponent(
    '\uFEFF费用类型,金额\r\n交通,36.50\r\n餐饮,48.00\r\n交通,-6.50\r\n',
  );

interface GuideProps {
  onClose?: () => void;
  toolPanel?: { kind: string | null; toolId?: string };
}

export function SkillsGuide({ area, ...props }: GuideProps & { area: 'skills' | 'light-apps' }) {
  if (area === 'light-apps') return <LightAppsGuide {...props} />;
  return <>
    <section className="help-section">
      <h3>会话技能</h3>
      <p>从技能目录查看输入和可用状态。选择“在对话中使用”会将技能加入当前草稿，发送任务后开始执行。</p>
    </section>
    <section className="help-section">
      <h3>专家团与连接器</h3>
      <p>在专家团详情中查看成员分工、技能和数据来源。选择“召唤专家团”后，在会话里说明任务并发送。也可以从基础专家团选择所需技能，创建自己的专家团。</p>
    </section>
    <section className="help-section">
      <h3>技能管理</h3>
      <p>在技能页选择“上传技能”，上传指令文件或包含 SKILL.md 的 ZIP 包。检查文件后可保存草稿或提交审核。在“我创建的”中可继续编辑自己的技能。发布后，具备权限的用户可在会话中调用。</p>
    </section>
  </>;
}

function LightAppsGuide({ onClose, toolPanel }: GuideProps) {
  const { identity, loading, error: catalogError } = useToolCatalog();
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);
  const query = new URLSearchParams(location.hash.split('?')[1] || '');
  const toolId = query.get('tool') || '';
  const action = query.get('action') || 'tool';
  const editing =
    action === 'upload' || action === 'edit' || toolPanel?.kind === 'upload';
  const builtin =
    ['reconcile', 'convert', 'report'].includes(toolId) && action === 'tool';
  function sample(
    action: 'load-sample' | 'upload-sample' | 'download-upload-sample',
  ) {
    onClose?.();
    window.dispatchEvent(
      new CustomEvent('caixiaozhi-tool-guide-action', {
        detail: { action, toolId },
      }),
    );
  }
  async function switchPersona(id: string) {
    setError('');
    setSwitching(true);
    try {
      await setToolPersona(id);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : '切换失败，请重试。',
      );
    } finally {
      setSwitching(false);
    }
  }
  return (
    <>
      <section className="help-section">
        <h3>查找和使用</h3>
        <ol>
          <li>按名称、用途、业务分类或收藏查找轻应用。</li>
          <li>从目录选择“打开应用”，可在新窗口核对材料和参数并运行。</li>
        </ol>
        <p>点击名称可查看详情。收藏只用于快速查找，不会授予权限或自动执行。</p>
      </section>
      <section className="help-section">
        <h3>示例文件与操作</h3>
        <a
          className="guide-download"
          href={sampleCsv}
          download="费用汇总示例.csv"
        >
          下载费用汇总示例 CSV
        </a>
        {builtin && (
          <div className="guide-actions">
            <Button onClick={() => sample('load-sample')}>
              载入当前工具示例
            </Button>
          </div>
        )}
        {editing && (
          <div className="guide-actions">
            <Button onClick={() => sample('upload-sample')}>
              使用示例 HTML 文件
            </Button>
            <Button onClick={() => sample('download-upload-sample')}>
              下载示例 HTML 文件
            </Button>
          </div>
        )}
        <p>
          {builtin
            ? '载入示例只准备输入文件；确认后再运行。示例数据会保留来源标识。'
            : editing
              ? '使用示例会替换本次工具文件，已填写的业务字段保留。'
              : '两表核对、台账模板转换和费用分析报告打开后，可从本指引载入示例；上传工具时可使用或下载示例 HTML。'}
        </p>
      </section>
      <section className="help-section">
        <h3>创建、审核与版本</h3>
        <ol>
          <li>
            在轻应用目录选择“上传轻应用”，上传 HTML 文件。文件检查后可保存草稿或提交审核。自己的应用可在“我创建的”中维护。
          </li>
          <li>
            退回后查看原因并创建修订版本。新版本审核期间，目录继续使用原有发布版本。
          </li>
          <li>
            在“审核发布”处理审核与发布。使用指引下方可切换轻应用的示例身份。
          </li>
        </ol>
        <p>
          上传的 HTML 轻应用在隔离区域预览。
        </p>
      </section>
      <section className="help-section">
        <h3>执行与保存范围</h3>
        <ul>
          <li>
            费用汇总使用本地服务，页面和对话共用执行结果，可从汇总历史重新打开与下载。
          </li>
          <li>
            两表核对、台账模板转换和费用分析报告在浏览器内处理；活动记录不等于可恢复的结果，离开或刷新前请下载需要的结果。
          </li>
          <li>
            费用分析报告当前生成基础汇总，没有连接 AI 解读。上传 HTML
            工具保留自身功能，外部资源访问受限。
          </li>
        </ul>
      </section>
      <section className="help-section">
        <h3>工具演示身份</h3>
        <p>
          以下身份只影响浏览器工具的查看、使用和审核，不改变主应用账号或正式服务授权。
        </p>
        <label className="guide-field">
          当前演示身份
          <select
            aria-label="工具演示身份"
            value={identity?.id || 'finance'}
            disabled={loading || switching || editing}
            onChange={(event) => void switchPersona(event.target.value)}
          >
            {TOOL_PERSONAS.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name} · {person.label}
              </option>
            ))}
          </select>
        </label>
        {editing && <p>请先保存或关闭工具编辑，再切换演示身份。</p>}
        <p>
          林晓创建工具；周敏、陈屿分别审核业务与技术；许宁发布、调整范围和处理访问申请；王晨查看普通员工权限。
        </p>
        {(error || catalogError) && (
          <p className="guide-error" role="alert">
            {error || catalogError}
          </p>
        )}
      </section>
    </>
  );
}
