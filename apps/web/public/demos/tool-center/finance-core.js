const MAX_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

function safeInteger(value, label = '金额合计') {
  if (value > MAX_CENTS || value < -MAX_CENTS) throw new Error(`${label}超出可处理范围，请拆分文件。`);
  return Number(value);
}

export function parseCSV(input) {
  const text = String(input ?? '').replace(/^\uFEFF/, '');
  if (!text.trim()) throw new Error('文件为空，请选择包含表头和数据的 CSV 文件。');
  const parsed = [];
  let row = [], field = '', state = 'start', touched = false;
  const pushField = () => { row.push(field); field = ''; state = 'start'; };
  const pushRow = () => { pushField(); parsed.push({ values: row, blank: !touched && row.length === 1 && row[0] === '' }); row = []; touched = false; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (state === 'quoted') {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else state = 'afterQuote';
      } else field += char;
      continue;
    }
    if (char === ',' ) { touched = true; pushField(); continue; }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      pushRow(); continue;
    }
    if (state === 'afterQuote') {
      if (char === ' ' || char === '\t') continue;
      throw new Error(`第 ${parsed.length + 1} 条记录的引号后含有无效字符。`);
    }
    if (char === '"') {
      if (state !== 'start') throw new Error(`第 ${parsed.length + 1} 条记录的引号格式有误。`);
      state = 'quoted'; touched = true; continue;
    }
    field += char; state = 'unquoted'; touched = true;
  }
  if (state === 'quoted') throw new Error('CSV 中存在未闭合的引号，请检查文件格式。');
  if (touched || row.length || field || state === 'afterQuote') pushRow();
  while (parsed.length && parsed[parsed.length - 1].blank) parsed.pop();
  if (!parsed.length) throw new Error('文件为空。');
  const headers = parsed[0].values.map(value => value.trim());
  if (headers.some(header => !header)) throw new Error('表头不能为空，请为每一列填写名称。');
  if (new Set(headers).size !== headers.length) throw new Error('存在重复表头，请使用不同的列名。');
  const rows = parsed.slice(1).map((record, index) => {
    if (record.values.length !== headers.length) throw new Error(`第 ${index + 2} 条记录有 ${record.values.length} 列，表头有 ${headers.length} 列。`);
    return record.values;
  });
  return { headers, rows };
}

export function moneyToCents(value) {
  const raw = String(value ?? '').trim();
  if (!raw || !/^-?(?:\d+|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw)) {
    throw new Error('金额须为数字，最多保留两位小数。');
  }
  const negative = raw.startsWith('-');
  const clean = raw.replace(/^-/, '').replace(/,/g, '');
  const [whole, decimal = ''] = clean.split('.');
  const amount = BigInt(whole) * 100n + BigInt(decimal.padEnd(2, '0'));
  return safeInteger(negative ? -amount : amount, '金额');
}

export function formatMoney(cents) {
  if (!Number.isSafeInteger(cents)) throw new Error('金额格式无效。');
  const sign = cents < 0 ? '-' : '';
  const value = BigInt(cents < 0 ? -cents : cents);
  const whole = String(value / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${whole}.${String(value % 100n).padStart(2, '0')}`;
}

function plainMoney(cents) { return formatMoney(cents).replace(/,/g, ''); }

export function moneyForCSV(cents) {
  return cents === null || cents === undefined ? '' : plainMoney(cents);
}

export function csvExport(headers, rows) {
  const escape = value => {
    let text = String(value ?? '');
    // Spreadsheet formula prefixes can hide behind whitespace or a BOM.
    const trimmed = text.replace(/^[\s\uFEFF]+/, '');
    const negativeNumber = /^-\d+(?:\.\d{1,2})?$/.test(text);
    if ((/^[=+\-@]/.test(trimmed) && !negativeNumber) || /^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return '\uFEFF' + [headers, ...rows].map(row => row.map(escape).join(',')).join('\r\n');
}

function verifyMapping(table, mapping, required) {
  if (!table || !Array.isArray(table.headers) || !Array.isArray(table.rows)) throw new Error('数据表格式无效。');
  for (const key of required) {
    if (!Number.isInteger(mapping?.[key]) || mapping[key] < 0 || mapping[key] >= table.headers.length) throw new Error('请为所有必填字段选择对应列。');
  }
}

export function reconcileTables(leftTable, rightTable, mapping) {
  verifyMapping(leftTable, { key: mapping?.leftKey, amount: mapping?.leftAmount }, ['key', 'amount']);
  verifyMapping(rightTable, { key: mapping?.rightKey, amount: mapping?.rightAmount }, ['key', 'amount']);
  const prepare = (table, keyIndex, amountIndex) => table.rows.map((row, index) => {
    const key = String(row[keyIndex] ?? '').trim();
    let amount = null, error = '';
    try { amount = moneyToCents(row[amountIndex]); } catch (err) { error = err.message; }
    if (!key) error = '关联字段为空。' + (error ? ` ${error}` : '');
    return { row, key, amount, error, line: index + 2 };
  });
  const left = prepare(leftTable, mapping.leftKey, mapping.leftAmount);
  const right = prepare(rightTable, mapping.rightKey, mapping.rightAmount);
  const group = rows => {
    const map = new Map();
    rows.filter(item => item.key).forEach(item => { if (!map.has(item.key)) map.set(item.key, []); map.get(item.key).push(item); });
    return map;
  };
  const leftMap = group(left), rightMap = group(right), records = [];
  const counts = { matched: 0, difference: 0, 'left-only': 0, 'right-only': 0, duplicate: 0, invalid: 0 };
  const add = (status, l, r, reason, diff = null) => {
    records.push({ id: l?.key || r?.key || '—', left: l?.row || null, right: r?.row || null, leftAmount: l?.amount ?? null, rightAmount: r?.amount ?? null, diff, status, reason, leftLine: l?.line ?? null, rightLine: r?.line ?? null });
    counts[status]++;
  };
  for (const item of left.filter(item => !item.key)) add('invalid', item, null, `左表第 ${item.line} 行：${item.error}`);
  for (const item of right.filter(item => !item.key)) add('invalid', null, item, `右表第 ${item.line} 行：${item.error}`);
  for (const key of new Set([...leftMap.keys(), ...rightMap.keys()])) {
    const leftItems = leftMap.get(key) || [], rightItems = rightMap.get(key) || [];
    if (leftItems.length > 1 || rightItems.length > 1) {
      const reason = `重复关联值：左表 ${leftItems.length} 条，右表 ${rightItems.length} 条；需人工确认。`;
      leftItems.forEach(item => add('duplicate', item, null, reason + (item.error ? ` ${item.error}` : '')));
      rightItems.forEach(item => add('duplicate', null, item, reason + (item.error ? ` ${item.error}` : '')));
      continue;
    }
    const l = leftItems[0], r = rightItems[0];
    if (l?.error || r?.error) { add('invalid', l, r, [l?.error && `左表：${l.error}`, r?.error && `右表：${r.error}`].filter(Boolean).join(' ')); continue; }
    if (!l) { add('right-only', null, r, '仅右表存在该关联值。'); continue; }
    if (!r) { add('left-only', l, null, '仅左表存在该关联值。'); continue; }
    const diff = safeInteger(BigInt(l.amount) - BigInt(r.amount), '差额');
    add(diff === 0 ? 'matched' : 'difference', l, r, diff === 0 ? '关联值与金额一致。' : '关联值一致，金额不同。', diff);
  }
  return { records, counts };
}

export function normalizeDate(value) {
  const raw = String(value ?? '').trim();
  const match = /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})$/.exec(raw);
  if (!match) throw new Error('日期须为 YYYY-MM-DD 或 YYYY/MM/DD。');
  const year = Number(match[1]), month = Number(match[3]), day = Number(match[4]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) throw new Error('日期不存在或不在 1900—9999 年范围内。');
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function validateRow(row, mapping, textFields) {
  const errors = [];
  let date = '', amount = null;
  try { date = normalizeDate(row[mapping.date]); } catch (err) { errors.push(err.message); }
  try { amount = moneyToCents(row[mapping.amount]); } catch (err) { errors.push(err.message); }
  const text = {};
  for (const [key, label] of textFields) {
    text[key] = String(row[mapping[key]] ?? '').trim();
    if (!text[key]) errors.push(`${label}不能为空。`);
  }
  return { errors, date, amount, ...text };
}

export function convertTable(table, mapping) {
  verifyMapping(table, mapping, ['date', 'description', 'amount', 'department']);
  const valid = [], invalid = [];
  table.rows.forEach((row, index) => {
    const value = validateRow(row, mapping, [['description', '摘要'], ['department', '部门']]);
    if (value.errors.length) invalid.push({ line: index + 2, values: row, errors: value.errors });
    else valid.push([value.date, value.description, plainMoney(value.amount), value.department]);
  });
  return { valid, invalid };
}

export function analyzeExpenses(table, mapping) {
  verifyMapping(table, mapping, ['date', 'department', 'category', 'amount']);
  let sum = 0n, count = 0;
  const departments = new Map(), categories = new Map(), invalid = [], valid = [];
  const addGroup = (map, name, amount) => {
    const item = map.get(name) || { name, amount: 0n, count: 0 };
    item.amount += BigInt(amount); item.count++; map.set(name, item);
  };
  table.rows.forEach((row, index) => {
    const value = validateRow(row, mapping, [['department', '部门'], ['category', '费用类别']]);
    if (value.errors.length) { invalid.push({ line: index + 2, values: row, errors: value.errors }); return; }
    sum += BigInt(value.amount); count++;
    addGroup(departments, value.department, value.amount);
    addGroup(categories, value.category, value.amount);
    valid.push({ date: value.date, department: value.department, category: value.category, amount: value.amount, line: index + 2 });
  });
  const list = map => [...map.values()].map(item => ({ ...item, amount: safeInteger(item.amount) })).sort((a, b) => a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : a.name.localeCompare(b.name, 'zh-CN'));
  return { total: safeInteger(sum), count, departments: list(departments), categories: list(categories), invalid, valid };
}
