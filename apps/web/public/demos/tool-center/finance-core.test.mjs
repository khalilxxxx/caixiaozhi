import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, moneyToCents, formatMoney, moneyForCSV, csvExport, reconcileTables, normalizeDate, convertTable, analyzeExpenses } from './finance-core.js';

test('CSV supports BOM, CRLF, escaped quotes, commas and multiline cells', () => {
  const result = parseCSV('\uFEFF单号,备注,金额\r\nA1,"含,逗号与""引号""\n第二行",12.30\r\nA2,,0\r\n\r\n');
  assert.deepEqual(result.headers, ['单号', '备注', '金额']);
  assert.deepEqual(result.rows, [['A1', '含,逗号与"引号"\n第二行', '12.30'], ['A2', '', '0']]);
});

test('CSV preserves explicitly empty values, trims only physical blank tail lines', () => {
  assert.deepEqual(parseCSV('a,b\n,\n').rows, [['', '']]);
  assert.deepEqual(parseCSV('a\n""\n\n').rows, [['']]);
  assert.deepEqual(parseCSV('a,b').rows, []);
});

test('CSV rejects broken quotes, missing headers, duplicates and wrong column count', () => {
  for (const text of ['a,a\n1,2', ',a\n1,2', 'a,b\n1', 'a,b\n"abc,1', 'a,b\nhi"there,1', 'a,b\n"hello"x,1']) assert.throws(() => parseCSV(text));
});

test('money uses exact integer cents including negative amounts and grouped numbers', () => {
  assert.equal(moneyToCents('0.29'), 29);
  assert.equal(moneyToCents('1,234.5'), 123450);
  assert.equal(moneyToCents('-00012.30'), -1230);
  assert.equal(moneyToCents('-0'), 0);
  assert.equal(formatMoney(-123456), '-1,234.56');
  assert.equal(moneyToCents('90071992547409.91'), Number.MAX_SAFE_INTEGER);
  assert.equal(formatMoney(Number.MAX_SAFE_INTEGER), '90,071,992,547,409.91');
});

test('money rejects empty, malformed, excessive precision, exponent and overflow', () => {
  for (const value of ['', ' ', null, undefined, '1,23.00', '01,234', '1.005', 'NaN', 'Infinity', '1e3', '+1', '--1', '￥20', '90071992547409.92']) assert.throws(() => moneyToCents(value));
});

const reconcileMapping = { leftKey: 0, leftAmount: 1, rightKey: 0, rightAmount: 1 };
test('reconciliation distinguishes exact match, difference, one-sided and invalid entries', () => {
  const left = parseCSV('单号,金额\nA,0.29\nB,100\nC,-20\nD,abc\n,10');
  const right = parseCSV('编号,金额\nA,0.29\nB,90\nE,30\nD,0');
  const result = reconcileTables(left, right, reconcileMapping);
  assert.deepEqual(result.counts, { matched: 1, difference: 1, 'left-only': 1, 'right-only': 1, duplicate: 0, invalid: 2 });
  assert.equal(result.records.find(row => row.id === 'B').diff, 1000);
  assert.equal(result.records.find(row => row.id === 'D').status, 'invalid');
});

test('duplicate key on either table marks every affected source row for review', () => {
  const left = parseCSV('id,amount\nA,10\nA,20\nB,0');
  const right = parseCSV('id,amount\nA,30\nB,0');
  const result = reconcileTables(left, right, reconcileMapping);
  assert.equal(result.counts.duplicate, 3);
  assert.equal(result.counts.matched, 1);
  assert.equal(result.records.filter(row => row.id === 'A').every(row => row.status === 'duplicate'), true);
  assert.equal(result.records.filter(row => row.id === 'A').filter(row => row.left).length, 2);
});

test('dates use strict Gregorian validation and normalize separators', () => {
  assert.equal(normalizeDate('2024/2/29'), '2024-02-29');
  assert.equal(normalizeDate('2026-11-01'), '2026-11-01');
  for (const date of ['2026-02-29', '1900-02-29', '2026-04-31', '2026-00-01', '2026-1/1', '26-11-1', '2026-11-01T00:00:00']) assert.throws(() => normalizeDate(date));
});

test('template conversion validates required fields and separates invalid rows', () => {
  const table = parseCSV('日期,摘要,金额,部门\n2026/11/1,付款,0.29,财务部\n2026-02-29,付款,10,财务部\n2026-11-02,,0.001,');
  const result = convertTable(table, { date: 0, description: 1, amount: 2, department: 3 });
  assert.deepEqual(result.valid, [['2026-11-01', '付款', '0.29', '财务部']]);
  assert.equal(result.invalid.length, 2);
  assert.equal(result.invalid[1].line, 4);
  assert.equal(result.invalid[1].errors.length, 3);
});

test('expense totals and group totals use exact cents and exclude invalid data', () => {
  const table = parseCSV('日期,部门,类别,金额\n2026-11-1,财务部,差旅,0.1\n2026-11-2,财务部,差旅,0.2\n2026-11-3,运营部,办公,-0.1\n2026-11-31,运营部,办公,100');
  const result = analyzeExpenses(table, { date: 0, department: 1, category: 2, amount: 3 });
  assert.equal(result.total, 20);
  assert.equal(result.count, 3);
  assert.deepEqual(result.departments, [{ name: '财务部', amount: 30, count: 2 }, { name: '运营部', amount: -10, count: 1 }]);
  assert.equal(result.invalid.length, 1);
  assert.equal(result.valid.length, 3);
});

test('unsafe totals and differences never silently round', () => {
  const table = parseCSV('日期,部门,类别,金额\n2026-11-1,A,差旅,90071992547409.91\n2026-11-2,A,差旅,0.01');
  assert.throws(() => analyzeExpenses(table, { date: 0, department: 1, category: 2, amount: 3 }), /范围/);
  assert.throws(() => reconcileTables(parseCSV('id,amount\nA,90071992547409.91'), parseCSV('id,amount\nA,-0.01'), reconcileMapping), /范围/);
});

test('mapping errors are actionable', () => {
  const table = parseCSV('日期,摘要,金额,部门\n2026-11-1,a,1,A');
  assert.throws(() => convertTable(table, { date: 0, description: 1, amount: 99, department: 3 }), /选择对应列/);
});

test('CSV export blocks formula prefixes and preserves safe negative numeric cells', () => {
  const result = parseCSV(csvExport(['值'], [['=1+1'], [' +CMD'], ['@SUM(A1)'], ['-cmd'], ['\t=1+1'], ['-12.30'], ['line\n"quoted",value']]));
  assert.deepEqual(result.rows, [["'=1+1"], ["' +CMD"], ["'@SUM(A1)"], ["'-cmd"], ["'\t=1+1"], ['-12.30'], ['line\n"quoted",value']]);
});

test('reconciliation CSV amounts remain numeric without grouping, plus signs or formula escapes', () => {
  const result = reconcileTables(parseCSV('id,amount\nA,-1000.00\nB,1100.00\nC,1.20'), parseCSV('id,amount\nA,-1100.00\nB,1000.00'), reconcileMapping);
  const exported = parseCSV(csvExport(['id','left','right','difference'], result.records.map(row => [row.id, moneyForCSV(row.leftAmount), moneyForCSV(row.rightAmount), moneyForCSV(row.diff)])));
  assert.deepEqual(exported.rows, [['A','-1000.00','-1100.00','100.00'],['B','1100.00','1000.00','100.00'],['C','1.20','','']]);
  assert.equal(exported.rows.reduce((sum,row) => sum + moneyToCents(row[1]), 0), 10120);
  assert.equal(moneyForCSV(Number.MAX_SAFE_INTEGER), '90071992547409.91');
  assert.equal(moneyForCSV(-Number.MAX_SAFE_INTEGER), '-90071992547409.91');
  assert.equal(moneyForCSV(0), '0.00');
});
