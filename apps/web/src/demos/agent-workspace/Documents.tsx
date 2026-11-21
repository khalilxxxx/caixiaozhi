import { businessTime } from './time-format';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { documents as sourceDocuments } from '../document-query/fixtures';
import {
  type GenericDocument,
  type DocumentStatus,
} from '../document-query/document-model';
import { useSlice, useWorkspace, type PanelSpec } from './workspace';
import { Badge, Button, Empty, Field, Icon, Money, Section } from './ui';
import {
  buildMaterialExpenseBatch,
  materialBatchId,
  materialCategoryQuestion,
  materialExpenseCategory,
  materialExpenseError,
  materialSelectionId,
  selectMaterialScope,
  type MaterialExpense,
  type MaterialFile,
} from './material-import.js';
import './documents.css';
import './document-progress-list.css';
import { DocumentCard } from './DocumentProgressCard';
import { progressDocumentHref } from './work-document-link';
import { getDocumentProgress } from './document-progress';
import { ApprovalNodeCard } from './ApprovalNodeCard';
import { WorkDocumentDetails } from './WorkDocumentDetails';
import { progressDossier, type ProgressDossierRecord } from './progress-dossier';
import { isReimbursementPanel } from './reimbursement-batch';
import { ReimbursementBatchPanel } from './ReimbursementBatchPanel';
import { getDraftType, getExpenseCategories, type MaterialExpenseImport, type SubmissionDraft } from './submission-model';
import { readSubmissionState, suggestMaterialDraftId } from './submission-state';
import {
  acceptWorkspace,
  api,
  readWorkspace,
  uploadFile,
  type WorkspaceSnapshot,
} from './runtime-client';

export { buildMaterialExpenseBatch, materialBatchId };
export type { MaterialExpense, MaterialFile };

const clean = (value: string) =>
  value
    .replaceAll('我（演示员工）', '林悦')
    .replaceAll('产品中心', '财务部')
    .replaceAll('（虚构）', '')
    .replace(/^虚构统计示例：/, '');
export const documentInitialData: GenericDocument[] = sourceDocuments.map(
  (d) => ({
    ...d,
    details: [
      ...d.details.map((f) => ({ ...f, value: clean(f.value) })),
      { label: '所属公司', value: '华川科技' },
    ],
    steps: d.steps.map((s) => ({
      ...s,
      actors: s.actors?.map((a) => (a === '我' || a === '你' ? '林悦' : a)),
      note: s.note ? clean(s.note) : undefined,
    })),
    current: d.current
      ? {
          ...d.current,
          actors: d.current.actors.map((a) => (a === '你' ? '林悦' : a)),
        }
      : undefined,
    estimate: d.estimate
      ? { ...d.estimate, basis: clean(d.estimate.basis) }
      : undefined,
  }),
);
type SourceState = 'ready' | 'unavailable' | 'loading';
interface DocumentSourceState {
  states: Record<string, SourceState>;
}
export const documentSourcesInitial: DocumentSourceState = {
  states: { oa: 'unavailable' },
};
const documentSourceOptions = (records: GenericDocument[]) => [
  ...new Map(
    records.map((document) => [document.source.id, document.source]),
  ).values(),
];
const progressFilters = [
  ['all', '全部'],
  ['approval', '审批中'],
  ['needs_action', '待我处理'],
  ['execution', '执行中'],
  ['finished', '已结束'],
] as const;
type ProgressFilter = (typeof progressFilters)[number][0];
function progressGroup(doc: GenericDocument) {
  if (doc.status === 'completed' || doc.status === 'closed') return 'finished';
  return doc.status === 'processing' ? doc.phase : doc.status;
}

export function findWorkspaceDocument(
  id?: string,
  documents: GenericDocument[] = documentInitialData,
) {
  if (id === undefined) return documents[0];
  return documents.find((d) => d.key === id || d.id === id || d.typeId === id);
}

function SourceNotice({
  source = 'all',
  sourceIds,
  detail = false,
}: {
  source?: string;
  sourceIds?: string[];
  detail?: boolean;
}) {
  const w = useWorkspace();
  const [loading, setLoading] = useState(false);
  const [sources] = useSlice('documentSources', documentSourcesInitial);
  const sourceOptions = documentSourceOptions(w.state.data.documents ?? []);
  const missing = sourceOptions.filter(
    (s) =>
      (source === 'all' || s.id === source) &&
      (!sourceIds || sourceIds.includes(s.id)) &&
      (sources.states[s.id] ?? 'ready') !== 'ready',
  );
  if (!missing.length) return null;
  const retry = async () => {
    setLoading(true);
    try {
      await w.flush();
      for (const item of missing)
        await api(`/sources/${encodeURIComponent(item.id)}/retry`, {});
      await w.refresh();
    } catch (error) {
      w.notify(error instanceof Error ? error.message : '来源查询失败，请重试');
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="dw-source-notice" role="status">
      <Icon name="alert" size={16} />
      <span>
        {missing.map((s) => s.label).join('、')}
        {loading
          ? '正在重新查询…'
          : detail
            ? '暂未返回最新状态，请重试。'
            : '暂未返回结果，当前列表可能不完整。'}
      </span>
      <Button variant="ghost" disabled={loading} icon="refresh" onClick={retry}>
        {loading ? '查询中' : '重试'}
      </Button>
    </div>
  );
}

export function DocumentResults({
  limit = 3,
  query = '',
  documentId,
  documents: returnedDocuments,
  documentIds,
  unavailableSources = [],
}: {
  limit?: number;
  query?: string;
  documentId?: string;
  documents?: GenericDocument[];
  documentIds?: string[];
  unavailableSources?: string[];
}) {
  const [sources] = useSlice('documentSources', documentSourcesInitial),
    [expanded, setExpanded] = useState(false);
  const w = useWorkspace();
  const records = (w.state.data.documents ?? []) as GenericDocument[];
  const request = JSON.stringify({
    query,
    documentIds: documentIds ?? (documentId ? [documentId] : undefined),
  });
  const ready = (id: string) => (sources.states[id] ?? 'ready') === 'ready';
  const recovered = unavailableSources.filter(ready).join(',');
  const lookup = (!returnedDocuments && !documentId) || Boolean(recovered);
  const [attempt, retryLookup] = useState(0);
  const key = JSON.stringify([request, recovered, attempt]);
  const [reply, setReply] = useState<{
    key: string;
    items?: GenericDocument[];
    unavailableSources?: string[];
    error?: boolean;
  }>();
  useEffect(() => setExpanded(false), [request]);
  useEffect(() => {
    if (!lookup) return;
    let active = true;
    api<{ items: GenericDocument[]; unavailableSources: string[] }>(
      '/business/documents',
      JSON.parse(request),
    )
      .then((result) => {
        if (active) setReply({ ...result, key });
      })
      .catch(() => {
        if (active) setReply({ key, error: true });
      });
    return () => {
      active = false;
    };
  }, [lookup, key, request]);
  const latest = lookup && reply?.key === key ? reply : undefined;
  const matches =
    latest?.items ??
    returnedDocuments ??
    records.filter((d) => d.key === documentId || d.id === documentId);
  const documents = matches.filter((d) => ready(d.source.id));
  const navigationIds = documents.map((doc) => doc.key);
  const sourceIds = [
    ...(latest?.unavailableSources ?? unavailableSources),
    ...matches.map((d) => d.source.id),
  ];
  const unavailable = sourceIds.some((id) => !ready(id));
  return (
    <div className="dw-results">
      <SourceNotice sourceIds={sourceIds} />
      {latest?.error && (
        <div className="dw-source-notice" role="status">
          单据进展查询失败
          <Button
            variant="ghost"
            icon="refresh"
            onClick={() => retryLookup(attempt + 1)}
          >
            重试
          </Button>
        </div>
      )}
      <div className="dw-document-list">
        {(expanded ? documents : documents.slice(0, limit)).map((d) => (
          <DocumentCard
            key={d.key}
            document={d}
            conversation
            navigationIds={navigationIds}
          />
        ))}
      </div>
      {!documents.length && !latest?.error && (
        <Empty
          title={
            lookup && !latest
              ? '正在查询单据进展…'
              : unavailable
                ? '等待来源返回结果'
                : '没有找到相关单据'
          }
        />
      )}{' '}
      {!expanded && documents.length > limit && (
        <button className="dw-more" onClick={() => setExpanded(true)}>
          查看其余 {documents.length - limit} 张<Icon name="down" size={14} />
        </button>
      )}
    </div>
  );
}

export function DocumentsPage() {
  const [source, setSource] = useState('all');
  const [status, setStatus] = useState<ProgressFilter>('all');
  const [query, setQuery] = useState('');
  const [sources] = useSlice('documentSources', documentSourcesInitial);
  const records = (useWorkspace().state.data.documents ??
    []) as GenericDocument[];
  const sourceOptions = documentSourceOptions(records);
  const isReady = (id: string) => (sources.states[id] ?? 'ready') === 'ready';
  const available = records.filter((doc) => isReady(doc.source.id));
  const pending = available.filter(
    (doc) => doc.status === 'needs_action',
  ).length;
  const keyword = query.trim().toLowerCase();
  const result = available
    .filter((doc) => {
      if (source !== 'all' && doc.source.id !== source) return false;
      if (status !== 'all' && progressGroup(doc) !== status) return false;
      if (!keyword) return true;
      const { node, actors } = getDocumentProgress(doc);
      return [
        doc.title,
        doc.id,
        doc.typeLabel,
        node,
        ...actors,
        ...doc.summary.map((f) => f.value),
      ].some((value) => value.toLowerCase().includes(keyword));
    })
    .sort(
      (a, b) =>
        Number(b.status === 'needs_action') -
        Number(a.status === 'needs_action'),
    );
  const incomplete = sourceOptions.some(
    (s) => (source === 'all' || s.id === source) && !isReady(s.id),
  );
  const navigationIds = result.map((doc) => doc.key);
  const count = source !== 'all' && incomplete ? '—' : result.length;
  const reset = () => {
    setSource('all');
    setStatus('all');
    setQuery('');
  };
  return (
    <div className="dw-page dp-page">
      <header className="dp-hero">
        <div>
          <h1>单据进展</h1>
          {pending > 0 ? (
            <button
              type="button"
              onClick={() => {
                setSource('all');
                setStatus('needs_action');
                setQuery('');
              }}
            >
              {pending} 张单据待我处理 <Icon name="arrow" size={15} />
            </button>
          ) : (
            <p>当前可查 {available.length} 张单据</p>
          )}
        </div>
        <img
          src="/agent-assets/xiaozhi-approval-progress.webp"
          alt=""
          width="870"
          height="348"
        />
      </header>
      <div className="dp-toolbar">
        <div className="dp-filters" aria-label="按办理状态筛选" role="group">
          {progressFilters.map(([id, label]) => (
            <button
              type="button"
              key={id}
              aria-pressed={status === id}
              onClick={() => setStatus(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="dp-query">
          <label className="dw-search">
            <Icon name="search" size={15} />
            <input
              value={query}
              aria-label="搜索单据"
              placeholder="单据名称、单号或处理人"
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="清空搜索"
              >
                <Icon name="close" size={13} />
              </button>
            )}
          </label>
          <select
            aria-label="来源系统"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            <option value="all">全部来源</option>
            {sourceOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <SourceNotice source={source} />
      <div className="dp-ledger">
        <div className="dp-list-head">
          <span>
            单据 <b aria-live="polite">{count} 张</b>
          </span>
          <span>当前环节 / 处理人</span>
          <span>金额 / 时长</span>
          <span>单据状态</span>
        </div>
        <div className="dw-document-list">
          {result.map((doc) => (
            <DocumentCard
              key={doc.key}
              document={doc}
              navigationIds={navigationIds}
            />
          ))}
        </div>
        {!result.length && (
          <Empty
            title={
              incomplete ? '暂无匹配结果，部分来源待返回' : '没有符合条件的单据'
            }
          >
            {(source !== 'all' || status !== 'all' || keyword) && (
              <Button variant="ghost" onClick={reset}>
                清除筛选
              </Button>
            )}
          </Empty>
        )}
      </div>
    </div>
  );
}

type ProgressLookup = {
  document?: GenericDocument;
  sourceId?: string;
  loading?: boolean;
  failed?: boolean;
  retry?: () => void;
};

export function useDocumentPanelLookup(
  panel: PanelSpec | null,
  records: GenericDocument[],
  states: Record<string, SourceState>,
  ready: boolean,
): ProgressLookup {
  const id = ready && panel?.kind === 'document' ? panel.id : undefined;
  const local = id ? findWorkspaceDocument(id, records) : undefined;
  const remoteId = local ? undefined : id;
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState<{
    key: string;
    result: ProgressLookup;
  }>();
  // A recovered source should refresh an open drawer, just as it refreshes its result card.
  const key = JSON.stringify([remoteId, states, attempt]);
  useEffect(() => {
    if (!remoteId) {
      setResponse(undefined);
      return;
    }
    let active = true;
    api<{ items: GenericDocument[]; unavailableSources: string[] }>(
      '/business/documents',
      { documentIds: [remoteId] },
    )
      .then((reply) => {
        if (active)
          setResponse({
            key,
            result: {
              document: reply.items.find(
                (item) => item.key === remoteId || item.id === remoteId,
              ),
              sourceId: reply.unavailableSources[0],
            },
          });
      })
      .catch(() => {
        if (active) setResponse({ key, result: { failed: true } });
      });
    return () => {
      active = false;
    };
  }, [key, remoteId]);
  if (local)
    return {
      document: local,
      sourceId:
        (states[local.source.id] ?? 'ready') === 'ready'
          ? undefined
          : local.source.id,
    };
  if (!remoteId || response?.key !== key) return { loading: !!remoteId };
  return { ...response.result, retry: () => setAttempt((value) => value + 1) };
}

export function DocumentPanelActions({
  panel,
  document: doc,
}: {
  panel: PanelSpec;
  document?: GenericDocument;
}) {
  const w = useWorkspace();
  const ids: string[] = panel.data?.navigationIds ?? [];
  const index = ids.indexOf(panel.id ?? '');
  const switchTo = (id: string) =>
    w.openPanel({
      kind: 'document',
      id,
      title: '单据进展',
      data: { navigationIds: ids },
    });
  return (
    <footer className="dp-actions">
      <Button
        icon="link"
        disabled={!doc}
        onClick={() => {
          if (!doc) return;
          w.attach({ kind: 'document', id: doc.key, title: doc.title });
        }}
      >
        加入对话
      </Button>
      <div className="dp-actions-right">
        <div className="dp-pager" role="group" aria-label="切换单据">
          <button
            type="button"
            disabled={index < 1}
            onClick={() => switchTo(ids[index - 1]!)}
          >
            <Icon name="back" size={13} />
            上一条
          </button>
          <button
            type="button"
            disabled={index < 0 || index >= ids.length - 1}
            onClick={() => switchTo(ids[index + 1]!)}
          >
            下一条
            <Icon name="chevron" size={13} />
          </button>
        </div>
        {doc ? (
          <a
            className="btn primary"
            href={progressDocumentHref(doc)}
            target="_blank"
            rel="noopener noreferrer"
          >
            查看详情
            <Icon name="external" size={14} />
          </a>
        ) : (
          <Button variant="primary" disabled>
            查看详情
          </Button>
        )}
      </div>
    </footer>
  );
}

export function DocumentPanel({ lookup }: { lookup: ProgressLookup }) {
  const w = useWorkspace();
  const { document, sourceId } = lookup;
  if (lookup.loading)
    return (
      <div className="dw-panel" role="status">
        正在读取单据…
      </div>
    );
  if (lookup.failed)
    return (
      <Empty title="读取单据失败">
        <Button onClick={lookup.retry}>重试</Button>
      </Empty>
    );
  if (sourceId)
    return (
      <div className="dw-panel">
        <SourceNotice source={sourceId} detail />
        <Empty title="等待来源返回结果" />
      </div>
    );
  if (!document)
    return (
      <div className="dw-panel">
        <Empty title="未找到这张单据">
          <Button
            variant="ghost"
            onClick={() => {
              w.closePanel();
              w.navigate('documents');
            }}
          >
            返回单据列表
          </Button>
        </Empty>
      </div>
    );
  const dossier = progressDossier(document, w.state.data);
  const origin =
    document.details.find((item) => item.label === '数据来源')?.value ||
    ((document as ProgressDossierRecord).synthetic ? '本地样例' : '');
  return (
    <div className="dw-panel dp-dossier">
      <ApprovalNodeCard document={document} />
      <WorkDocumentDetails
        document={dossier}
        view="progress"
        progressDocument={document}
      />
      <div className="dw-source-line">
        <span>
          {[document.source.label, origin].filter(Boolean).join(' · ')}
        </span>
      </div>
    </div>
  );
}

interface MaterialsState {
  files: MaterialFile[];
  items: MaterialExpense[];
  revision: number;
  savedRevision?: number;
  importedRevision?: number;
  acknowledged: boolean;
  savedSelectionId?: string;
  importedSelectionId?: string;
}
const sampleFiles: MaterialFile[] = [
  ['rail', '高铁电子客票.pdf', 'recognized'],
  ['hotel', '酒店住宿发票.pdf', 'recognized'],
  ['taxi', '网约车行程单.pdf', 'recognized'],
  ['meal', '商务用餐发票.pdf', 'recognized'],
  ['reception', '客户接待发票.pdf', 'recognized'],
  ['office', '办公用品发票.pdf', 'recognized'],
  ['duplicate', '高铁电子客票_副本.pdf', 'duplicate'],
  ['failed', '出租车票_模糊.jpg', 'failed'],
].map(([id, name, status], i) => ({
  id: `material-${id}`,
  name: name!,
  size: 124000 + i * 19800,
  type: name!.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg',
  addedAt: '11月11日 17:30',
  status: status as MaterialFile['status'],
  batchId: materialBatchId,
}));
export const materialsInitial: MaterialsState = {
  files: sampleFiles,
  revision: 1,
  acknowledged: false,
  items: [
    {
      id: 'rail',
      name: '北京南 → 上海虹桥',
      category: '交通',
      categoryId: 'other-long-distance',
      amount: 55200,
      date: '2026-11-10',
      purpose: '客户拜访往程高铁',
      group: 'travel',
      sourceFileId: 'material-rail',
      confirmed: true,
    },
    {
      id: 'hotel',
      name: '上海静安商旅酒店',
      category: '住宿',
      categoryId: 'hotel',
      amount: 65000,
      date: '2026-11-10',
      end: '2026-11-11',
      purpose: '上海客户拜访住宿',
      group: 'travel',
      sourceFileId: 'material-hotel',
      confirmed: false,
      issue: 'date',
    },
    {
      id: 'taxi',
      name: '上海网约车行程',
      category: '交通',
      categoryId: 'taxi',
      amount: 8000,
      date: '2026-11-11',
      purpose: '酒店至客户办公区',
      group: 'travel',
      sourceFileId: 'material-taxi',
      confirmed: true,
    },
    {
      id: 'meal',
      name: '外滩会客餐厅',
      category: '餐饮',
      categoryId: 'reception-meal-oa',
      amount: 68000,
      date: '2026-11-10',
      purpose: '项目交流工作餐',
      oaId: 'OA-2026-0609',
      group: 'daily',
      sourceFileId: 'material-meal',
      confirmed: true,
    },
    {
      id: 'reception',
      name: '浦江商务餐厅',
      category: '餐饮',
      categoryId: 'reception-meal-oa',
      amount: 92000,
      date: '2026-11-11',
      purpose: '客户接待用餐',
      group: 'daily',
      sourceFileId: 'material-reception',
      confirmed: false,
      issue: 'oa',
    },
    {
      id: 'office',
      name: '晨光办公用品',
      category: '办公',
      categoryId: 'other-office',
      amount: 8000,
      date: '2026-11-11',
      purpose: '',
      group: 'daily',
      sourceFileId: 'material-office',
      confirmed: false,
      issue: 'purpose',
    },
  ],
};

const formatSize = (size: number) =>
  size >= 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(size / 1024))} KB`;
const fileStatus: Record<MaterialFile['status'], string> = {
  recognized: '已提取',
  pending: '待提取',
  duplicate: '重复已排除',
  failed: '无法读取',
};
function useMaterialUpload(onUploaded?: (fileIds: string[]) => void) {
  const w = useWorkspace();
  const [uploading, setUploading] = useState(false);
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (!selected.length || uploading) return;
    setUploading(true);
    const fileIds: string[] = [];
    let uploaded = 0;
    try {
      await w.flush();
      for (const file of selected) {
        const result = await uploadFile(file);
        fileIds.push(result.file.id);
        uploaded += 1;
      }
      await w.refresh();
      onUploaded?.(fileIds);
      w.notify(`已保存 ${uploaded} 份材料，可提取费用`);
    } catch (error) {
      await w.refresh().catch(() => undefined);
      if (fileIds.length) onUploaded?.(fileIds);
      w.notify(
        `${uploaded ? `已保存 ${uploaded} 份；` : ''}${error instanceof Error ? error.message : '文件上传失败，请重试'}`,
      );
    } finally {
      setUploading(false);
    }
  };
  return { upload, uploading };
}
function UploadButton({
  label = '添加材料',
  onUploaded,
}: {
  label?: string;
  onUploaded?: (fileIds: string[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null),
    { upload, uploading } = useMaterialUpload(onUploaded);
  return (
    <>
      <input
        className="dw-sr"
        ref={input}
        type="file"
        multiple
        onChange={upload}
        tabIndex={-1}
        aria-label="选择本地材料"
      />
      <Button
        icon="upload"
        disabled={uploading}
        onClick={() => input.current?.click()}
      >
        {uploading ? '上传中…' : label}
      </Button>
    </>
  );
}

function useMaterialExtraction() {
  const w = useWorkspace();
  const [extracting, setExtracting] = useState(false);
  const [notice, setNotice] = useState('');
  const extract = async (fileIds: string[], draftId?: string) => {
    if (!fileIds.length || extracting) return;
    if (fileIds.length > 10) {
      setNotice('每次最多提取 10 份材料。');
      return;
    }
    setExtracting(true);
    setNotice('');
    try {
      await w.flush();
      const result = await api<{
        workspace?: WorkspaceSnapshot;
        items: MaterialExpense[];
        files: MaterialFile[];
      }>('/materials/extract', { fileIds, draftId });
      if (result.workspace) acceptWorkspace(result.workspace);
      else await readWorkspace();
      const failures = result.files.filter(
        (file) =>
          file.extractionStatus === 'failed' ||
          file.extractionStatus === 'unreadable' ||
          file.status === 'failed',
      );
      setNotice(
        result.items.length
          ? `已提取 ${result.items.length} 笔费用，请逐项核对${failures.length ? `；${failures.length} 份材料无法提取` : ''}。`
          : (failures[0]?.extractionError ??
              failures[0]?.error ??
              '未提取到费用，请检查原件或在单据中手工填写。'),
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '提取失败，请重试。');
    } finally {
      setExtracting(false);
    }
  };
  return { extracting, notice, extract };
}

export function FilesPage() {
  const w = useWorkspace(),
    [s] = useSlice('materials', materialsInitial),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all'),
    [selected, setSelected] = useState<string[]>([]);
  const extraction = useMaterialExtraction();
  const files = s.files.filter(
    (file) =>
      (filter === 'all' || file.status === filter) &&
      file.name.toLowerCase().includes(query.toLowerCase()),
  );
  const selectedFiles = s.files.filter((file) => selected.includes(file.id));
  const openSelected = (fileIds: string[]) =>
    w.openPanel({
      kind: 'materials',
      id: materialSelectionId(
        s.files.filter((file) => fileIds.includes(file.id)),
      ),
      title: '材料与费用',
      data: {
        fileIds,
        ...(fileIds.length === 1 ? { fileId: fileIds[0] } : {}),
      },
    });
  return (
    <div className="dw-page">
      <div className="dw-toolbar">
        <label className="dw-search">
          <Icon name="search" size={17} />
          <input
            aria-label="搜索材料"
            placeholder="搜索文件名称"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <UploadButton onUploaded={setSelected} />
        <Button
          disabled={!selectedFiles.length || extraction.extracting}
          onClick={() =>
            extraction.extract(selectedFiles.map((file) => file.id))
          }
        >
          {extraction.extracting ? '提取中…' : '提取费用'}
        </Button>
        <Button
          variant="primary"
          icon="wallet"
          disabled={!selectedFiles.length || extraction.extracting}
          onClick={() => openSelected(selectedFiles.map((file) => file.id))}
        >
          核对费用
        </Button>
      </div>
      {extraction.notice && (
        <div className="dw-inline-notice" role="status">
          {extraction.notice}
        </div>
      )}
      <div className="dw-filter-row">
        <div className="dw-filters">
          {[
            ['all', '全部材料'],
            ['pending', '待提取'],
            ['recognized', '已提取'],
            ['failed', '无法读取'],
            ['duplicate', '已排除'],
          ].map(([id, label]) => (
            <button
              key={id}
              aria-pressed={filter === id}
              className={filter === id ? 'active' : ''}
              onClick={() => setFilter(id!)}
            >
              {label}
            </button>
          ))}
        </div>
        <span>
          {files.length} 份材料
          {selectedFiles.length ? ` · 已选 ${selectedFiles.length} 份` : ''}
        </span>
      </div>
      <div className="dw-file-list">
        {files.map((file) => (
          <div className="dw-file-select-row" key={file.id}>
            <input
              type="checkbox"
              aria-label={`选择${file.name}`}
              checked={selected.includes(file.id)}
              onChange={(event) =>
                setSelected((previous) =>
                  event.target.checked
                    ? [...previous, file.id]
                    : previous.filter((id) => id !== file.id),
                )
              }
            />
            <button
              className="dw-file-row"
              onClick={() => openSelected([file.id])}
            >
              <span className="dw-file-icon">
                <Icon name="file" size={20} />
              </span>
              <span className="dw-file-name">
                <strong>{file.name}</strong>
                <small>
                  {formatSize(file.size)} · {businessTime(file.addedAt)}
                </small>
              </span>
              <Badge
                tone={
                  file.status === 'failed'
                    ? 'warning'
                    : file.status === 'recognized'
                      ? 'success'
                      : 'neutral'
                }
              >
                {fileStatus[file.status]}
              </Badge>
              <Icon name="chevron" size={15} />
            </button>
          </div>
        ))}
      </div>
      {!files.length && <Empty title="没有符合条件的材料" />}
    </div>
  );
}

function ExpenseEditor({
  item,
  onSave,
  onCancel,
}: {
  item: MaterialExpense;
  onSave: (item: MaterialExpense) => void;
  onCancel: () => void;
}) {
  const [edit, setEdit] = useState(item),
    [amount, setAmount] = useState(
      item.amount === null ? '' : (item.amount / 100).toFixed(2),
    ),
    [error, setError] = useState('');
  const category = materialExpenseCategory(edit);
  const categoryQuestion = materialCategoryQuestion(edit);
  const categoryError = !!categoryQuestion && error === categoryQuestion;
  const lodgingDates = category?.template === 'T03' || category?.template === 'T09';
  const routeDates = category?.template === 'T01' || category?.template === 'T08';
  const categories = getExpenseCategories(edit.group === 'daily' ? 'personal' : 'expense');
  const save = () => {
    const parts = amount.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
    const amountCents = parts
      ? Number(parts[1]) * 100 + Number((parts[2] ?? '').padEnd(2, '0'))
      : null;
    const next = { ...edit, amount: amountCents };
    const invalid = materialExpenseError(next);
    if (invalid) {
      setError(invalid);
      return;
    }
    onSave({ ...next, confirmed: true, issue: undefined, issues: [], categoryHint: undefined });
  };
  return (
    <div className="dw-expense-editor">
      <div className="dw-form-grid">
        <Field label="费用名称">
          <input
            value={edit.name}
            onChange={(event) =>
              setEdit((previous) => ({ ...previous, name: event.target.value }))
            }
          />
        </Field>
        <Field label="金额（元）">
          <input
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>
        <Field label="费用归属">
          <select
            value={edit.group ?? ''}
            onChange={(event) =>
              setEdit((previous) => ({
                ...previous,
                group: event.target.value as MaterialExpense['group'],
              }))
            }
          >
            <option value="">请选择归属</option>
            <option value="travel">差旅费用</option>
            <option value="daily">个人费用</option>
          </select>
        </Field>
        <Field label="费用类型">
          <select
            aria-label="费用类型"
            aria-invalid={categoryError || undefined}
            value={category?.id ?? ''}
            onChange={(event) => {
              const categoryId = event.target.value || null;
              setError('');
              setEdit((previous) => ({
                ...previous,
                categoryId,
                oaId: categoryId === 'reception-meal-oa' ? previous.oaId : undefined,
              }));
            }}
          >
            <option value="">请选择费用类型</option>
            {categories
              .filter((option) => option.id !== 'long-distance' || !!edit.tripId)
              .map((option) => (
                <option key={option.id} value={option.id}>
                  {option.group}／{option.label}
                </option>
              ))}
          </select>
        </Field>
        <Field label={lodgingDates ? '入住日期' : routeDates ? '出发日期' : '费用日期'}>
          <input
            type="date"
            value={edit.date}
            onChange={(e) => setEdit((p) => ({ ...p, date: e.target.value }))}
          />
        </Field>
        {(lodgingDates || routeDates) && (
          <Field label={lodgingDates ? '离店日期' : '到达日期'}>
            <input
              type="date"
              min={edit.date}
              value={edit.end ?? ''}
              onChange={(e) => setEdit((p) => ({ ...p, end: e.target.value }))}
            />
          </Field>
        )}
      </div>
      {categoryQuestion && (
        <p
          className={categoryError ? 'dw-error' : 'dw-field-note'}
          role={categoryError ? 'alert' : undefined}
        >
          {categoryQuestion}
        </p>
      )}
      {lodgingDates && edit.issue === 'date' && (
        <p className="dw-field-note">
          请核对实际入住与离店日期，开票日期不作为住宿日期。
        </p>
      )}
      {category?.id === 'reception-meal-oa' && (
        <Field label="关联 OA 申请">
          <input
            value={edit.oaId ?? ''}
            onChange={(event) =>
              setEdit((previous) => ({ ...previous, oaId: event.target.value }))
            }
          />
        </Field>
      )}
      <Field label="实际用途">
        <textarea
          rows={2}
          value={edit.purpose}
          onChange={(e) => setEdit((p) => ({ ...p, purpose: e.target.value }))}
        />
      </Field>
      {error && error !== categoryQuestion && (
        <p className="dw-error" role="alert">
          {error}
        </p>
      )}
      <div className="dw-editor-actions">
        <Button onClick={onCancel}>取消</Button>
        <Button variant="primary" icon="check" onClick={save}>
          保存并确认
        </Button>
      </div>
    </div>
  );
}

export function MaterialsPanel({ panel }: { panel: PanelSpec }) {
  if (isReimbursementPanel(panel)) return <ReimbursementBatchPanel key={panel.data!.draftId} panel={panel} />;
  return <MaterialLibraryPanel panel={panel} />;
}

function MaterialLibraryPanel({ panel }: { panel: PanelSpec }) {
  const w = useWorkspace(),
    [all, set] = useSlice('materials', materialsInitial);
  const submissions = readSubmissionState(w.state.data);
  const s = selectMaterialScope(all, {
    fileIds: panel.data?.fileIds,
    fileId: panel.data?.fileId,
    batchId: panel.id,
  });
  const batchId = panel.data?.fileIds || panel.data?.fileId
    ? materialSelectionId(s.files) : (panel.id ?? materialSelectionId(s.files));
  const currentTask = w.state.tasks.find((task) => task.id === w.state.activeTask);
  const contextIds = [
    panel.data?.draftId,
    ...(currentTask?.refs.filter((ref) => ref.kind === 'submission').map((ref) => ref.id).reverse() ?? []),
    ...(currentTask?.messages.flatMap((message) => message.cards ?? []).filter((card) => card.kind === 'submission').map((card) => card.id).reverse() ?? []),
  ];
  const initialDraftSelections = () => Object.fromEntries(
    (['expense', 'personal'] as const).map((type) => {
      const preferred = contextIds.find((id) => id && submissions.drafts[id]?.status === 'draft' && getDraftType(submissions.drafts[id]!) === type);
      const previous = w.state.data.expenseDraft?.materialBatchId === batchId
        ? w.state.data.expenseDraft?.targetDraftIds?.[type] : undefined;
      return [type, suggestMaterialDraftId(submissions.drafts, type, preferred ?? previous)];
    }),
  ) as Record<'expense' | 'personal', string>;
  const [draftSelections, setDraftSelections] = useState(initialDraftSelections);
  const [generating, setGenerating] = useState(false);
  useEffect(() => setDraftSelections(initialDraftSelections()), [batchId, panel.data?.draftId]);
  const extraction = useMaterialExtraction();
  const initialItem =
    s.items.find((i) => i.sourceFileId === panel.data?.fileId)?.id ?? null;
  const [open, setOpen] = useState<string | null>(initialItem),
    [tab, setTab] = useState<'review' | 'groups'>('review'),
    [filter, setFilter] = useState<'all' | 'needs'>('all'),
    [notice, setNotice] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => {
    setAcknowledged(false);
    setNotice('');
  }, [batchId, all.revision]);
  useEffect(() => {
    setOpen(
      s.items.find((i) => i.sourceFileId === panel.data?.fileId)?.id ?? null,
    );
  }, [panel.data?.fileId, panel.data?.fileIds]);
  const eligible = s.items.filter((i) => !i.excluded),
    pending = eligible.filter((i) => !i.confirmed || !!materialExpenseError(i)),
    total = eligible.reduce((sum, i) => sum + (i.amount ?? 0), 0),
    confirmedTotal = eligible
      .filter((i) => i.confirmed && !materialExpenseError(i))
      .reduce((sum, i) => sum + (i.amount ?? 0), 0);
  const draftTypes = [...new Set(eligible.map((item) => item.group === 'daily' ? 'personal' as const : 'expense' as const))];
  const targetsReady = draftTypes.every((type) => {
    const id = draftSelections[type];
    const draft = submissions.drafts[id];
    return id === 'new' || !!draft && draft.status === 'draft' && getDraftType(draft) === type;
  });
  const failed = s.files.filter((f) => f.status === 'failed'),
    unknown = s.files.filter((f) => f.status === 'pending'),
    duplicates = s.files.filter((f) => f.status === 'duplicate');
  const canUse =
    eligible.length > 0 &&
    pending.length === 0 &&
    acknowledged &&
    eligible.every((item) => !materialExpenseError(item));
  const mutateItem = (item: MaterialExpense) =>
    set((p) => ({
      ...p,
      items: p.items.map((i) =>
        i.id === item.id
          ? {
              ...item,
              confirmed: item.confirmed && !materialExpenseError(item),
            }
          : i,
      ),
      revision: p.revision + 1,
      acknowledged: false,
    }));
  const saveExpenses = async () => {
    if (!canUse) return;
    const batch = buildMaterialExpenseBatch(s, batchId);
    w.updateData(
      'expenseLibrary',
      (previous: Record<string, any> | undefined) => ({
        ...previous,
        [batchId]: { ...batch, savedAt: new Date().toISOString() },
      }),
    );
    set((p) => ({
      ...p,
      savedRevision: p.revision,
      savedSelectionId: batchId,
    }));
    try {
      await w.flush();
      setNotice(
        `${eligible.length} 笔费用已保存，合计 ¥${(total / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}。`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '费用保存失败');
    }
  };
  const generate = async () => {
    if (!canUse || !targetsReady || generating) return;
    setGenerating(true);
    setNotice('');
    try {
    await w.flush();
    const targetDraftIds: NonNullable<MaterialExpenseImport['targetDraftIds']> = {};
    for (const type of draftTypes) {
      const selected = draftSelections[type];
      if (selected === 'new') {
        const result = await api<{ draft: SubmissionDraft }>('/business/new-draft', { id: type });
        targetDraftIds[type] = result.draft.id;
        setDraftSelections((previous) => ({ ...previous, [type]: result.draft.id }));
      } else targetDraftIds[type] = selected;
    }
    await w.refresh();
    const batch = buildMaterialExpenseBatch(s, batchId);
    const personal = batch.items[0]?.group === 'daily';
    w.updateData('expenseDraft', {
      ...batch,
      id: `${batchId}-r${s.revision}`,
      taskId: w.state.activeTask,
      status: 'draft',
      targetDraftIds,
    });
    set((p) => ({
      ...p,
      importedRevision: s.revision,
      importedSelectionId: batchId,
    }));
    w.openPanel({
      kind: 'submission',
      id: targetDraftIds[personal ? 'personal' : 'expense'],
      title: personal ? '个人费用报销' : '差旅报销',
      data: { materialBatchId: batchId },
    });
    if (new Set(batch.items.map((item) => item.group)).size > 1)
      w.notify('费用将载入所选差旅报销和个人费用报销草稿');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '草稿载入失败，请重试');
    } finally {
      setGenerating(false);
    }
  };
  return (
    <div className="dw-panel dw-materials">
      <div className="dw-material-heading">
        <span>
          {s.files.length} 份材料 · {eligible.length} 笔费用
        </span>
        <Badge
          tone={
            pending.length || unknown.length || failed.length
              ? 'warning'
              : 'success'
          }
        >
          {pending.length || unknown.length || failed.length
            ? `${pending.length + unknown.length + failed.length} 项待核对`
            : s.items.length
              ? '核对完成'
              : '暂无费用'}
        </Badge>
      </div>
      <div className="dw-panel-actions">
        <Button
          disabled={!s.files.length || extraction.extracting}
          onClick={() => extraction.extract(s.files.map((file) => file.id))}
        >
          {extraction.extracting ? '提取中…' : '提取费用'}
        </Button>
      </div>
      {extraction.notice && (
        <div className="dw-inline-notice" role="status">
          {extraction.notice}
        </div>
      )}
      {panel.data?.fileId && (
        <div className="dw-panel-actions">
          {s.files.some(
            (file) =>
              file.id === panel.data?.fileId &&
              /\.(png|jpe?g|webp|pdf)$/i.test(file.name),
          ) && (
            <Button
              icon="layout"
              onClick={() =>
                w.openPanel({
                  kind: 'translation',
                  title: '附件翻译',
                  id: String(panel.data!.fileId),
                })
              }
            >
              翻译成中文
            </Button>
          )}
          {String(panel.data.fileId).startsWith('file-') && (
            <a
              className="button"
              href={`/api/local/files/${encodeURIComponent(String(panel.data.fileId))}/download`}
              target="_blank"
              rel="noreferrer"
            >
              打开文件原件
            </a>
          )}
          <Button
            icon="link"
            onClick={() => {
              const file = s.files.find(
                (item) => item.id === panel.data?.fileId,
              );
              if (file) {
                w.attach({ kind: 'file', id: file.id, title: file.name });
                w.closePanel();
                w.navigate('chat');
              }
            }}
          >
            加入对话
          </Button>
        </div>
      )}
      <div className="dw-material-total">
        <span>费用合计</span>
        <Money value={total} />
        <small>
          已确认 <Money value={confirmedTotal} />
        </small>
      </div>
      <div className="dw-panel-tabs">
        <button
          className={tab === 'review' ? 'active' : ''}
          aria-pressed={tab === 'review'}
          onClick={() => setTab('review')}
        >
          材料核对
        </button>
        <button
          className={tab === 'groups' ? 'active' : ''}
          aria-pressed={tab === 'groups'}
          onClick={() => setTab('groups')}
        >
          费用分组
        </button>
      </div>
      {notice && (
        <div className="dw-inline-notice" role="status">
          <Icon name="check" size={16} />
          {notice}
        </div>
      )}
      {tab === 'review' ? (
        <>
          <div className="dw-review-toolbar">
            <span>{filter === 'needs' ? '待核对费用' : '费用明细'}</span>
            <label>
              <input
                type="checkbox"
                checked={filter === 'needs'}
                onChange={(e) => setFilter(e.target.checked ? 'needs' : 'all')}
              />
              仅看待核对
            </label>
          </div>
          {!s.items.length && (
            <Empty title="尚无费用条目">
              <p className="dw-field-note">
                请提取所选材料，或在报销单中手工填写费用。
              </p>
            </Empty>
          )}
          <div className="dw-expense-list">
            {s.items
              .filter(
                (i) =>
                  filter === 'all' ||
                  ((!i.confirmed || !!materialExpenseError(i)) && !i.excluded),
              )
              .map((item) => {
                const category = materialExpenseCategory(item);
                const confirmed = item.confirmed && !materialExpenseError(item);
                return (
                  <div
                    className={`dw-expense-item ${item.excluded ? 'is-excluded' : ''}`}
                    key={item.id}
                  >
                    <button
                      className="dw-expense-head"
                      onClick={() => setOpen(open === item.id ? null : item.id)}
                      aria-expanded={open === item.id}
                    >
                      <span className="dw-expense-type">
                        {category ? `${category.group}／${category.label}` : '费用类型待确认'}
                      </span>
                      <span className="dw-expense-name">
                        <strong>{item.name}</strong>
                        <small>
                          {item.excluded
                            ? '本次不使用'
                            : !category
                              ? '请核对票面和实际用途'
                              : item.issue === 'date'
                              ? (category.template === 'T03' || category.template === 'T09' ? '待核对住宿日期' : '待补费用日期')
                              : item.issue === 'oa'
                                ? '待选择接待申请'
                                : item.issue === 'purpose'
                                  ? '待填写实际用途'
                                  : item.date}
                        </small>
                      </span>
                      <span className="dw-expense-number">
                        {item.amount === null ? (
                          '金额待填写'
                        ) : (
                          <Money value={item.amount} />
                        )}
                        <Badge
                          tone={
                            item.excluded
                              ? 'neutral'
                              : confirmed
                                ? 'success'
                                : 'warning'
                          }
                        >
                          {item.excluded
                            ? '已排除'
                            : confirmed
                              ? '已确认'
                              : '待核对'}
                        </Badge>
                      </span>
                      <Icon
                        name={open === item.id ? 'down' : 'chevron'}
                        size={14}
                      />
                    </button>
                    {open === item.id && (
                      <>
                        <div className="dw-material-source">
                          <Icon name="file" size={14} />
                          <span>
                            {
                              s.files.find((f) => f.id === item.sourceFileId)
                                ?.name
                            }
                          </span>
                          {item.sourceFileId.startsWith('file-') && (
                            <a
                              href={`/api/local/files/${encodeURIComponent(item.sourceFileId)}/download`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              打开原件
                            </a>
                          )}
                          <button
                            onClick={() => {
                              mutateItem({ ...item, excluded: !item.excluded });
                              setNotice('');
                            }}
                          >
                            {item.excluded ? '恢复使用' : '本次不使用'}
                          </button>
                        </div>
                        {!item.excluded &&
                          item.evidence &&
                          Object.keys(item.evidence).length > 0 && (
                            <details className="dw-material-evidence">
                              <summary>提取依据</summary>
                              <dl>
                                {Object.entries(item.evidence).map(
                                  ([field, value]) => (
                                    <div key={field}>
                                      <dt>
                                        {(
                                          {
                                            name: '费用名称',
                                            amount: '金额',
                                            category: '类别',
                                            date: '日期',
                                            end: '离店日期',
                                            departureCity: '出发城市',
                                            arrivalCity: '到达城市',
                                            city: '住宿城市',
                                            transport: '交通工具',
                                            purpose: '事由',
                                            group: '归属',
                                          } as Record<string, string>
                                        )[field] ?? field}
                                      </dt>
                                      <dd>{value}</dd>
                                    </div>
                                  ),
                                )}
                              </dl>
                            </details>
                          )}
                        {!item.excluded && (
                          <ExpenseEditor
                            key={`${item.id}-${s.revision}`}
                            item={item}
                            onCancel={() => setOpen(null)}
                            onSave={(next) => {
                              mutateItem(next);
                              setOpen(null);
                              setNotice(`${next.name}已确认`);
                            }}
                          />
                        )}
                      </>
                    )}
                  </div>
                );
              })}
          </div>
          {filter === 'needs' && !pending.length && (
            <div className="dw-inline-notice">
              <Icon name="check" size={16} />
              待核对项已处理完成
            </div>
          )}
        </>
      ) : (
        <div className="dw-expense-groups">
          {(['travel', 'daily'] as const).map((group) => {
            const rows = eligible.filter((i) => i.group === group);
            return (
              <Section
                key={group}
                title={group === 'travel' ? '差旅费用' : '个人费用'}
                action={
                  <Money
                    value={rows.reduce((sum, i) => sum + (i.amount ?? 0), 0)}
                  />
                }
              >
                {rows.length ? (
                  rows.map((item) => (
                    <div className="dw-group-row" key={item.id}>
                      <div>
                        <strong>{item.name}</strong>
                        <small>{item.confirmed ? '已确认' : '待核对'}</small>
                      </div>
                      {item.amount === null ? (
                        '金额待填写'
                      ) : (
                        <Money value={item.amount} />
                      )}
                      <select
                        aria-label={`${item.name}的费用分组`}
                        value={item.group ?? ''}
                        onChange={(e) =>
                          mutateItem({
                            ...item,
                            group: e.target.value as MaterialExpense['group'],
                          })
                        }
                      >
                        <option value="">请选择归属</option>
                        <option value="travel">差旅费用</option>
                        <option value="daily">个人费用</option>
                      </select>
                    </div>
                  ))
                ) : (
                  <p className="dw-field-note">暂无费用</p>
                )}
              </Section>
            );
          })}
        </div>
      )}
      <section className="dw-exceptions">
        <h3>未计入费用</h3>
        {duplicates.map((file) => (
          <div key={file.id} className="dw-exception-row">
            <Icon name="copy" size={17} />
            <div>
              <strong>{file.name}</strong>
              <span>与已保存材料内容重复，本次未计入费用</span>
            </div>
            <Badge>重复</Badge>
          </div>
        ))}
        {failed.map((file) => (
          <div key={file.id} className="dw-exception-row">
            <Icon name="alert" size={17} />
            <div>
              <strong>{file.name}</strong>
              {file.id.startsWith('file-') && (
                <a
                  href={`/api/local/files/${encodeURIComponent(file.id)}/download`}
                  target="_blank"
                  rel="noreferrer"
                >
                  打开原件
                </a>
              )}
              <span>
                {file.extractionError ??
                  file.error ??
                  '无法提取文本，请补充可读取的文本材料，或在单据中手工填写。'}
              </span>
            </div>
            <Button
              variant="ghost"
              disabled={extraction.extracting}
              onClick={() => extraction.extract([file.id])}
            >
              {extraction.extracting ? '提取中' : '重新提取'}
            </Button>
          </div>
        ))}
        {unknown.map((file) => (
          <div
            key={file.id}
            className={`dw-exception-row ${panel.data?.fileId === file.id ? 'is-selected' : ''}`}
          >
            <Icon name="file" size={17} />
            <div>
              <strong>{file.name}</strong>
              <span>{formatSize(file.size)} · 已保存，待提取费用</span>
            </div>
            <button
              className="dw-remove"
              aria-label={`移除${file.name}`}
              onClick={() =>
                set((p) => ({
                  ...p,
                  files: p.files.filter((f) => f.id !== file.id),
                  revision: p.revision + 1,
                  acknowledged: false,
                }))
              }
            >
              <Icon name="close" size={15} />
            </button>
          </div>
        ))}
        {!duplicates.length && !failed.length && !unknown.length && (
          <p className="dw-field-note">无未计入材料</p>
        )}
        <div className="dw-upload-row">
          <UploadButton
            label="补充材料"
            onUploaded={(fileIds) =>
              w.openPanel({
                kind: 'materials',
                id: 'uploaded-materials',
                title: '材料与费用',
                data: { fileIds },
              })
            }
          />
        </div>
      </section>
      <label className="dw-ack">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        <span>
          已核对本次使用的 {eligible.length} 笔费用，以及未计入的材料。
        </span>
      </label>
      {pending.length > 0 && (
        <p className="dw-field-note">
          还有 {pending.length} 项业务信息待核对。
        </p>
      )}
      {draftTypes.map((type) => (
        <Field key={type} label={type === 'personal' ? '个人费用报销草稿' : '差旅报销草稿'}>
          <select
            value={draftSelections[type]}
            disabled={generating}
            onChange={(event) => setDraftSelections((previous) => ({ ...previous, [type]: event.target.value }))}
          >
            <option value="">请选择要载入的草稿</option>
            {Object.values(submissions.drafts).filter((draft) => draft.status === 'draft' && getDraftType(draft) === type).map((draft) => (
              <option key={draft.id} value={draft.id}>
                {draft.title}{draft.purpose ? ` · ${draft.purpose}` : ' · 事由待填写'}
              </option>
            ))}
            <option value="new">新建{type === 'personal' ? '个人费用报销' : '差旅报销'}</option>
          </select>
        </Field>
      ))}
      <div className="dw-panel-actions dw-material-actions">
        <Button
          variant="ghost"
          icon="link"
          onClick={() => {
            w.attach({
              kind: 'materials',
              id: batchId,
              title: '已选材料与费用',
              version: `r${s.revision}`,
              fileIds: s.files.map((file) => file.id),
            });
            w.closePanel();
            w.navigate('chat');
          }}
        >
          加入对话
        </Button>
        <span className="dw-spacer" />
        <Button
          disabled={
            !canUse ||
            (s.savedRevision === s.revision && s.savedSelectionId === batchId)
          }
          onClick={saveExpenses}
        >
          {s.savedRevision === s.revision && s.savedSelectionId === batchId
            ? '费用已保存'
            : '只保存费用'}
        </Button>
        <Button variant="primary" disabled={!canUse || !targetsReady || generating} onClick={generate}>
          {generating ? '正在载入…' : s.importedRevision === s.revision &&
          s.importedSelectionId === batchId
            ? '继续报销草稿'
            : '生成报销草稿'}
        </Button>
      </div>
    </div>
  );
}
