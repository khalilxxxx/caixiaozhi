import {
  presentDocument,
  type DocumentStep,
  type GenericDocument,
} from '../document-query/document-model';

function actorNames(values: readonly string[] = []) {
  return [...new Set(values.map((actor) => actor.trim()).filter(Boolean))];
}

function currentRole(doc: GenericDocument) {
  if (doc.status === 'needs_action') return '待处理人';
  if (doc.phase === 'execution') return '办理方';
  return doc.phase === 'approval' ? '当前审批人' : '处理人';
}

export function getDocumentProgress(doc: GenericDocument) {
  const active = doc.status === 'processing' || doc.status === 'needs_action';
  const steps = active
    ? (doc.steps ?? []).filter((step) => step.status === 'current')
    : [];
  const current = active ? doc.current : undefined;
  const pendingActors =
    current?.actors ?? steps.flatMap((step) => step.actors ?? []);
  const actors = actorNames(pendingActors);
  const status = presentDocument(doc).displayStatus;
  const node =
    current?.label ||
    [...new Set(steps.map((step) => step.label))].join('、') ||
    doc.phaseLabel ||
    status;
  const role = currentRole(doc);
  const tone =
    doc.status === 'needs_action'
      ? 'warning'
      : doc.status === 'completed'
        ? 'success'
        : doc.status === 'processing'
          ? 'blue'
          : 'neutral';
  return { node, actors, role, status, tone } as const;
}

function stepTimestamp(time: string | undefined, asOf: number) {
  if (!time) return -Infinity;
  if (/^\d{4}-\d{2}-\d{2}/.test(time)) {
    const instant = Date.parse(time);
    return Number.isFinite(instant) ? instant : -Infinity;
  }
  // Older adapters store a Shanghai month/day and time. Anchor that label
  // to the snapshot for ordering only, including a December/January rollover.
  const match =
    /^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})(?:\s*起)?$/.exec(
      time.trim(),
    );
  if (!match) return -Infinity;
  const [, year, month, day, hour, minute] = match;
  const snapshotYear = Number.isFinite(asOf)
    ? new Date(asOf + 8 * 3600000).getUTCFullYear()
    : 2000;
  const timestamp = (y: number) =>
    Date.UTC(
      y,
      Number(month) - 1,
      Number(day),
      Number(hour) - 8,
      Number(minute),
    );
  const value = timestamp(year ? Number(year) : snapshotYear);
  return !year && value > asOf ? timestamp(snapshotYear - 1) : value;
}

function latestStep(steps: DocumentStep[], asOf: number) {
  let latest: DocumentStep | undefined;
  let latestTime = -Infinity;
  for (const step of steps) {
    const time = stepTimestamp(step.time, asOf);
    // With equal or absent timestamps, use the source workflow order.
    if (time >= latestTime) {
      latest = step;
      latestTime = time;
    }
  }
  return latest;
}

export function latestProgressNode(doc: GenericDocument): {
  label: string;
  actors: string[];
  time?: string;
  status: DocumentStep['status'] | 'unknown';
  role: string;
} {
  const asOf = Date.parse(doc.updatedAt);
  const steps = doc.steps ?? [];
  const active = doc.status === 'processing' || doc.status === 'needs_action';
  const currentSteps = active
    ? steps.filter((s) => s.status === 'current')
    : [];
  const current = active ? doc.current : undefined;
  const latest = latestStep(currentSteps, asOf);
  if (current) {
    const actors = actorNames(current.actors);
    const exact = currentSteps.filter((s) => s.label === current.label);
    const overlapping = currentSteps.filter((s) =>
      s.actors?.some((a) => actors.includes(a.trim())),
    );
    const multipleNodes = new Set(currentSteps.map((s) => s.label)).size > 1;
    const combined =
      multipleNodes &&
      !exact.length &&
      (!actors.length ||
        overlapping.length > 1 ||
        /并行/.test(current.label) ||
        currentSteps.every((s) => current.label.includes(s.label)));
    if (combined && latest) {
      return {
        label: latest.label,
        actors: actorNames(latest.actors).filter((a) => actors.includes(a)),
        time: latest.time,
        status: 'current',
        role: currentRole(doc),
      };
    }
    const matchingStep = latestStep(exact.length ? exact : overlapping, asOf);
    return {
      label:
        current.label ||
        matchingStep?.label ||
        doc.phaseLabel ||
        '节点信息未返回',
      actors,
      time: current.since || matchingStep?.time,
      status: 'current',
      role: currentRole(doc),
    };
  }
  const step =
    latest ??
    latestStep(
      steps.filter((s) => s.status === 'done' || s.status === 'returned'),
      asOf,
    );
  if (step) {
    const role =
      step.status === 'current'
        ? currentRole(doc)
        : step.status === 'returned'
          ? '退回人'
          : '办理人';
    return {
      label: step.label,
      actors: actorNames(step.actors),
      time: step.time,
      status: step.status,
      role,
    };
  }
  return {
    label: doc.phaseLabel || doc.sourceStatus || '节点信息未返回',
    actors: [],
    status: 'unknown',
    role: '处理人',
  };
}
