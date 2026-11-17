import { useCallback, useEffect, useRef, useState } from 'react';
import { acceptWorkspace, api, readWorkspace, uploadFile } from './runtime-client';
import type { UploadedFile, WorkspaceSnapshot } from './runtime-client';
import { Button, Icon } from './ui';
import './expense-summary-tool.css';

interface SummaryResult {
  id: string;
  fileId: string;
  fileName: string;
  createdAt: string;
  rowCount: number;
  totalMinor: string;
  groups: { name: string; amountMinor: string; count: number }[];
}

function resultFromRoute() {
  return new URLSearchParams(location.hash.split('?')[1] || '').get('result');
}

function money(minor: string) {
  const value = BigInt(minor);
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${(absolute / 100n).toLocaleString('zh-CN')}.${String(absolute % 100n).padStart(2, '0')}`;
}

function openResult(id: string) {
  const query = new URLSearchParams(location.hash.split('?')[1] || '');
  query.set('tool', 'expense-summary');
  query.set('action', 'tool');
  query.set('result', id);
  location.hash = `skills?${query}`;
}

export function ExpenseSummaryTool() {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [fileId, setFileId] = useState('');
  const [history, setHistory] = useState<SummaryResult[]>([]);
  const [result, setResult] = useState<SummaryResult | null>(null);
  const [resultId, setResultId] = useState(resultFromRoute);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [fileResponse, historyResponse] = await Promise.all([
        api<{ files: UploadedFile[] }>('/files'),
        api<{ results: SummaryResult[] }>('/tools/results'),
      ]);
      setFiles(fileResponse.files.filter((file) => /\.csv$/i.test(file.name)));
      setHistory(historyResponse.results);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const onHashChange = () => setResultId(resultFromRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    let current = true;
    setResult(null);
    if (resultId) {
      api<{ result: SummaryResult }>(`/tools/results/${encodeURIComponent(resultId)}`)
        .then((response) => {
          if (current) {
            setResult(response.result);
            setFileId(response.result.fileId);
          }
        })
        .catch((failure: Error) => { if (current) setError(failure.message); });
    }
    return () => { current = false; };
  }, [resultId]);

  async function upload(file: File | undefined) {
    if (!file) return;
    setError('');
    if (!/\.csv$/i.test(file.name) || file.size > 2 * 1024 * 1024) {
      setError('请选择不超过 2 MiB 的 CSV 文件。');
      return;
    }
    setUploading(true);
    try {
      const response = await uploadFile(file);
      setFiles((previous) => [response.file, ...previous]);
      setFileId(response.file.id);
      void readWorkspace().catch(() => {});
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  }

  async function run() {
    setRunning(true);
    setError('');
    try {
      const response = await api<{ result: SummaryResult; workspace: WorkspaceSnapshot }>('/tools/expense-summary', { fileId });
      acceptWorkspace(response.workspace);
      setResult(response.result);
      setHistory((previous) => [response.result, ...previous.filter((item) => item.id !== response.result.id)]);
      openResult(response.result.id);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function download() {
    if (!result) return;
    setDownloading(true);
    setError('');
    try {
      const response = await fetch(`/api/local/tools/results/${encodeURIComponent(result.id)}/download`);
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.message || payload?.detail || '下载失败，请重试。');
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `${result.fileName.replace(/\.csv$/i, '')}-费用汇总.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setDownloading(false);
    }
  }

  const busy = running || uploading;
  return <section className="expense-summary" aria-label="CSV 费用汇总">
    <header className="expense-summary-header">
      <h2>费用汇总</h2>
      <div className="expense-summary-actions">
        <Button onClick={() => void refresh()} disabled={loading || busy}><Icon name="refresh" size={14} />{loading ? '刷新中…' : '刷新'}</Button>
      </div>
    </header>

    <form className="expense-summary-form" onSubmit={(event) => { event.preventDefault(); void run(); }}>
      <label htmlFor="expense-summary-file">费用文件</label>
      <div className="expense-summary-file-controls">
        <select id="expense-summary-file" aria-describedby="expense-summary-constraints" value={fileId} onChange={(event) => setFileId(event.target.value)} disabled={busy || loading} required>
          <option value="">{loading ? '正在读取文件…' : '选择已上传的 CSV'}</option>
          {files.map((file) => <option key={file.id} value={file.id}>{file.name}</option>)}
        </select>
        <input ref={input} className="expense-summary-file-input" type="file" accept=".csv,text/csv" tabIndex={-1} onChange={(event) => void upload(event.target.files?.[0])} />
        <Button type="button" disabled={busy} onClick={() => input.current?.click()}><Icon name="upload" size={14} />{uploading ? '上传中…' : '上传 CSV'}</Button>
        <Button type="submit" variant="primary" disabled={!fileId || busy || loading}>{running ? '汇总中…' : '开始汇总'}</Button>
      </div>
      <p id="expense-summary-constraints">CSV 需包含费用类型、金额列，或 category、amount 列。金额单位为元，最多 2 位小数。最多 10,000 条、2 MiB。</p>
    </form>

    {error && <div className="expense-summary-error" role="alert">{error}</div>}
    {running && <p className="expense-summary-status" role="status">正在汇总费用…</p>}

    {result && <section className="expense-summary-result" aria-label="汇总结果">
      <div className="expense-summary-result-heading">
        <div><h3>{result.fileName}</h3><p>{result.rowCount.toLocaleString('zh-CN')} 条费用 · {new Date(result.createdAt).toLocaleString('zh-CN')}</p></div>
        <Button disabled={downloading} onClick={() => void download()}><Icon name="download" size={14} />{downloading ? '下载中…' : '下载汇总 CSV'}</Button>
      </div>
      <div className="expense-summary-table-wrap">
        <table><caption>费用分类汇总，金额单位为人民币元</caption><thead><tr><th scope="col">费用类型</th><th scope="col">条数</th><th scope="col">金额（元）</th></tr></thead>
          <tbody>{result.groups.map((group) => <tr key={group.name}><th scope="row">{group.name}</th><td>{group.count.toLocaleString('zh-CN')}</td><td>{money(group.amountMinor)}</td></tr>)}</tbody>
          <tfoot><tr><th scope="row">合计</th><td>{result.rowCount.toLocaleString('zh-CN')}</td><td>¥ {money(result.totalMinor)}</td></tr></tfoot>
        </table>
      </div>
    </section>}

    <section className="expense-summary-history" aria-label="汇总历史">
      <h3>汇总历史</h3>
      {loading ? <p role="status">正在读取历史…</p> : history.length === 0 ? <p>暂无汇总记录</p> : <ul>{history.map((item) => <li key={item.id}>
        <button type="button" aria-current={resultId === item.id ? 'true' : undefined} onClick={() => { setError(''); openResult(item.id); }}>
          <span>{item.fileName}<small>{new Date(item.createdAt).toLocaleString('zh-CN')} · {item.rowCount.toLocaleString('zh-CN')} 条</small></span>
          <strong>¥ {money(item.totalMinor)}</strong>
        </button>
      </li>)}</ul>}
    </section>
  </section>;
}
