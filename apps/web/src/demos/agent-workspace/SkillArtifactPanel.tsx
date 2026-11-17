import { useEffect, useState } from 'react';
import { api, ApiError } from './runtime-client';
import type { PanelSpec } from './workspace';
import { Badge, Button, Icon } from './ui';
import './skill-artifacts.css';

interface SkillArtifact {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  taskId: string;
  runId: string;
  createdAt: string;
  previewKind: 'pdf' | 'image' | 'text' | 'html' | 'none';
  previewStatus?: string;
  text?: string;
  warnings?: string[];
}

export function SkillArtifactContent({
  kind,
  name,
  source,
  text,
  onError,
}: {
  kind: SkillArtifact['previewKind'];
  name: string;
  source?: string;
  text?: string;
  onError?: () => void;
}) {
  if (kind === 'text')
    return <pre className="skill-artifact-text">{text ?? ''}</pre>;
  if (!source) return null;
  if (kind === 'image')
    return (
      <img
        className="skill-artifact-image"
        src={source}
        alt={name}
        onError={onError}
      />
    );
  if (kind === 'html')
    return (
      <iframe
        className="skill-artifact-frame"
        src={source}
        title={`${name}预览`}
        sandbox=""
        referrerPolicy="no-referrer"
        onError={onError}
      />
    );
  if (kind === 'pdf')
    return (
      <iframe
        className="skill-artifact-frame"
        src={source}
        title={`${name}预览`}
        referrerPolicy="no-referrer"
        onError={onError}
      />
    );
  return null;
}

function ArtifactPreview({
  artifact,
  onRefresh,
}: {
  artifact: SkillArtifact;
  onRefresh: () => void;
}) {
  const [source, setSource] = useState('');
  const [previewText, setPreviewText] = useState(artifact.text);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (
      artifact.previewKind === 'none' ||
      (artifact.previewKind === 'text' && artifact.text !== undefined)
    )
      return;
    const controller = new AbortController();
    let active = true;
    let blobUrl = '';
    setLoading(true);
    setError('');
    setSource('');
    const url = `/api/local/artifacts/${encodeURIComponent(artifact.id)}/preview`;
    void (async () => {
      try {
        const response = await fetch(url, {
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('preview');
        if (artifact.previewKind === 'text') {
          const text = await response.text();
          if (active) setPreviewText(text);
        } else if (artifact.previewKind === 'html') {
          // Keep the server's CSP on the iframe response; a blob would discard it.
          await response.body?.cancel();
          if (active) setSource(url);
        } else {
          const blob = await response.blob();
          if (!active) return;
          blobUrl = URL.createObjectURL(blob);
          setSource(blobUrl);
        }
      } catch {
        if (active) setError('预览加载失败，仍可下载原文件。');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      controller.abort();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [artifact.id, artifact.previewKind, artifact.text, attempt]);

  if (artifact.previewKind === 'none')
    return (
      <div className="skill-artifact-empty">
        <Icon name="file" size={30} />
        <strong>
          {artifact.previewStatus === 'failed'
            ? '预览生成失败'
            : '此格式暂不支持预览'}
        </strong>
        <p>可下载原文件查看。</p>
        {artifact.previewStatus === 'failed' && (
          <Button onClick={onRefresh}>重新加载</Button>
        )}
      </div>
    );
  if (
    loading ||
    (!source &&
      !error &&
      (artifact.previewKind !== 'text' || previewText === undefined))
  )
    return (
      <div className="skill-artifact-empty" role="status">
        <Icon name="file" size={28} />
        <p>正在准备预览…</p>
      </div>
    );
  if (error)
    return (
      <div className="skill-artifact-empty" role="alert">
        <Icon name="file" size={28} />
        <p>{error}</p>
        <Button onClick={() => setAttempt((n) => n + 1)}>重新加载预览</Button>
      </div>
    );
  return (
    <SkillArtifactContent
      kind={artifact.previewKind}
      name={artifact.name}
      source={source}
      text={previewText}
      onError={() => setError('预览显示失败，仍可下载原文件。')}
    />
  );
}

export function SkillArtifactPanel({ panel }: { panel: PanelSpec }) {
  const id = String(panel.id || panel.data?.artifactId || '');
  const [artifact, setArtifact] = useState<SkillArtifact | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setArtifact(null);
    setError('');
    setLoading(true);
    if (!id) {
      setError('未找到成果编号，请从会话中的成果卡重新打开。');
      setLoading(false);
      return;
    }
    void api<{ artifact: SkillArtifact }>(
      `/artifacts/${encodeURIComponent(id)}`,
    )
      .then((result) => {
        if (active) setArtifact(result.artifact);
      })
      .catch((reason: unknown) => {
        if (active)
          setError(
            reason instanceof ApiError && reason.status === 404
              ? '成果不存在或已不可用，请返回会话重新生成。'
              : '无法读取成果，请检查服务后重试。',
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id, attempt]);

  if (loading)
    return (
      <div className="skill-artifact-panel skill-artifact-empty" role="status">
        <Icon name="file" size={30} />
        <p>正在读取成果…</p>
      </div>
    );
  if (error || !artifact)
    return (
      <div className="skill-artifact-panel skill-artifact-empty" role="alert">
        <p>{error || '成果暂不可用，请重试。'}</p>
        <Button onClick={() => setAttempt((n) => n + 1)}>重试</Button>
      </div>
    );
  const name = artifact.name.split(/[\\/]/).pop() || '生成文件';
  const size =
    artifact.size < 1024
      ? `${artifact.size} B`
      : artifact.size < 1024 * 1024
        ? `${(artifact.size / 1024).toFixed(1)} KB`
        : `${(artifact.size / 1024 / 1024).toFixed(1)} MB`;
  const created = new Date(artifact.createdAt);
  return (
    <div className="skill-artifact-panel">
      <div className="skill-artifact-toolbar">
        <div className="skill-artifact-file">
          <Icon name="file" size={22} />
          <div>
            <strong>{name}</strong>
            <span>
              {size}
              {!Number.isNaN(created.getTime()) && (
                <>
                  {' '}
                  ·{' '}
                  {created.toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                    hour12: false,
                  })}
                </>
              )}
            </span>
          </div>
        </div>
        <a
          className="btn primary"
          href={`/api/local/artifacts/${encodeURIComponent(id)}/download`}
          download={name}
        >
          <Icon name="download" size={16} />
          <span>下载文件</span>
        </a>
      </div>
      {artifact.warnings?.length ? (
        <div className="skill-artifact-warnings" role="status">
          <Badge tone="warning">需注意</Badge>
          <ul>
            {artifact.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="skill-artifact-preview">
        <ArtifactPreview
          key={`${id}:${attempt}`}
          artifact={{ ...artifact, name }}
          onRefresh={() => setAttempt((n) => n + 1)}
        />
      </div>
    </div>
  );
}
