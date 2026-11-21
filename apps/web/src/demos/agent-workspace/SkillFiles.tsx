import type { SkillFile } from './skill-package-model';
import { Icon } from './ui';

const fileTypes: Record<string, string> = {
  instructions: '技能说明',
  reference: '参考资料',
  script: '脚本',
  asset: '资源',
  file: '文件',
};

function sizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function SkillFiles({
  file,
  instructions,
}: {
  file: SkillFile;
  instructions: string;
}) {
  const entries = file.inspection?.files ?? [];
  return (
    <div className="sd-files">
      <h3>上传文件</h3>
      <div className="sd-source-file">
        <Icon name="folder" size={22} />
        <strong>{file.name}</strong>
        <span>{sizeLabel(file.size)}</span>
      </div>
      {entries.length > 0 ? (
        <>
          <h3>
            文件清单 <small>{entries.length}</small>
          </h3>
          <ul className="sd-file-list">
            {entries.map((entry) => {
              const preview =
                entry.kind === 'instructions' && instructions.trim();
              const fields = (
                <>
                  <Icon
                    name={entry.kind === 'instructions' ? 'book' : 'file'}
                    size={17}
                  />
                  <span className="sd-file-name">
                    <strong>{entry.path}</strong>
                    <small>{fileTypes[entry.kind] ?? '文件'}</small>
                  </span>
                  <span className="sd-file-size">{sizeLabel(entry.size)}</span>
                </>
              );
              return (
                <li key={entry.path}>
                  {preview ? (
                    <details className="sd-file-preview">
                      <summary>
                        {fields}
                        <Icon name="down" size={15} />
                      </summary>
                      <pre aria-label="技能说明原文">{instructions}</pre>
                    </details>
                  ) : (
                    <div className="sd-file-row">{fields}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        /\.zip$/i.test(file.name) && <p>此版本暂无包内文件清单。</p>
      )}
    </div>
  );
}
