import type {
  DraftId,
  SubmissionDraft,
  TravelLeg,
} from './submission-model.js';
import type { SubmissionState } from './submission-state.js';

export interface SubmissionMessageResult<TCheck = unknown> {
  state: SubmissionState<TCheck>;
  changed: boolean;
  changes: string[];
  message: string;
}

// This is an explicit phrase mapper. Unknown cities, relative dates and
// ambiguous multi-leg instructions remain for the user to fill in.
const cities = [
  '北京',
  '上海',
  '天津',
  '重庆',
  '杭州',
  '宁波',
  '温州',
  '绍兴',
  '嘉兴',
  '金华',
  '湖州',
  '台州',
  '舟山',
  '丽水',
  '衢州',
  '南京',
  '苏州',
  '无锡',
  '常州',
  '南通',
  '扬州',
  '镇江',
  '徐州',
  '广州',
  '深圳',
  '珠海',
  '东莞',
  '佛山',
  '惠州',
  '中山',
  '汕头',
  '成都',
  '武汉',
  '西安',
  '长沙',
  '郑州',
  '济南',
  '青岛',
  '厦门',
  '福州',
  '泉州',
  '合肥',
  '南昌',
  '南宁',
  '海口',
  '三亚',
  '昆明',
  '贵阳',
  '兰州',
  '银川',
  '西宁',
  '拉萨',
  '乌鲁木齐',
  '呼和浩特',
  '石家庄',
  '太原',
  '沈阳',
  '大连',
  '长春',
  '哈尔滨',
  '香港',
  '澳门',
  '台北',
];
const cityPattern = `(?:${cities.sort((a, b) => b.length - a.length).join('|')})(?:市)?`;
const datePattern =
  '(?:\\d{4}年)?\\d{1,2}月\\d{1,2}[日号]|\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}|\\d{1,2}[日号]';
const transportPattern = '(?:高铁|动车|飞机|火车|汽车|自驾)';
const changePattern = '(?:改为|改到|改成|调整为|调整到|设为|设置为|为|是)';
const legFields: Array<[keyof Omit<TravelLeg, 'id'>, string]> = [
  ['departureCity', '出发城市'],
  ['arrivalCity', '到达城市'],
  ['departureDate', '出发日期'],
  ['arrivalDate', '到达日期'],
  ['transport', '交通工具'],
];

function blankLeg(): TravelLeg {
  return {
    id: crypto.randomUUID(),
    departureCity: '',
    arrivalCity: '',
    departureDate: '',
    arrivalDate: '',
    transport: '',
  };
}

function dateContext(now: Date): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(now);
  return {
    year: Number(parts.find((part) => part.type === 'year')?.value),
    month: Number(parts.find((part) => part.type === 'month')?.value),
  };
}

function parseDate(
  text: string,
  context: { year: number; month: number },
): string | null {
  const chinese = text.match(/^(?:(\d{4})年)?(?:(\d{1,2})月)?(\d{1,2})[日号]$/);
  const numeric = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  const match = chinese ?? numeric;
  if (!match) return null;
  const year = Number(match[1] ?? context.year);
  const month = Number(match[2] ?? context.month);
  const day = Number(match[3]);
  const iso = `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === iso
    ? iso
    : null;
}

function isRoundTrip(legs: TravelLeg[]): boolean {
  const [outbound, inbound] = legs;
  return (
    legs.length === 2 &&
    !!outbound?.departureCity &&
    !!outbound.arrivalCity &&
    inbound?.departureCity === outbound.arrivalCity &&
    inbound.arrivalCity === outbound.departureCity
  );
}

function missingFields(draft: SubmissionDraft): string {
  if (draft.id !== 'travel') return '请在单据中补充事由和费用明细。';
  if (!draft.legs.length) return '请在单据中补充行程、日期和交通工具。';
  const fields: string[] = [];
  if (draft.legs.some((item) => !item.departureCity || !item.arrivalCity))
    fields.push('城市');
  if (draft.legs.some((item) => !item.departureDate || !item.arrivalDate))
    fields.push('日期');
  if (draft.legs.some((item) => !item.transport)) fields.push('交通工具');
  if (!draft.purpose) fields.push('事由');
  return fields.length ? `请在单据中补充${fields.join('、')}。` : '';
}

export function applySubmissionMessage<TCheck>(
  state: SubmissionState<TCheck>,
  text: string,
  draftId: DraftId,
  now = new Date(),
): SubmissionMessageResult<TCheck> {
  const current = state.edits[draftId] ?? state.drafts[draftId];
  const unchanged = (message: string): SubmissionMessageResult<TCheck> => ({
    state,
    changed: false,
    changes: [],
    message,
  });
  if (
    current.status === 'awaiting_receipt' ||
    state.drafts[draftId].status === 'awaiting_receipt'
  ) {
    return unchanged('单据正在等待回执，请查询回执。');
  }
  const input = text.trim().replace(/[。！!]+$/, '');
  if (!input)
    return unchanged(
      missingFields(current) || '请在单据中补充需要修改的内容。',
    );

  const next: SubmissionDraft = {
    ...current,
    legs: current.legs.map((item) => ({ ...item })),
  };
  const notes = new Set<string>();
  const context = dateContext(now);
  const setDate = (
    item: TravelLeg,
    field: 'departureDate' | 'arrivalDate',
    value: string,
    base = context,
  ) => {
    const date = parseDate(value, base);
    if (date) item[field] = date;
    else notes.add('日期无效，请在单据中填写有效日期。');
    return date;
  };

  // A purpose command owns its full clause, so a place/date in its value is not
  // accidentally treated as another field update.
  const clauses = input
    .split(/[，,；;\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
  const travelClauses: string[] = [];
  for (const clause of clauses) {
    const purpose = clause.match(
      /^(?:请)?(?:把)?(?:(?:出差|报销|申请)事由|事由|用途)(?:改为|改成|调整为|设为|设置为|为|是|[:：])\s*(\S.{0,199})$/,
    );
    if (purpose) next.purpose = purpose[1]!.trim();
    else travelClauses.push(clause);
  }

  if (draftId === 'travel' && travelClauses.length) {
    const travelText = travelClauses.join('，');
    if (
      /下周|下星期|下个月|明天|后天|月底|周[一二三四五六日天]/.test(travelText)
    ) {
      notes.add('日期尚未明确，请在单据中填写具体日期。');
    }
    const targeted = travelText.match(
      /^第(\d+|[一二三四五六七八九十])段(?:行程)?(.+)$/,
    );
    if (targeted) {
      const ordinal = /^\d+$/.test(targeted[1]!)
        ? Number(targeted[1])
        : '一二三四五六七八九十'.indexOf(targeted[1]!) + 1;
      const item = next.legs[ordinal - 1];
      const command = targeted[2]!;
      const date = command.match(
        new RegExp(`^(出发日期|到达日期)${changePattern}(${datePattern})$`),
      );
      const transport = command.match(
        new RegExp(`^(?:交通工具|交通)${changePattern}(${transportPattern})$`),
      );
      const city = command.match(
        new RegExp(
          `^(出发城市|到达城市|目的地)${changePattern}(${cityPattern})$`,
        ),
      );
      if (!item) notes.add('未找到指定行程，请在单据中补充。');
      else if (date)
        setDate(
          item,
          date[1] === '出发日期' ? 'departureDate' : 'arrivalDate',
          date[2]!,
        );
      else if (transport) item.transport = transport[1]!;
      else if (city)
        item[city[1] === '出发城市' ? 'departureCity' : 'arrivalCity'] =
          city[2]!.replace(/市$/, '');
      else notes.add('请在单据中修改指定行程。');
    } else if (
      !/不要|不改|别改|暂不|取消|如果|假如|或|还是|可能|大概|不确定/.test(
        travelText,
      )
    ) {
      const routeExpression = new RegExp(
        `从\\s*(${cityPattern})\\s*(?:去|到|前往)\\s*(${cityPattern})(?=$|[\\s，,；;。]|拜访|参加|开展|进行|出差)`,
        'g',
      );
      const routes = [...travelText.matchAll(routeExpression)];
      const ambiguous =
        routes.length > 1 ||
        (next.legs.length > 2 && /往返|返程|回程|返回/.test(travelText));
      if (ambiguous) {
        notes.add('请在单据中修改对应行程，或明确指定第几段。');
      } else {
        let outboundIndex =
          next.legs.length === 1 || isRoundTrip(next.legs) ? 0 : -1;
        const route = routes[0];
        let routeDate: string | null = null;
        if (route) {
          const departureCity = route[1]!.replace(/市$/, '');
          const arrivalCity = route[2]!.replace(/市$/, '');
          const matches = next.legs.flatMap((item, index) =>
            item.departureCity === departureCity &&
            item.arrivalCity === arrivalCity
              ? [index]
              : [],
          );
          if (!next.legs.length) {
            next.legs.push({ ...blankLeg(), departureCity, arrivalCity });
            outboundIndex = 0;
          } else {
            // An existing route is only updated when its cities identify one
            // leg. Replacing another route requires explicit field commands.
            outboundIndex = matches.length === 1 ? matches[0]! : -1;
            if (outboundIndex < 0)
              notes.add('请在单据中确认需要修改的行程城市。');
          }
          const item = next.legs[outboundIndex];
          if (item) {
            const preceding = travelText.slice(0, route.index);
            const afterRoute = travelText.slice(
              (route.index ?? 0) + route[0].length,
            );
            const departure =
              preceding.match(new RegExp(`(${datePattern})(?:出发)?\\s*$`)) ??
              afterRoute.match(new RegExp(`^[，,]?\\s*(${datePattern})出发`));
            if (departure)
              routeDate = setDate(item, 'departureDate', departure[1]!);
            const purpose = afterRoute.match(
              /^\s*((?:拜访|参加|开展|进行)[^，,；;。\n]{1,80})/,
            );
            if (purpose) next.purpose = purpose[1]!.trim();
          }
        }

        const returnDate =
          travelText.match(
            new RegExp(
              `(?:返程|回程|返回)(?:出发日期|日期)?(?:${changePattern})?\\s*(${datePattern})`,
            ),
          ) ??
          travelText.match(
            new RegExp(`(${datePattern})\\s*(?:返回|返程|回程)`),
          );
        const outboundDate = travelText.match(
          new RegExp(
            `去程(?:出发日期|日期)?(?:${changePattern})?\\s*(${datePattern})`,
          ),
        );
        const roundTransport =
          travelText.match(
            new RegExp(
              `往返(?:交通工具|交通)?(?:都)?(?:${changePattern}|乘坐|坐)?\\s*(${transportPattern})(?=$|[，,；;。\\s])`,
            ),
          ) ??
          travelText.match(
            new RegExp(`(${transportPattern})往返(?=$|[，,；;。\\s])`),
          );
        const outboundTransport =
          travelText.match(
            new RegExp(
              `(?:^|[，,；;])去程(?:交通工具|交通)?(?:${changePattern}|乘坐|坐)\\s*(${transportPattern})$`,
            ),
          ) ??
          (route
            ? travelText.match(
                new RegExp(
                  `(?:^|[，,；;])(?:乘坐|坐)\\s*(${transportPattern})$`,
                ),
              )
            : null);
        const returnTransport = travelText.match(
          new RegExp(
            `(?:^|[，,；;])(?:返程|回程)(?:交通工具|交通)?(?:${changePattern}|乘坐|坐)\\s*(${transportPattern})$`,
          ),
        );
        const outbound = next.legs[outboundIndex];
        if (outboundDate && outbound)
          setDate(outbound, 'departureDate', outboundDate[1]!);
        if (outboundTransport && outbound)
          outbound.transport = outboundTransport[1]!;
        const wantsReturn =
          !!returnDate ||
          !!roundTransport ||
          !!returnTransport ||
          (!!route && /往返/.test(travelText));
        if (
          wantsReturn &&
          next.legs.length === 1 &&
          outbound?.departureCity &&
          outbound.arrivalCity
        ) {
          next.legs.push({
            ...blankLeg(),
            departureCity: outbound.arrivalCity,
            arrivalCity: outbound.departureCity,
          });
        }
        if (returnDate) {
          if (isRoundTrip(next.legs)) {
            const returnContext = routeDate
              ? {
                  year: Number(routeDate.slice(0, 4)),
                  month: Number(routeDate.slice(5, 7)),
                }
              : context;
            setDate(
              next.legs[1]!,
              'departureDate',
              returnDate[1]!,
              returnContext,
            );
          } else notes.add('请在单据中补充并确认返程行程。');
        }
        if (roundTransport) {
          if (isRoundTrip(next.legs))
            next.legs.forEach((item) => {
              item.transport = roundTransport[1]!;
            });
          else notes.add('请在单据中确认往返行程的交通工具。');
        }
        if (returnTransport) {
          if (isRoundTrip(next.legs))
            next.legs[1]!.transport = returnTransport[1]!;
          else notes.add('请在单据中确认返程行程的交通工具。');
        }
      }
    }
  }

  const changes: string[] = [];
  if (next.purpose !== current.purpose) changes.push('事由');
  next.legs.forEach((item, index) => {
    const previous = current.legs[index];
    const prefix =
      next.legs.length <= 2 &&
      (next.legs.length === 1 || isRoundTrip(next.legs))
        ? index === 0
          ? '去程'
          : '返程'
        : `第${index + 1}段`;
    for (const [field, label] of legFields) {
      if (item[field] !== (previous?.[field] ?? ''))
        changes.push(`${prefix}${label}`);
    }
  });
  if (!changes.length) {
    return unchanged(
      [...notes].join('') ||
        missingFields(current) ||
        '单据内容未变化，请在单据中补充需要修改的内容。',
    );
  }
  const message = `已填入${changes.join('、')}，请在单据中核对。${[...notes].join('')}${missingFields(next)}`;
  return {
    state: { ...state, edits: { ...state.edits, [draftId]: next } },
    changed: true,
    changes,
    message,
  };
}
