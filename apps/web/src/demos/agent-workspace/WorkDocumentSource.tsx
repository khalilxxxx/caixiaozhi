import { useEffect, useState } from 'react';
import { api } from './runtime-client';
import { ApprovalNodeCard } from './ApprovalNodeCard';
import { WorkDocumentDetails } from './WorkDocumentDetails';
import { workDocumentTitle, type WorkDocument } from './work-document-model';
import { Button, Icon } from './ui';
import type { ProgressDossierRecord } from './progress-dossier';
import './work-document-source.css';

type WorkSource = {
  document: WorkDocument;
  dataSource: string;
  progressDocument?: ProgressDossierRecord;
};

async function loadWorkSource(
  id: string,
  key?: string | null,
  system?: string | null,
) {
  let progressDocument: ProgressDossierRecord | undefined;
  if (key !== null && key !== undefined) {
    const result = await api<{
      items: ProgressDossierRecord[];
      unavailableSources: string[];
    }>('/business/documents', { documentIds: [key] });
    if (system && result.unavailableSources.includes(system))
      throw new Error('来源系统暂未返回结果，请稍后重试。');
    progressDocument = result.items.find(
      (item) =>
        item.key === key &&
        key === `work/${item.typeId}/${id}` &&
        item.id === id &&
        item.workDocumentId === id &&
        item.source.id === system,
    );
    if (!progressDocument) {
      throw new Error('未找到这张单据。');
    }
  }
  const result = await api<WorkSource>(
    '/business/work-documents/' + encodeURIComponent(id),
  );
  if (
    result.document.id !== id ||
    (system && result.document.system !== system)
  )
    throw new Error('未找到这张单据。');
  return { ...result, progressDocument };
}

export function WorkDocumentSource({
  id,
  progressKey,
  sourceSystem,
}: {
  id: string;
  progressKey?: string | null;
  sourceSystem?: string | null;
}) {
  const [source, setSource] = useState<WorkSource | null>(null);
  const record = source?.document;
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setSource(null);
    setError('');
    document.title = '业务单据';
    loadWorkSource(id, progressKey, sourceSystem)
      .then((result) => {
        if (!active) return;
        setSource(result);
        document.title = workDocumentTitle(result.document) + ' · 业务单据';
      })
      .catch((reason: Error) => {
        if (active) setError(reason.message);
      });
    return () => {
      active = false;
    };
  }, [id, attempt, progressKey, sourceSystem]);

  return (
    <main className="work-source-page">
      <header className="work-source-bar">
        <span className="work-source-system">
          <Icon name="file" />
          {record?.sourceLabel ||
            (record?.system === 'oa' ? 'OA 系统' : '业务单据')}
        </span>
        {source && <span>{source.dataSource}</span>}
      </header>
      {record ? (
        <article className="work-source-paper">
          <header className="work-source-heading">
            <h1>{workDocumentTitle(record)}</h1>
            <small>{record.id}</small>
          </header>
          {source.progressDocument && (
            <ApprovalNodeCard document={source.progressDocument} />
          )}
          <WorkDocumentDetails
            document={record}
            view={source.progressDocument ? 'progress-source' : 'source'}
            progressDocument={source.progressDocument}
          />
        </article>
      ) : (
        <section className="work-source-paper" aria-live="polite">
          {error ? (
            <>
              <p>{error}</p>
              <Button onClick={() => setAttempt((value) => value + 1)}>
                重新加载
              </Button>
            </>
          ) : (
            '正在读取单据…'
          )}
        </section>
      )}
    </main>
  );
}
