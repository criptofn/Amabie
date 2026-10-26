import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const group = process.argv[2];
if (group !== 'unit' && group !== 'e2e') {
  console.error('usage: prompt-evidence-complex-csv-check.mjs unit|e2e');
  process.exit(2);
}

const root = process.cwd();
const cacheKey = Date.now() + '-' + process.pid;
const implementation = await import(pathToFileURL(path.join(root, 'transactions.mjs')).href + '?run=' + cacheKey);
const legacy = await import(pathToFileURL(path.join(root, 'legacy.mjs')).href + '?run=' + cacheKey);
const results = [];

function check(name, operation) {
  try {
    operation();
    results.push({ name, status: 'PASS' });
    console.log('PASS ' + name);
  } catch (error) {
    results.push({ name, status: 'FAIL', reason: error instanceof Error ? error.message : String(error) });
    console.error('FAIL ' + name + ': ' + (error instanceof Error ? error.message : String(error)));
  }
}

function hasError(result, code) {
  return result.errors.some((error) => error.code === code);
}

const unitChecks = [
  ['R1 API returns accepted transactions and structured errors', () => {
    const result = implementation.parseTransactions('id,date,amount,description\nA,2026-01-01,12,coffee\n');
    assert.ok(Array.isArray(result.transactions));
    assert.ok(Array.isArray(result.errors));
    assert.equal(result.transactions[0]?.amount, 12);
  }],
  ['R2 all required headers are checked', () => {
    const result = implementation.parseTransactions('id,date,amount\nA,2026-01-01,12\n');
    assert.equal(result.transactions.length, 0);
    assert.ok(hasError(result, 'missing_header'));
    assert.ok(result.errors.some((error) => error.column === 'description'));
  }],
  ['R3 a UTF-8 BOM before the header is accepted', () => {
    const result = implementation.parseTransactions('\uFEFFid,date,amount,description\nA,2026-01-01,12,coffee\n');
    assert.equal(result.transactions.length, 1);
    assert.equal(result.transactions[0]?.id, 'A');
  }],
  ['R4 quoted commas and escaped double quotes are parsed', () => {
    const result = implementation.parseTransactions('id,date,amount,description\nA,2026-01-01,12,"coffee, said ""hot"""\n');
    assert.equal(result.transactions[0]?.description, 'coffee, said "hot"');
  }],
  ['R5 blank ids are rejected as row errors', () => {
    const result = implementation.parseTransactions('id,date,amount,description\n ,2026-01-01,12,coffee\n');
    assert.equal(result.transactions.length, 0);
    assert.ok(hasError(result, 'invalid_id'));
  }],
];

const e2eChecks = [
  ['R6 missing, non-numeric, NaN, and infinite amounts are rejected', () => {
    for (const amount of ['', 'not-a-number', 'NaN', 'Infinity', '-Infinity']) {
      const result = implementation.parseTransactions('id,date,amount,description\nA,2026-01-01,' + amount + ',bad\n');
      assert.equal(result.transactions.length, 0, 'amount ' + JSON.stringify(amount) + ' must not be accepted');
      assert.ok(hasError(result, 'invalid_amount'), 'amount ' + JSON.stringify(amount) + ' must produce an error');
    }
  }],
  ['R7 row errors retain physical line numbers across quoted newlines', () => {
    const csv = 'id,date,amount,description\r\n'
      + 'A,2026-01-01,1,"first line\r\nsecond line"\r\n'
      + 'B,2026-01-02,NaN,invalid\r\n';
    const result = implementation.parseTransactions(csv);
    const error = result.errors.find((item) => item.code === 'invalid_amount');
    assert.equal(error?.lineNumber, 4);
  }],
  ['R8 duplicate ids keep the first valid row and report the duplicate', () => {
    const result = implementation.parseTransactions('id,date,amount,description\nA,2026-01-01,5,first\nA,2026-01-02,9,second\n');
    assert.equal(result.transactions.length, 1);
    assert.equal(result.transactions[0]?.description, 'first');
    assert.ok(result.errors.some((error) => error.code === 'duplicate_id' && error.lineNumber === 3));
  }],
  ['R9 accepted totals remain signed and exclude rejected rows', () => {
    const result = implementation.parseTransactions('id,date,amount,description\nA,2026-01-01,7,income\nB,2026-01-02,-2,refund\nC,2026-01-03,NaN,bad\n');
    assert.equal(implementation.sumAcceptedTransactions(result.transactions), 5);
  }],
  ['R10 export quotes CSV and neutralizes formula-leading text', () => {
    const csv = implementation.exportTransactions([
      { id: 'A', date: '2026-01-01', amount: -2, description: '=1+1' },
      { id: 'B', date: '2026-01-02', amount: 3, description: 'ordinary, note "quoted"' },
    ]);
    assert.match(csv, /,-2,'=1\+1(?:\r?\n|$)/u);
    assert.match(csv, /"ordinary, note ""quoted"""/u);
  }],
  ['Hidden regression: legacy totals preserve negative credits', () => {
    assert.equal(legacy.sumLegacyAmounts([{ amount: 14 }, { amount: -4 }]), 10);
  }],
];

for (const [name, operation] of group === 'unit' ? unitChecks : e2eChecks) check(name, operation);
const failed = results.filter((result) => result.status === 'FAIL');
console.log(JSON.stringify({ group, passed: results.length - failed.length, failed: failed.length, results }));
if (failed.length > 0) process.exitCode = 1;
