import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from 'react';
import { Badge, Button, Icon } from './ui';
import { useWorkspace, type PanelSpec } from './workspace';
import { uploadFile, type UploadedFile } from './runtime-client';
import {
  readTranslation,
  startTranslation,
  translationIsRunning,
} from './translation-client';
import {
  TRANSLATION_FILE_ACCEPT,
  findTranslationBlock,
  isTranslationFile,
  normalizeTranslationBox,
  translationText,
  validateTranslationFile,
  type TranslationBlock,
  type TranslationResult,
} from './translation-model';
import './translation.css';

type Phase =
  'empty' | 'loading' | 'ready' | 'translating' | 'completed' | 'error';
let lastOpenedFileId = '';
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : '处理失败，请稍后重试。';
const languageName = (language?: string) => {
  if (!language) return '自动检测';
  const names: Record<string, string> = {
    en: '英语',
    eng: '英语',
    ja: '日语',
    jpn: '日语',
    ko: '韩语',
    kor: '韩语',
    fr: '法语',
    de: '德语',
    es: '西班牙语',
    zh: '中文',
    'zh-CN': '中文',
    'zh-Hans': '中文',
    mixed: '多种语言',
    unknown: '自动检测',
    und: '自动检测',
  };
  return names[language] ?? language;
};

export function TranslationPanel({ panel }: { panel: PanelSpec }) {
  const w = useWorkspace();
  const [selectedId, setSelectedId] = useState(panel.id ?? lastOpenedFileId);
  const [uploadedFile, setUploadedFile] = useState<UploadedFile | null>(null);
  const [phase, setPhase] = useState<Phase>(selectedId ? 'loading' : 'empty');
  const [result, setResult] = useState<TranslationResult | null>(null);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [pageIndex, setPageIndex] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [selection, setSelection] = useState<{
    id: string;
    from: 'text' | 'image';
    serial: number;
  } | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [actionMessage, setActionMessage] = useState('');
  const autoStarted = useRef(new Set<string>());
  const inputRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const currentId = useRef(selectedId);
  currentId.current = selectedId;
  const files: UploadedFile[] = Array.isArray(w.state.data.materials?.files)
    ? w.state.data.materials.files.filter(
        (file: UploadedFile) =>
          typeof file?.name === 'string' && isTranslationFile(file),
      )
    : [];
  const selectedFile =
    files.find((file) => file.id === selectedId) ??
    (uploadedFile?.id === selectedId ? uploadedFile : null);
  const fileName = selectedFile?.name ?? result?.fileName ?? '附件';
  const page = result?.pages[pageIndex];
  const pageNumber = page?.page ?? 1;
  const previewUrl = selectedId
    ? (page?.imageUrl ??
      `/api/local/files/${encodeURIComponent(selectedId)}/pages/1`)
    : '';
  const lowConfidenceCount =
    result?.pages.reduce(
      (sum, item) =>
        sum +
        item.blocks.filter(
          (block) => block.confidence !== undefined && block.confidence < 0.8,
        ).length,
      0,
    ) ?? 0;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (panel.id) setSelectedId(panel.id);
  }, [panel.id]);
  useEffect(() => {
    let cancelled = false;
    lastOpenedFileId = selectedId;
    setResult(null);
    setPageIndex(0);
    setSelection(null);
    setZoom(100);
    setError('');
    setActionMessage('');
    if (!selectedId) {
      setPhase('empty');
      return;
    }
    setPhase(translationIsRunning(selectedId) ? 'translating' : 'loading');
    void (async () => {
      try {
        let found = await readTranslation(selectedId);
        if (cancelled) return;
        if (
          !found &&
          panel.data?.autoStart &&
          selectedId === panel.id &&
          !autoStarted.current.has(selectedId)
        ) {
          autoStarted.current.add(selectedId);
          setPhase('translating');
          found = await startTranslation(selectedId);
        }
        if (cancelled) return;
        setResult(found);
        setPhase(found ? 'completed' : 'ready');
      } catch (failure) {
        if (!cancelled) {
          setError(errorMessage(failure));
          setPhase('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, panel.id, panel.data?.autoStart]);
  useEffect(() => {
    setPreviewLoaded(false);
    setPreviewFailed(false);
  }, [previewUrl, previewAttempt]);
  useEffect(() => {
    if (!selection) return;
    const container =
      selection.from === 'text' ? imageRef.current : textRef.current;
    const nodes = container?.querySelectorAll<HTMLElement>('[data-block-id]');
    const element = Array.from(nodes ?? []).find(
      (node) => node.dataset.blockId === selection.id,
    );
    element?.scrollIntoView({
      block: 'center',
      inline: 'nearest',
      behavior: 'instant',
    });
  }, [selection, pageIndex, previewLoaded]);

  async function translate() {
    if (!selectedId || phase === 'translating') return;
    const id = selectedId;
    setPhase('translating');
    setError('');
    try {
      const translated = await startTranslation(id);
      if (!alive.current || currentId.current !== id) return;
      setResult(translated);
      setPageIndex(0);
      setPhase('completed');
    } catch (failure) {
      if (alive.current && currentId.current === id) {
        setError(errorMessage(failure));
        setPhase('error');
      }
    }
  }
  async function upload(file?: File) {
    if (!file || uploading) return;
    const invalid = validateTranslationFile(file);
    setUploadError(invalid ?? '');
    if (invalid) return;
    setUploading(true);
    try {
      await w.flush();
      const { file: stored } = await uploadFile(file);
      await w.refresh();
      if (!alive.current) {
        lastOpenedFileId = stored.id;
        return;
      }
      setUploadedFile(stored);
      setSelectedId(stored.id);
      setActionMessage('');
    } catch (failure) {
      await w.refresh().catch(() => undefined);
      if (alive.current) setUploadError(errorMessage(failure));
    } finally {
      if (alive.current) setUploading(false);
    }
  }
  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    void upload(file);
  }
  function selectBlock(block: TranslationBlock, from: 'text' | 'image') {
    setSelection((previous) => ({
      id: block.id,
      from,
      serial: (previous?.serial ?? 0) + 1,
    }));
  }
  function changePage(next: number) {
    setPageIndex(next);
    setSelection(null);
    imageRef.current?.scrollTo({ left: 0, top: 0 });
    textRef.current?.scrollTo({ top: 0 });
  }
  async function copyText() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(translationText(result.pages));
      setActionMessage('已复制全部译文');
    } catch {
      setActionMessage('复制失败，请允许剪贴板权限或下载译文。');
    }
  }
  function downloadText() {
    if (!result) return;
    const url = URL.createObjectURL(
      new Blob(['\ufeff', translationText(result.pages)], {
        type: 'text/plain;charset=utf-8',
      }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${result.fileName.replace(/\.[^.]+$/, '')}-中文译文.txt`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="translation-workspace">
      <input
        ref={inputRef}
        className="translation-file-input"
        type="file"
        accept={TRANSLATION_FILE_ACCEPT}
        aria-label="上传翻译附件"
        onChange={chooseFile}
        tabIndex={-1}
      />
      <div className="translation-toolbar">
        <div className="translation-file-control">
          <Icon name="file" size={19} />
          {files.length > 0 ? (
            <select
              aria-label="选择翻译文件"
              value={selectedId}
              disabled={uploading}
              onChange={(event) => {
                setUploadError('');
                setSelectedId(event.target.value);
              }}
            >
              {!selectedId && <option value="">选择已有附件</option>}
              {selectedId && !files.some((file) => file.id === selectedId) && (
                <option value={selectedId}>{fileName}</option>
              )}
              {files.map((file) => (
                <option key={file.id} value={file.id}>
                  {file.name}
                </option>
              ))}
            </select>
          ) : (
            <strong title={selectedId ? fileName : undefined}>
              {selectedId ? fileName : '选择附件'}
            </strong>
          )}
        </div>
        <div className="translation-language">
          <span>{languageName(result?.sourceLanguage)}</span>
          <Icon name="arrow" size={15} />
          <strong>中文</strong>
        </div>
        <Button
          icon="upload"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
        >
          {uploading ? '上传中…' : selectedId ? '重新上传' : '上传附件'}
        </Button>
      </div>
      {uploadError && (
        <div className="translation-inline-error" role="alert">
          <Icon name="alert" size={16} />
          <span>{uploadError}</span>
        </div>
      )}
      {!selectedId ? (
        <div
          className={`translation-upload-area${dragging ? ' is-dragging' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void upload(event.dataTransfer.files[0]);
          }}
        >
          <Icon name="upload" size={30} />
          <h3>{uploading ? '正在上传附件' : '上传需要翻译的附件'}</h3>
          <p>PNG、JPG、WebP 或 PDF，单个文件不超过 10 MB</p>
          <Button
            variant="primary"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
          >
            {uploading ? '上传中…' : '选择文件'}
          </Button>
        </div>
      ) : (
        <div className="translation-columns">
          <section className="translation-original" aria-label="原件预览">
            <header className="translation-section-header">
              <h3>原件</h3>
              <div className="translation-zoom-controls">
                <button
                  type="button"
                  className="translation-icon-button"
                  aria-label="缩小原件"
                  disabled={zoom <= 50}
                  onClick={() => setZoom((value) => Math.max(50, value - 25))}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    aria-hidden="true"
                  >
                    <path d="M5 12h14" />
                  </svg>
                </button>
                <span className="translation-zoom-value" aria-live="polite">
                  {zoom}%
                </span>
                <button
                  type="button"
                  className="translation-icon-button"
                  aria-label="放大原件"
                  disabled={zoom >= 200}
                  onClick={() => setZoom((value) => Math.min(200, value + 25))}
                >
                  <Icon name="plus" size={16} />
                </button>
                <Button variant="ghost" onClick={() => setZoom(100)}>
                  适合宽度
                </Button>
              </div>
            </header>
            <div className="translation-image-scroll" ref={imageRef}>
              {previewFailed ? (
                <div className="translation-preview-error" role="alert">
                  <Icon name="alert" size={25} />
                  <strong>原件预览加载失败</strong>
                  <p>请重试，或检查文件是否完整后重新上传。</p>
                  <Button
                    icon="refresh"
                    onClick={() => setPreviewAttempt((value) => value + 1)}
                  >
                    重新加载
                  </Button>
                </div>
              ) : (
                <>
                  {!previewLoaded && (
                    <div className="translation-preview-loading" role="status">
                      正在加载原件…
                    </div>
                  )}
                  <div
                    className="translation-image-sheet"
                    style={{ width: `${zoom}%` }}
                    onClick={(event) => {
                      if (!page) return;
                      const bounds =
                        event.currentTarget.getBoundingClientRect();
                      const block = findTranslationBlock(
                        page.blocks,
                        (event.clientX - bounds.left) / bounds.width,
                        (event.clientY - bounds.top) / bounds.height,
                      );
                      if (block) selectBlock(block, 'image');
                    }}
                  >
                    <img
                      key={`${previewUrl}-${previewAttempt}`}
                      src={`${previewUrl}${previewAttempt ? `?retry=${previewAttempt}` : ''}`}
                      alt={`${fileName}，第 ${pageNumber} 页`}
                      draggable={false}
                      onLoad={() => setPreviewLoaded(true)}
                      onError={() => setPreviewFailed(true)}
                    />
                    {previewLoaded &&
                      page?.blocks.map((block) => {
                        const box = normalizeTranslationBox(block.bbox);
                        if (!box) return null;
                        const style: CSSProperties = {
                          left: `${box.x * 100}%`,
                          top: `${box.y * 100}%`,
                          width: `${box.width * 100}%`,
                          height: `${box.height * 100}%`,
                        };
                        return (
                          <button
                            key={block.id}
                            type="button"
                            className={`translation-region${selection?.id === block.id ? ' is-selected' : ''}`}
                            style={style}
                            data-block-id={block.id}
                            aria-label={`定位译文：${block.target}`}
                            aria-pressed={selection?.id === block.id}
                            onClick={(event) => {
                              event.stopPropagation();
                              selectBlock(block, 'image');
                            }}
                          />
                        );
                      })}
                  </div>
                </>
              )}
            </div>
            <footer className="translation-page-controls">
              <Button
                variant="ghost"
                icon="back"
                aria-label="上一页"
                disabled={pageIndex === 0}
                onClick={() => changePage(pageIndex - 1)}
              >
                上一页
              </Button>
              <span>
                第 {pageNumber} 页
                {result ? ` / 共 ${result.pages.length} 页` : ''}
              </span>
              <Button
                variant="ghost"
                icon="chevron"
                aria-label="下一页"
                disabled={!result || pageIndex >= result.pages.length - 1}
                onClick={() => changePage(pageIndex + 1)}
              >
                下一页
              </Button>
            </footer>
          </section>
          <section className="translation-output" aria-label="中文译文">
            <header className="translation-section-header">
              <div className="translation-output-heading">
                <h3>译文</h3>
                {phase === 'completed' && (
                  <Badge tone={lowConfidenceCount ? 'warning' : 'success'}>
                    {lowConfidenceCount ? '识别待核对' : '翻译完成'}
                  </Badge>
                )}
              </div>
              <div className="translation-output-actions">
                <Button
                  variant="ghost"
                  icon="copy"
                  disabled={!result}
                  onClick={() => void copyText()}
                >
                  复制
                </Button>
                <Button
                  variant="ghost"
                  icon="download"
                  disabled={!result}
                  onClick={downloadText}
                >
                  下载 TXT
                </Button>
              </div>
            </header>
            <div
              className="translation-text-scroll"
              ref={textRef}
              aria-busy={phase === 'translating' || phase === 'loading'}
            >
              {phase === 'completed' && page ? (
                page.blocks.length ? (
                  <ol className="translation-blocks">
                    {page.blocks.map((block, index) => (
                      <li key={block.id}>
                        <button
                          type="button"
                          className={`translation-text-block${selection?.id === block.id ? ' is-selected' : ''}`}
                          data-block-id={block.id}
                          onClick={() => selectBlock(block, 'text')}
                          aria-pressed={selection?.id === block.id}
                        >
                          <span className="translation-block-number">
                            {index + 1}
                          </span>
                          <span className="translation-block-content">
                            <span className="translation-target">
                              {block.target}
                            </span>
                            <span
                              className="translation-source"
                              lang={result?.sourceLanguage}
                            >
                              {block.source}
                            </span>
                            {block.confidence !== undefined &&
                              block.confidence < 0.8 && (
                                <span className="translation-confidence">
                                  <Icon name="alert" size={13} />
                                  识别待核对
                                </span>
                              )}
                          </span>
                          <Icon name="link" size={15} />
                        </button>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="translation-state">
                    <Icon name="file" size={27} />
                    <h3>本页未识别到文字</h3>
                  </div>
                )
              ) : (
                <div
                  className="translation-state"
                  role={phase === 'error' ? 'alert' : 'status'}
                >
                  <Icon
                    name={
                      phase === 'error'
                        ? 'alert'
                        : phase === 'translating' || phase === 'loading'
                          ? 'clock'
                          : 'file'
                    }
                    size={28}
                  />
                  <h3>
                    {phase === 'error'
                      ? '翻译未完成'
                      : phase === 'translating'
                        ? '正在识别并翻译'
                        : phase === 'loading'
                          ? '正在读取译文'
                          : '尚未翻译'}
                  </h3>
                  {phase === 'error' ? (
                    <p>{error}</p>
                  ) : phase === 'translating' ? (
                    <p>关闭窗口后仍会继续处理。</p>
                  ) : null}
                  {(phase === 'ready' || phase === 'error') && (
                    <Button
                      variant="primary"
                      icon={phase === 'error' ? 'refresh' : undefined}
                      onClick={() => void translate()}
                    >
                      {phase === 'error' ? '重新翻译' : '开始翻译'}
                    </Button>
                  )}
                </div>
              )}
            </div>
            <footer className="translation-output-footer">
              <span role="status">
                {actionMessage ||
                  (result
                    ? '机器翻译仅供参考，金额、日期及专有名词请对照原件核对。'
                    : '')}
              </span>
            </footer>
          </section>
        </div>
      )}
      <div className="translation-bottom-bar">
        <span>
          {result
            ? `${result.pages.reduce((total, item) => total + item.blocks.length, 0)} 个文字区域${lowConfidenceCount ? ` · ${lowConfidenceCount} 处识别待核对` : ''}`
            : selectedId
              ? fileName
              : ''}
        </span>
        <details className="translation-guide">
          <summary>
            <Icon name="help" size={15} />
            使用指引
          </summary>
          <div>
            <strong>核对原件与译文</strong>
            <p>
              上传附件后点击“开始翻译”。点击任一译文会定位到原件中的文字区域，也可点击原件中的文字查看对应译文。PDF
              可按页核对，复制和下载均包含全部页面。
            </p>
            <button
              type="button"
              onClick={(event) => {
                const details = event.currentTarget.closest('details');
                if (details) {
                  details.open = false;
                  details.querySelector('summary')?.focus();
                }
              }}
            >
              关闭指引
            </button>
          </div>
        </details>
      </div>
    </div>
  );
}
