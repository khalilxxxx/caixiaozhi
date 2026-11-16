import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  createBlankExpense,
  draftCurrencyTotals,
  expenseNights,
  getExpenseCategories,
  getExpenseCategory,
  switchExpenseCategory,
  type ActivityAssignment,
  type Attachment,
  type ExpenseField,
  type ExpenseItem,
  type SubmissionDraft,
  type TravelLeg,
} from './submission-model';
import { Button, Icon } from './ui';
import { useSlice, useWorkspace } from './workspace';
import { api, uploadFile } from './runtime-client';
import './submission.css';

type Issue = { path: string; message: string };
type ExpenseEditorState = { item: ExpenseItem; isNew: boolean };
type ExpenseEditorDrafts = Partial<
  Record<SubmissionDraft['id'], ExpenseEditorState>
>;
const expenseEditorKey = 'submissionExpenseEditors';
async function queryRelatedDocument(id: string) {
  if (!id.trim()) return '请先填写单号。';
  const result = await api<{
    items: Array<{ id: string; title: string; sourceStatus: string }>;
  }>('/business/documents', { query: id.trim() });
  const document = result.items.find(
    (item) => item.id.toLowerCase() === id.trim().toLowerCase(),
  );
  return document
    ? `${document.title} · ${document.sourceStatus} · 本地模拟业务数据`
    : '本地业务资料未找到该单号，请核对或补充。';
}

const transportOptions = [
  '火车-二等座',
  '火车-一等座',
  '火车-硬座',
  '火车-软座',
  '火车-特等座',
  '火车-硬卧',
  '火车-软卧',
  '火车-高铁动卧',
  '火车-高级软卧',
  '火车-无座',
  '飞机-经济舱',
  '飞机-自订机票',
  '汽车-客车',
  '汽车-自驾车',
  '汽车-公司派车',
  '汽车-出租车',
  '轮船-二等舱',
  '轮船-一等舱',
  '其他-城际地铁',
  '其他-免费搭车',
  '其他-客户代订',
];

const cityTransportOptions = ['出租车', '地铁', '公交车', '其他'];

const activitySamples: ActivityAssignment[] = [
  {
    id: 'sample-activity-1',
    oaNumber: 'OA-202611-018',
    activityNumber: 'ACT-202611-012',
    description: '华东客户产品交流',
    effectiveDate: '2026-11-01',
    expiryDate: '2026-11-30',
    allocation: '',
    oaUrl: '',
    source: 'sample',
  },
  {
    id: 'sample-activity-2',
    oaNumber: 'OA-202611-026',
    activityNumber: 'ACT-202611-019',
    description: '客户现场交付支持',
    effectiveDate: '2026-11-10',
    expiryDate: '2026-12-15',
    allocation: '',
    oaUrl: '',
    source: 'sample',
  },
];

function newId(prefix: string) {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

function FormField({
  label,
  required = false,
  error,
  note,
  wide = false,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  note?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={`sf-field${wide ? ' sf-wide' : ''}`}>
      <span>
        {label}
        {required && <i aria-hidden="true"> *</i>}
      </span>
      {children}
      {error && <small className="sf-field-error">{error}</small>}
      {note && <small className="sf-field-note">{note}</small>}
    </label>
  );
}

function FormSection({
  title,
  action,
  children,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="sf-section">
      <header>
        <h3>{title}</h3>
        {action}
      </header>
      {children}
    </section>
  );
}

function formatAmount(value: string) {
  if (!/^-?\d+(?:\.\d{0,2})?$/.test(value)) return value || '待填写';
  return Number(value).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function decimalAmount(value: string) {
  return /^\d+(?:\.\d{0,2})?$/.test(value) ? Number(value).toFixed(2) : value;
}

function fileSize(size: number) {
  if (!size) return '大小未知';
  return size < 1024 * 1024
    ? `${Math.max(1, Math.round(size / 1024))} KB`
    : `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function expensePeriod(item: ExpenseItem) {
  const template = getExpenseCategory(item.categoryId)?.template;
  if (template === 'T03' || template === 'T09') {
    return `${item.checkIn || '入住待补充'} — ${item.checkOut || '退房待补充'}`;
  }
  if (template === 'T08') {
    return `${item.departureDate || '出发待补充'} — ${item.arrivalDate || '到达待补充'}`;
  }
  return item.date || (template === 'T01' ? '日期见关联行程' : '日期待补充');
}

function checkoutNeedsReview(item: ExpenseItem) {
  const template = getExpenseCategory(item.categoryId)?.template;
  return (
    item.generated &&
    (template === 'T03' || template === 'T09') &&
    !!item.checkOut &&
    item.checkOut !== item.aiCheckOut
  );
}

function FilePicker({
  title,
  files,
  multiple = true,
  onChange,
  onUpload,
  onPreview,
}: {
  title: string;
  files: Attachment[];
  multiple?: boolean;
  onChange: (files: Attachment[]) => void;
  onUpload: (file: File, id: string) => void;
  onPreview: (file: Attachment) => void;
}) {
  const inputId = useId();
  const w = useWorkspace();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  return (
    <div className="sf-files">
      <div className="sf-files-heading">
        <h4>{title}</h4>
        <label className="sf-upload" htmlFor={inputId}>
          <Icon name="upload" size={14} />
          {multiple ? '上传附件' : files.length ? '更换发票' : '上传发票'}
        </label>
        <input
          className="sf-file-input"
          id={inputId}
          type="file"
          multiple={multiple}
          aria-label={multiple ? `上传${title}` : '上传或更换发票'}
          disabled={uploading}
          onChange={async (event) => {
            const selected = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            if (!selected.length) return;
            setUploading(true);
            setUploadError('');
            const attachments: Attachment[] = [];
            try {
              await w.flush();
              for (const local of selected) {
                const { file } = await uploadFile(local);
                attachments.push({
                  id: file.id,
                  name: file.name,
                  size: file.size,
                  type: file.type,
                });
                onUpload(local, file.id);
              }
              await w.refresh();
            } catch (error) {
              setUploadError(
                error instanceof Error ? error.message : '附件上传失败，请重试',
              );
            } finally {
              if (attachments.length)
                onChange(
                  multiple
                    ? [...files, ...attachments]
                    : attachments.slice(0, 1),
                );
              setUploading(false);
            }
          }}
        />
      </div>
      {uploading && <p role="status">附件上传中…</p>}
      {uploadError && (
        <p className="field-error" role="alert">
          {uploadError}
        </p>
      )}
      {files.length ? (
        <ul className="sf-file-list">
          {files.map((file) => (
            <li key={file.id}>
              <Icon name="file" size={17} />
              <button
                type="button"
                className="sf-file-name"
                onClick={() => onPreview(file)}
              >
                <strong>{file.name}</strong>
                <small>
                  {fileSize(file.size)} · {file.type || '文件'}
                </small>
              </button>
              <button
                className="sf-icon-button"
                type="button"
                aria-label={`移除${file.name}`}
                onClick={() =>
                  onChange(files.filter((value) => value.id !== file.id))
                }
              >
                <Icon name="close" size={15} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="sf-empty-inline">尚未添加{title}</p>
      )}
      {!multiple && files.length > 0 && (
        <p className="sf-source-line">已关联文件 · 尚未取得发票查验结果</p>
      )}
    </div>
  );
}

function LegFields({
  legs,
  onChange,
  issues,
}: {
  legs: TravelLeg[];
  onChange: (legs: TravelLeg[]) => void;
  issues: Issue[];
}) {
  function changeLeg(index: number, field: keyof TravelLeg, value: string) {
    onChange(
      legs.map((leg, current) =>
        current === index ? { ...leg, [field]: value } : leg,
      ),
    );
  }
  function moveLeg(index: number, offset: number) {
    const reordered = [...legs];
    const [leg] = reordered.splice(index, 1);
    reordered.splice(index + offset, 0, leg!);
    onChange(reordered);
  }
  return (
    <div className="sf-leg-list">
      {legs.map((leg, index) => (
        <details className="sf-leg" key={leg.id} open={index === 0}>
          <summary>
            <Icon name="plane" size={16} />
            <span>
              <strong>
                {leg.departureCity || '出发城市待填'} →{' '}
                {leg.arrivalCity || '到达城市待填'}
              </strong>
              <small>
                {leg.departureDate || '出发日期待填'} —{' '}
                {leg.arrivalDate || '到达日期待填'}
              </small>
            </span>
            <Icon name="down" size={15} />
          </summary>
          <div className="sf-leg-body">
            <div className="sf-grid">
              {(
                [
                  ['departureCity', '出发城市', 'text'],
                  ['arrivalCity', '到达城市', 'text'],
                  ['departureDate', '出发日期', 'date'],
                  ['arrivalDate', '到达日期', 'date'],
                ] as const
              ).map(([field, label, type]) => (
                <FormField
                  label={label}
                  required
                  key={field}
                  error={
                    issues.find(
                      (issue) => issue.path === `legs.${index}.${field}`,
                    )?.message
                  }
                >
                  <input
                    type={type}
                    aria-label={`第${index + 1}段${label}`}
                    value={leg[field]}
                    onChange={(event) =>
                      changeLeg(index, field, event.target.value)
                    }
                  />
                </FormField>
              ))}
              <FormField
                label="交通工具及席别"
                required
                wide
                error={
                  issues.find(
                    (issue) => issue.path === `legs.${index}.transport`,
                  )?.message
                }
              >
                <select
                  aria-label={`第${index + 1}段交通工具及席别`}
                  value={leg.transport}
                  onChange={(event) =>
                    changeLeg(index, 'transport', event.target.value)
                  }
                >
                  <option value="">请选择</option>
                  {leg.transport &&
                    !transportOptions.includes(leg.transport) && (
                      <option>{leg.transport}</option>
                    )}
                  {transportOptions.map((option) => (
                    <option key={option}>{option}</option>
                  ))}
                </select>
              </FormField>
            </div>
            <div className="sf-row-actions">
              <button
                type="button"
                className="sf-text-button"
                disabled={index === 0}
                onClick={() => moveLeg(index, -1)}
                aria-label={`上移第${index + 1}段行程`}
              >
                <Icon name="up" size={13} />
                上移
              </button>
              <button
                type="button"
                className="sf-text-button"
                disabled={index === legs.length - 1}
                onClick={() => moveLeg(index, 1)}
                aria-label={`下移第${index + 1}段行程`}
              >
                <Icon name="down" size={13} />
                下移
              </button>
              <button
                type="button"
                className="sf-text-button sf-delete"
                onClick={() =>
                  onChange(legs.filter((value) => value.id !== leg.id))
                }
                aria-label={`删除第${index + 1}段行程`}
              >
                <Icon name="trash" size={13} />
                删除
              </button>
            </div>
          </div>
        </details>
      ))}
      {!legs.length && <p className="sf-empty-inline">尚未添加行程</p>}
      {issues
        .filter((issue) => issue.path === 'legs')
        .map((issue) => (
          <p className="sf-error" key={issue.message}>
            {issue.message}
          </p>
        ))}
    </div>
  );
}

function ActivityFields({
  draft,
  onChange,
  issues,
}: {
  draft: SubmissionDraft;
  onChange: (draft: SubmissionDraft) => void;
  issues: Issue[];
}) {
  function updateActivity(
    index: number,
    field: keyof ActivityAssignment,
    value: string,
  ) {
    onChange({
      ...draft,
      activities: draft.activities.map((activity, current) =>
        current === index
          ? { ...activity, [field]: value, source: 'manual' }
          : activity,
      ),
    });
  }
  return (
    <FormSection
      title={
        <>
          活动／派工
          {draft.activityMode === 'required' && (
            <i className="sf-required"> *</i>
          )}
        </>
      }
      action={
        <Button
          variant="ghost"
          icon="plus"
          onClick={() =>
            onChange({
              ...draft,
              activities: [
                ...draft.activities,
                {
                  id: newId('activity'),
                  oaNumber: '',
                  activityNumber: '',
                  description: '',
                  effectiveDate: '',
                  expiryDate: '',
                  allocation: '',
                  oaUrl: '',
                  source: 'manual',
                },
              ],
            })
          }
        >
          添加
        </Button>
      }
    >
      {draft.activities.map((activity, index) => (
        <details className="sf-activity" open={index === 0} key={activity.id}>
          <summary>
            <span>
              {activity.description ||
                activity.activityNumber ||
                '未填写活动／派工'}
            </span>
            <Icon name="down" size={15} />
          </summary>
          <div className="sf-activity-body">
            <FormField label="选择活动／派工">
              <select
                aria-label={`第${index + 1}项活动记录来源`}
                value={
                  activity.source === 'sample'
                    ? activitySamples.find(
                        (sample) =>
                          sample.activityNumber === activity.activityNumber,
                      )?.id || ''
                    : ''
                }
                onChange={(event) => {
                  const sample = activitySamples.find(
                    (value) => value.id === event.target.value,
                  );
                  if (sample)
                    onChange({
                      ...draft,
                      activities: draft.activities.map((value, current) =>
                        current === index ? { ...sample, id: value.id } : value,
                      ),
                    });
                  else
                    onChange({
                      ...draft,
                      activities: draft.activities.map((value, current) =>
                        current === index
                          ? { ...value, source: 'manual' }
                          : value,
                      ),
                    });
                }}
              >
                <option value="">手工录入外部记录</option>
                {activitySamples.map((sample) => (
                  <option value={sample.id} key={sample.id}>
                    {sample.activityNumber} · {sample.description}（样例）
                  </option>
                ))}
              </select>
            </FormField>
            <p className="sf-source-line">
              {activity.source === 'sample'
                ? '来源为样例活动记录'
                : '手工录入 · 外部记录待核验'}
            </p>
            <div className="sf-grid">
              {(
                [
                  ['oaNumber', 'OA单号／工程PS号', 'text'],
                  ['activityNumber', '活动号', 'text'],
                  ['effectiveDate', '生效日期', 'date'],
                  ['expiryDate', '截止日期', 'date'],
                  ['allocation', '比例／工时', 'text'],
                  ['oaUrl', 'OA 链接', 'url'],
                ] as const
              ).map(([field, label, type]) => (
                <FormField
                  label={label}
                  required={field === 'effectiveDate' || field === 'expiryDate'}
                  key={field}
                  error={
                    issues.find(
                      (issue) => issue.path === `activities.${index}.${field}`,
                    )?.message
                  }
                >
                  <input
                    type={type}
                    aria-label={`第${index + 1}项${label}`}
                    inputMode={field === 'allocation' ? 'decimal' : undefined}
                    value={activity[field]}
                    onChange={(event) =>
                      updateActivity(index, field, event.target.value)
                    }
                  />
                </FormField>
              ))}
              <FormField
                label="活动说明"
                wide
                error={
                  issues.find(
                    (issue) => issue.path === `activities.${index}.description`,
                  )?.message
                }
              >
                <input
                  aria-label={`第${index + 1}项活动说明`}
                  value={activity.description}
                  onChange={(event) =>
                    updateActivity(index, 'description', event.target.value)
                  }
                />
              </FormField>
            </div>
            <div className="sf-row-actions">
              <button
                type="button"
                className="sf-text-button sf-delete"
                onClick={() =>
                  onChange({
                    ...draft,
                    activities: draft.activities.filter(
                      (value) => value.id !== activity.id,
                    ),
                  })
                }
              >
                <Icon name="trash" size={13} />
                删除活动
              </button>
            </div>
          </div>
        </details>
      ))}
      {!draft.activities.length && (
        <p className="sf-empty-inline">
          未关联活动／派工{draft.activityMode === 'required' ? '，请添加' : ''}
        </p>
      )}
      {issues
        .filter((issue) => issue.path === 'activities')
        .map((issue) => (
          <p className="sf-error" key={issue.message}>
            {issue.message}
          </p>
        ))}
    </FormSection>
  );
}

function ExpenseEditor({
  item,
  draft,
  onChange,
  onSave,
  onCancel,
  onUpload,
  onPreview,
}: {
  item: ExpenseItem;
  draft: SubmissionDraft;
  onChange: (item: ExpenseItem) => void;
  onSave: () => void;
  onCancel: () => void;
  onUpload: (file: File, id: string) => void;
  onPreview: (file: Attachment) => void;
}) {
  const w = useWorkspace();
  const categories = getExpenseCategories(draft.id);
  const category = getExpenseCategory(item.categoryId);
  const template = category?.template;
  const [selectedGroup, setSelectedGroup] = useState(category?.group || '');
  const [oaQueryStatus, setOaQueryStatus] = useState('');
  const editorElement = useRef<HTMLDivElement>(null);
  const groups = [...new Set(categories.map((value) => value.group))];
  const groupCategories = categories.filter(
    (value) => value.group === selectedGroup,
  );
  const otherGroups = [
    ...new Set(groupCategories.map((value) => value.otherGroup || '')),
  ];
  const fieldIds = useId();
  const required = (field: ExpenseField) =>
    category?.requiredFields.includes(field) ??
    ['date', 'currency', 'amount', 'reason'].includes(field);

  useEffect(() => {
    editorElement.current?.scrollIntoView({ block: 'start' });
    editorElement.current
      ?.querySelector<HTMLSelectElement>('select')
      ?.focus({ preventScroll: true });
  }, []);

  function change(field: ExpenseField, value: string) {
    onChange({ ...item, [field]: value });
  }

  function input(
    field: ExpenseField,
    label: string,
    options: {
      type?: string;
      numeric?: boolean;
      wide?: boolean;
      note?: string;
      readOnly?: boolean;
      value?: string;
    } = {},
  ) {
    const value = options.value ?? item[field];
    const error =
      required(field) && !value
        ? `请填写${label.replace(/（.*?）/g, '')}`
        : undefined;
    return (
      <FormField
        key={field}
        label={label}
        required={required(field)}
        wide={options.wide}
        error={error}
        note={options.note}
      >
        <input
          aria-label={`费用${label}`}
          type={options.type || 'text'}
          inputMode={options.numeric ? 'numeric' : undefined}
          list={
            ['city', 'departureCity', 'arrivalCity'].includes(field)
              ? `${fieldIds}-cities`
              : undefined
          }
          value={value}
          readOnly={options.readOnly}
          onChange={(event) => change(field, event.target.value)}
        />
      </FormField>
    );
  }

  function transportField() {
    const options =
      template === 'T02' ? cityTransportOptions : transportOptions;
    return (
      <FormField
        label="交通工具"
        required={required('transport')}
        error={
          required('transport') && !item.transport
            ? '请选择交通工具'
            : undefined
        }
      >
        <select
          aria-label="费用交通工具"
          value={item.transport}
          onChange={(event) => change('transport', event.target.value)}
        >
          <option value="">请选择</option>
          {item.transport && !options.includes(item.transport) && (
            <option>{item.transport}</option>
          )}
          {options.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      </FormField>
    );
  }

  const travelFields = (
    <>
      {input('departureDate', '出发日期', { type: 'date' })}
      {input('arrivalDate', '到达日期', { type: 'date' })}
      {input('departureCity', '出发城市')}
      {input('arrivalCity', '到达城市')}
      {transportField()}
    </>
  );
  const accommodation = template === 'T03' || template === 'T09';
  const reception =
    template === 'T04' ||
    template === 'T05' ||
    template === 'T06' ||
    template === 'T07';
  const linkedLeg = draft.legs.find((leg) => leg.id === item.tripId);
  const nights = expenseNights(item);

  return (
    <div
      className="sf-expense-editor"
      ref={editorElement}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="sf-editor-heading">
        <h4>{item.name || category?.label || '新增费用'}</h4>
        <button
          className="sf-icon-button"
          type="button"
          aria-label="取消费用编辑"
          onClick={onCancel}
        >
          <Icon name="close" size={17} />
        </button>
      </div>
      <div className="sf-grid sf-type-grid">
        <FormField label="费用大类" required>
          <select
            aria-label="费用大类"
            value={selectedGroup}
            onChange={(event) => {
              const group = event.target.value;
              setSelectedGroup(group);
              const targets = categories.filter(
                (value) => value.group === group,
              );
              if (targets.length === 1)
                onChange(switchExpenseCategory(item, targets[0]!.id));
            }}
          >
            <option value="">请选择</option>
            {groups.map((group) => (
              <option key={group}>{group}</option>
            ))}
          </select>
        </FormField>
        <FormField
          label={reception ? '招待类型' : '费用类型'}
          required
          error={!item.categoryId ? '请选择费用类型' : undefined}
        >
          <select
            aria-label="费用类型"
            value={category?.group === selectedGroup ? item.categoryId : ''}
            onChange={(event) => {
              if (event.target.value)
                onChange(switchExpenseCategory(item, event.target.value));
            }}
            disabled={!selectedGroup}
          >
            <option value="">请选择</option>
            {otherGroups.map((group) =>
              group ? (
                <optgroup label={group} key={group}>
                  {groupCategories
                    .filter((value) => value.otherGroup === group)
                    .map((value) => (
                      <option value={value.id} key={value.id}>
                        {value.label}
                      </option>
                    ))}
                </optgroup>
              ) : (
                groupCategories
                  .filter((value) => !value.otherGroup)
                  .map((value) => (
                    <option value={value.id} key={value.id}>
                      {value.label}
                    </option>
                  ))
              ),
            )}
          </select>
        </FormField>
      </div>
      {item.generated && (
        <div className="sf-ai-source">
          <Icon name="spark" size={16} />
          <span>本费用由 AI 生成，请核对后提交</span>
        </div>
      )}
      <div className="sf-grid">
        {template === 'T01' && (
          <>
            <FormField
              label="关联行程"
              required
              wide
              error={!item.tripId ? '请选择行程' : undefined}
            >
              <select
                aria-label="费用关联行程"
                value={item.tripId}
                onChange={(event) => change('tripId', event.target.value)}
              >
                <option value="">请选择</option>
                {item.tripId && !linkedLeg && (
                  <option value={item.tripId}>
                    {item.tripId}（原关联记录待核验）
                  </option>
                )}
                {draft.legs.map((leg) => (
                  <option key={leg.id} value={leg.id}>
                    {leg.departureCity || '待填'} → {leg.arrivalCity || '待填'}{' '}
                    · {leg.departureDate || '日期待填'} ·{' '}
                    {leg.transport || '交通工具待填'}
                  </option>
                ))}
              </select>
            </FormField>
            {linkedLeg && (
              <p className="sf-linked-summary sf-wide">
                关联行程　{linkedLeg.departureCity} → {linkedLeg.arrivalCity} ·{' '}
                {linkedLeg.departureDate} — {linkedLeg.arrivalDate} ·{' '}
                {linkedLeg.transport}
              </p>
            )}
            {travelFields}
          </>
        )}
        {template === 'T08' && travelFields}
        {accommodation && (
          <>
            {input('checkIn', '入住日期', { type: 'date' })}
            {input('checkOut', '退房日期', {
              type: 'date',
              note: checkoutNeedsReview(item)
                ? '退房日期由您补充或修改，请核对'
                : undefined,
            })}
            {input('city', '住宿城市')}
            {input('rooms', '房间数', { numeric: true })}
            {input('nights', '住宿天数', {
              value: nights > 0 ? String(nights) : '',
              readOnly: true,
            })}
            {template === 'T03' && (
              <FormField label="是否租房">
                <select
                  aria-label="费用是否租房"
                  value={item.rental}
                  onChange={(event) => change('rental', event.target.value)}
                >
                  <option value="">请选择</option>
                  <option value="否">否（非租房）</option>
                  <option value="是">是（租房）</option>
                  {item.rental && !['否', '是'].includes(item.rental) && (
                    <option value={item.rental}>{item.rental}</option>
                  )}
                </select>
              </FormField>
            )}
            {input('coResidents', '合住人', { wide: true })}
          </>
        )}
        {!accommodation &&
          template !== 'T01' &&
          template !== 'T08' &&
          input('date', '日期', { type: 'date' })}
        {template === 'T02' && transportField()}
        {(template === 'T04' || template === 'T05') &&
          input('standard', '接待标准')}
        {template === 'T04' && (
          <>
            {input('city', '城市')}
            {input('rooms', '房间数', { numeric: true })}
            {input('nights', '天数', { numeric: true })}
          </>
        )}
        {(template === 'T05' || template === 'T06' || template === 'T07') &&
          input('people', '人数', { numeric: true })}
        {template === 'T07' && input('quantity', '采购数量', { numeric: true })}
        {template === 'T05' && required('oaId') && (
          <>
            <FormField
              label="OA 单号"
              required
              wide
              error={!item.oaId ? '请关联用餐申请' : undefined}
            >
              <div className="sf-input-action">
                <input
                  aria-label="费用OA单号"
                  value={item.oaId}
                  onChange={(event) => change('oaId', event.target.value)}
                />
                <Button
                  onClick={async () => {
                    setOaQueryStatus('查询中…');
                    try {
                      await w.flush();
                      setOaQueryStatus(await queryRelatedDocument(item.oaId));
                    } catch (error) {
                      setOaQueryStatus(
                        error instanceof Error
                          ? error.message
                          : '查询失败，请重试',
                      );
                    }
                  }}
                >
                  查询
                </Button>
                {item.oaId && (
                  <Button variant="ghost" onClick={() => change('oaId', '')}>
                    解除
                  </Button>
                )}
              </div>
            </FormField>
            <p
              className="sf-source-line sf-wide"
              role={oaQueryStatus ? 'status' : undefined}
            >
              {oaQueryStatus ||
                (item.oaId
                  ? '已保留 OA 关联标识 · 外部记录待核验'
                  : '尚未关联用餐申请')}
            </p>
          </>
        )}
        <FormField
          label="币种"
          required
          error={!item.currency ? '请选择币种' : undefined}
        >
          <select
            aria-label="费用币种"
            value={item.currency}
            onChange={(event) => change('currency', event.target.value)}
          >
            <option value="">请选择</option>
            {item.currency &&
              !['CNY', 'USD', 'EUR', 'HKD', 'JPY', 'GBP'].includes(
                item.currency,
              ) && <option>{item.currency}</option>}
            {['CNY', 'USD', 'EUR', 'HKD', 'JPY', 'GBP'].map((currency) => (
              <option key={currency}>{currency}</option>
            ))}
          </select>
        </FormField>
        <FormField
          label="金额"
          required
          error={
            !item.amount
              ? '请填写金额'
              : /^\d+(?:\.\d{1,2})?$/.test(item.amount)
                ? undefined
                : '请填写非负且最多两位小数的金额'
          }
        >
          <input
            aria-label="费用金额"
            inputMode="decimal"
            value={item.amount}
            onChange={(event) => change('amount', event.target.value)}
            onBlur={() => change('amount', decimalAmount(item.amount))}
          />
        </FormField>
        <FormField label="事由选项" required={required('reason')}>
          <select
            aria-label="费用事由选项"
            value={item.reasonOption}
            onChange={(event) =>
              onChange({ ...item, reasonOption: event.target.value })
            }
          >
            <option value="">请选择</option>
            {item.reasonOption && item.reasonOption !== '其他' && (
              <option>{item.reasonOption}</option>
            )}
            <option value="其他">其他</option>
          </select>
        </FormField>
        <FormField
          label="自定义事由"
          required={required('reason')}
          wide
          error={
            required('reason') && !item.reason.trim() ? '请填写事由' : undefined
          }
        >
          <textarea
            aria-label="费用自定义事由"
            rows={2}
            value={item.reason}
            onChange={(event) =>
              onChange({
                ...item,
                reason: event.target.value,
                reasonOption: event.target.value ? '其他' : item.reasonOption,
              })
            }
          />
        </FormField>
      </div>
      <FilePicker
        title="发票"
        files={item.files}
        multiple={false}
        onChange={(files) => onChange({ ...item, files })}
        onUpload={onUpload}
        onPreview={onPreview}
      />
      <FilePicker
        title="补充附件"
        files={item.attachments}
        onChange={(attachments) => onChange({ ...item, attachments })}
        onUpload={onUpload}
        onPreview={onPreview}
      />
      <div className="sf-editor-actions">
        <Button onClick={onCancel}>取消</Button>
        <Button variant="primary" icon="check" onClick={onSave}>
          保存费用
        </Button>
      </div>
      <datalist id={`${fieldIds}-cities`}>
        {['北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '南京'].map(
          (city) => (
            <option value={city} key={city} />
          ),
        )}
      </datalist>
    </div>
  );
}

export function SubmissionFields({
  draft,
  onChange,
  issues = [],
  onEditingChange,
}: {
  draft: SubmissionDraft;
  onChange: (draft: SubmissionDraft) => void;
  issues?: Issue[];
  onEditingChange?: (editing: boolean) => void;
}) {
  const w = useWorkspace();
  const [expenseEditors, setExpenseEditors] = useSlice<ExpenseEditorDrafts>(
    expenseEditorKey,
    {},
  );
  const editor = expenseEditors[draft.id] ?? null;
  const [companion, setCompanion] = useState('');
  const [companionError, setCompanionError] = useState('');
  const [applicationQueryStatus, setApplicationQueryStatus] = useState('');
  const [previewFile, setPreviewFile] = useState<Attachment | null>(null);
  const fileUrls = useRef(new Map<string, string>());
  const previousDraftId = useRef(draft.id);
  const expenseTrigger = useRef<HTMLButtonElement | null>(null);
  const filePreviewElement = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (previousDraftId.current !== draft.id) {
      previousDraftId.current = draft.id;
      setPreviewFile(null);
      setApplicationQueryStatus('');
      setCompanion('');
      setCompanionError('');
    }
  }, [draft.id]);

  useEffect(() => {
    onEditingChange?.(!!editor);
    return () => onEditingChange?.(false);
  }, [!!editor, onEditingChange]);

  useEffect(() => {
    const urls = fileUrls.current;
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  useEffect(() => {
    if (previewFile)
      filePreviewElement.current?.scrollIntoView({ block: 'nearest' });
  }, [previewFile]);

  function setEditor(next: ExpenseEditorState | null) {
    setExpenseEditors((previous) => {
      const editors = { ...previous };
      if (next) editors[draft.id] = next;
      else delete editors[draft.id];
      return editors;
    });
  }

  function closeEditor() {
    setEditor(null);
    requestAnimationFrame(() => expenseTrigger.current?.focus());
  }

  function change(field: keyof SubmissionDraft, value: unknown) {
    onChange({ ...draft, [field]: value });
  }

  function addLeg() {
    change('legs', [
      ...draft.legs,
      {
        id: newId('leg'),
        departureCity: '',
        arrivalCity: '',
        departureDate: '',
        arrivalDate: '',
        transport: '',
      },
    ]);
  }

  function addCompanion() {
    const name = companion.trim();
    if (!name) {
      setCompanionError('请填写同行人姓名');
      return;
    }
    if (draft.companions.includes(name) || name === draft.applicant) {
      setCompanionError('该人员已在申请中');
      return;
    }
    change('companions', [...draft.companions, name]);
    setCompanion('');
    setCompanionError('');
  }

  const currencyTotals = draftCurrencyTotals(draft);

  return (
    <div className="sf-fields">
      <FormSection title="基本信息">
        <div className="sf-grid">
          {(
            [
              ['applicant', '申请人'],
              ['department', '所属部门'],
              ['paymentCompany', '付款公司'],
            ] as const
          ).map(([field, label]) => (
            <FormField
              label={label}
              required
              key={field}
              error={issues.find((issue) => issue.path === field)?.message}
            >
              <input aria-label={label} value={draft[field]} readOnly />
            </FormField>
          ))}
          {draft.id !== 'personal' && (
            <FormField
              label="差旅类型"
              required={draft.id === 'travel'}
              error={
                issues.find((issue) => issue.path === 'travelType')?.message
              }
            >
              <select
                aria-label="差旅类型"
                value={draft.travelType}
                onChange={(event) => change('travelType', event.target.value)}
              >
                <option value="">请选择</option>
                {draft.travelType &&
                  !['普通差旅', '短期异地办公'].includes(draft.travelType) && (
                    <option>{draft.travelType}</option>
                  )}
                <option>普通差旅</option>
                <option>短期异地办公</option>
              </select>
            </FormField>
          )}
          <FormField
            label="单据事由"
            required
            wide
            error={issues.find((issue) => issue.path === 'purpose')?.message}
          >
            <textarea
              aria-label="单据事由"
              rows={2}
              value={draft.purpose}
              onChange={(event) => change('purpose', event.target.value)}
            />
          </FormField>
        </div>
      </FormSection>

      {draft.id === 'expense' && (
        <FormSection title="差旅申请关联">
          <FormField
            label="申请单号"
            required
            error={
              issues.find((issue) => issue.path === 'applicationId')?.message
            }
          >
            <div className="sf-input-action">
              <input
                aria-label="差旅申请单号"
                value={draft.applicationId}
                onChange={(event) => {
                  change('applicationId', event.target.value);
                  setApplicationQueryStatus('');
                }}
              />
              <Button
                icon="search"
                onClick={async () => {
                  setApplicationQueryStatus('查询中…');
                  try {
                    await w.flush();
                    setApplicationQueryStatus(
                      await queryRelatedDocument(draft.applicationId),
                    );
                  } catch (error) {
                    setApplicationQueryStatus(
                      error instanceof Error
                        ? error.message
                        : '查询失败，请重试',
                    );
                  }
                }}
              >
                查询
              </Button>
            </div>
          </FormField>
          {(applicationQueryStatus || draft.applicationId) && (
            <p
              className="sf-source-line"
              role={applicationQueryStatus ? 'status' : undefined}
            >
              {applicationQueryStatus || '已保留关联申请单号 · 待核验'}
            </p>
          )}
        </FormSection>
      )}

      {draft.id !== 'personal' && (
        <FormSection
          title={draft.id === 'travel' ? '差旅行程' : '实际行程'}
          action={
            <Button variant="ghost" icon="plus" onClick={addLeg}>
              添加行程
            </Button>
          }
        >
          {draft.legacyPeriod && (
            <p className="sf-source-line sf-legacy-period">
              原草稿期间 {draft.legacyPeriod.start || '待补充'} 至{' '}
              {draft.legacyPeriod.end || '待补充'}
            </p>
          )}
          <LegFields
            legs={draft.legs}
            onChange={(legs) => change('legs', legs)}
            issues={issues}
          />
        </FormSection>
      )}

      {draft.activityMode !== 'hidden' && (
        <ActivityFields draft={draft} onChange={onChange} issues={issues} />
      )}

      {draft.id === 'travel' && (
        <FormSection title="同行人">
          <div className="sf-companion-input">
            <FormField label="姓名" error={companionError}>
              <input
                aria-label="同行人姓名"
                value={companion}
                onChange={(event) => {
                  setCompanion(event.target.value);
                  setCompanionError('');
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addCompanion();
                  }
                }}
              />
            </FormField>
            <Button icon="plus" onClick={addCompanion}>
              添加
            </Button>
          </div>
          {draft.companions.length > 0 && (
            <ul className="sf-companions">
              {draft.companions.map((name) => (
                <li key={name}>
                  <span>{name}</span>
                  <button
                    className="sf-icon-button"
                    type="button"
                    aria-label={`移除同行人${name}`}
                    onClick={() =>
                      change(
                        'companions',
                        draft.companions.filter((value) => value !== name),
                      )
                    }
                  >
                    <Icon name="close" size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </FormSection>
      )}

      {draft.id !== 'travel' && (
        <FormSection
          title="报销费用"
          action={
            <Button
              variant="ghost"
              icon="plus"
              disabled={!!editor}
              onClick={(event) => {
                expenseTrigger.current = event.currentTarget;
                setEditor({ item: createBlankExpense(), isNew: true });
              }}
            >
              新增费用
            </Button>
          }
        >
          <div className="sf-expense-list">
            {draft.expenses.map((item, index) => {
              const category = getExpenseCategory(item.categoryId);
              const missing =
                !category ||
                category.requiredFields.some((field) => !item[field]?.trim());
              const itemIssues = issues.filter((issue) =>
                issue.path.startsWith(`expenses.${index}.`),
              );
              const review = checkoutNeedsReview(item);
              return (
                <div
                  className={`sf-expense-row${editor?.item.id === item.id ? ' is-editing' : ''}`}
                  key={item.id}
                >
                  <button
                    type="button"
                    className="sf-expense-open"
                    disabled={!!editor}
                    onClick={(event) => {
                      expenseTrigger.current = event.currentTarget;
                      setEditor({
                        item: {
                          ...item,
                          files: [...item.files],
                          attachments: [...item.attachments],
                        },
                        isNew: false,
                      });
                    }}
                    aria-label={`编辑${category?.label || item.name || '费用'}`}
                  >
                    <span className="sf-expense-copy">
                      <strong>
                        {category?.label || item.name || '待选费用类型'}
                        {(missing || itemIssues.length > 0 || review) && (
                          <span
                            className="sf-expense-warning"
                            title={[
                              missing ? '待完善' : '',
                              ...itemIssues.map((issue) => issue.message),
                              review ? '退房日期待核对' : '',
                            ]
                              .filter(Boolean)
                              .join('，')}
                          >
                            <Icon name="alert" size={13} />
                            <span>
                              {missing || itemIssues.length
                                ? '待完善'
                                : '待核对'}
                            </span>
                          </span>
                        )}
                      </strong>
                      <small>{expensePeriod(item)}</small>
                      <span className="sf-expense-reason" title={item.reason}>
                        {item.reason || '事由待补充'}
                      </span>
                      <small>
                        {item.files.length
                          ? `${item.files.length}份发票`
                          : '无发票'}{' '}
                        · {item.attachments.length}份附件 · 超标金额待系统核定
                      </small>
                    </span>
                    <span className="sf-expense-money">
                      <small>{item.currency || '币种待选'}</small>
                      <strong>{formatAmount(item.amount)}</strong>
                    </span>
                    <Icon name="chevron" size={15} />
                  </button>
                  <button
                    type="button"
                    className="sf-icon-button sf-delete"
                    aria-label={`删除${category?.label || item.name || '费用'}`}
                    disabled={!!editor}
                    onClick={() =>
                      change(
                        'expenses',
                        draft.expenses.filter((value) => value.id !== item.id),
                      )
                    }
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              );
            })}
            {!draft.expenses.length && !editor && (
              <p className="sf-empty-inline">尚未添加费用</p>
            )}
          </div>
          {editor && (
            <ExpenseEditor
              key={editor.item.id}
              item={editor.item}
              draft={draft}
              onChange={(item) => setEditor({ ...editor, item })}
              onCancel={closeEditor}
              onSave={() => {
                const item = {
                  ...editor.item,
                  amount: decimalAmount(editor.item.amount),
                };
                change(
                  'expenses',
                  editor.isNew
                    ? [...draft.expenses, item]
                    : draft.expenses.map((value) =>
                        value.id === item.id ? item : value,
                      ),
                );
                closeEditor();
              }}
              onUpload={(file, id) =>
                fileUrls.current.set(id, URL.createObjectURL(file))
              }
              onPreview={setPreviewFile}
            />
          )}
          {issues
            .filter((issue) => issue.path === 'expenses')
            .map((issue) => (
              <p className="sf-error" key={issue.message}>
                {issue.message}
              </p>
            ))}
          {currencyTotals.length > 0 && (
            <div className="sf-totals">
              <span>报销合计</span>
              <div>
                {currencyTotals.map(({ currency, amountCents }) => (
                  <strong key={currency}>
                    <small>{currency}</small>
                    {formatAmount((amountCents / 100).toFixed(2))}
                  </strong>
                ))}
              </div>
            </div>
          )}
          {draft.id === 'expense' && draft.subsidyCents !== null && (
            <div className="sf-subsidy">
              <span>差旅补助</span>
              <strong>
                CNY {formatAmount((draft.subsidyCents / 100).toFixed(2))}
              </strong>
              <small>来源为已保存补助金额</small>
            </div>
          )}
        </FormSection>
      )}

      <FormSection title="单据附件">
        <FilePicker
          title="附件"
          files={draft.files}
          onChange={(files) => change('files', files)}
          onUpload={(file, id) =>
            fileUrls.current.set(id, URL.createObjectURL(file))
          }
          onPreview={setPreviewFile}
        />
      </FormSection>

      {previewFile && (
        <div className="sf-file-preview" ref={filePreviewElement}>
          <header>
            <strong>{previewFile.name}</strong>
            <button
              className="sf-icon-button"
              type="button"
              aria-label="关闭文件信息"
              onClick={() => setPreviewFile(null)}
            >
              <Icon name="close" size={16} />
            </button>
          </header>
          <p>
            {fileSize(previewFile.size)} · {previewFile.type || '文件'}
          </p>
          {fileUrls.current.has(previewFile.id) ? (
            <a
              href={fileUrls.current.get(previewFile.id)}
              target="_blank"
              rel="noreferrer"
            >
              打开文件原件
              <Icon name="arrow" size={13} />
            </a>
          ) : previewFile.id.startsWith('file-') ? (
            <a
              href={`/api/local/files/${encodeURIComponent(previewFile.id)}/download`}
              target="_blank"
              rel="noreferrer"
            >
              打开文件原件
              <Icon name="arrow" size={13} />
            </a>
          ) : (
            <p>本地合成材料，仅保存业务字段，无原始文件。</p>
          )}
        </div>
      )}
    </div>
  );
}
