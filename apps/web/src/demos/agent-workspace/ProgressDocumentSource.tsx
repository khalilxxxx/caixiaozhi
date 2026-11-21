import { useEffect, useState } from 'react';
import { documentKey } from '../document-query/document-model';
import { ApprovalNodeCard } from './ApprovalNodeCard';
import { WorkDocumentDetails } from './WorkDocumentDetails';
import {
  progressDossier,
  type ProgressDossierRecord,
} from './progress-dossier';
import { readWorkspace } from './runtime-client';
import { Button, Icon } from './ui';
import type { WorkDocumentContent } from './work-document-model';
import './work-document-source.css';

type SourcePageRecord = {
  document: ProgressDossierRecord;
  dossier: WorkDocumentContent;
};

async function loadSource(key: string): Promise<SourcePageRecord> {
  const { state } = await readWorkspace();
  const record = (
    state.data.documents as ProgressDossierRecord[] | undefined
  )?.find((item) => item.key === key && documentKey(item) === key);
  if (!record) throw new Error('未找到这张单据。');
  const status = state.data.documentSources?.states?.[record.source.id];
  if (status && status !== 'ready')
    throw new Error(record.source.label + '暂未返回结果，请稍后重试。');
  return {
    document: record,
    dossier: progressDossier(record, state.data, 'source'),
  };
}

export function ProgressDocumentSource({ recordKey }: { recordKey: string }) {
  const [source, setSource] = useState<SourcePageRecord | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setSource(null);
    setError('');
    document.title = '业务单据';
    loadSource(recordKey)
      .then((result) => {
        if (!active) return;
        setSource(result);
        document.title = result.document.title + ' · 业务单据';
      })
      .catch((reason: Error) => {
        if (active) setError(reason.message);
      });
    return () => {
      active = false;
    };
  }, [recordKey, attempt]);
  const record = source?.document;
  const origin =
    record?.details.find((field) => field.label === '数据来源')?.value ||
    (record?.synthetic ? '本地样例' : '');
  return (
    <main className="work-source-page">
      <header className="work-source-bar">
        <span className="work-source-system">
          <Icon name="file" />
          {record?.source.label ?? '业务单据'}
        </span>
        {origin && <span>{origin}</span>}
      </header>
      {source && record ? (
        <article className="work-source-paper">
          <header className="work-source-heading">
            <h1>{record.title}</h1>
          </header>
          <ApprovalNodeCard document={record} />
          <WorkDocumentDetails
            document={source.dossier}
            view="progress-source"
            progressDocument={record}
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
