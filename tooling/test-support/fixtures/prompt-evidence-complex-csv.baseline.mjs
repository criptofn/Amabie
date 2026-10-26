function parseRecords(csv) {
  const text = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;
  const records = [];
  let values = [];
  let value = '';
  let quoted = false;
  let physicalLine = 1;
  let recordLine = 1;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else if (character === '\r' && text[index + 1] === '\n') {
        value += '\n';
        physicalLine += 1;
        index += 1;
      } else if (character === '\n') {
        value += '\n';
        physicalLine += 1;
      } else {
        value += character;
      }
      continue;
    }

    if (character === '"' && value.length === 0) {
      quoted = true;
    } else if (character === ',') {
      values.push(value);
      value = '';
    } else if (character === '\r' && text[index + 1] === '\n') {
      values.push(value);
      records.push({ lineNumber: recordLine, values });
      physicalLine += 1;
      recordLine = physicalLine;
      values = [];
      value = '';
      index += 1;
    } else if (character === '\n') {
      values.push(value);
      records.push({ lineNumber: recordLine, values });
      physicalLine += 1;
      recordLine = physicalLine;
      values = [];
      value = '';
    } else {
      value += character;
    }
  }

  if (quoted) throw new Error('unterminated quoted field');
  if (value.length > 0 || values.length > 0 || text.length === 0) {
    values.push(value);
    records.push({ lineNumber: recordLine, values });
  }
  return records;
}

export function parseTransactions(csv) {
  const records = parseRecords(csv);
  const headerRecord = records[0];
  if (!headerRecord) return { transactions: [], errors: [{ lineNumber: 1, code: 'missing_header' }] };

  const headers = headerRecord.values.map((value) => value.trim().toLowerCase());
  const required = ['id', 'date', 'amount', 'description'];
  const missing = required.filter((header) => !headers.includes(header));
  if (missing.length > 0) {
    return {
      transactions: [],
      errors: missing.map((column) => ({ lineNumber: headerRecord.lineNumber, code: 'missing_header', column })),
    };
  }

  const positions = Object.fromEntries(headers.map((header, index) => [header, index]));
  const transactions = [];
  const errors = [];
  const seenIds = new Set();
  for (const record of records.slice(1)) {
    if (record.values.every((value) => value.trim() === '')) continue;
    const id = (record.values[positions.id] ?? '').trim();
    if (id === '') {
      errors.push({ lineNumber: record.lineNumber, code: 'invalid_id' });
      continue;
    }
    const amountText = (record.values[positions.amount] ?? '').trim();
    const amount = Number(amountText);
    if (amountText === '' || !Number.isFinite(amount)) {
      errors.push({ lineNumber: record.lineNumber, code: 'invalid_amount' });
      continue;
    }
    if (seenIds.has(id)) {
      errors.push({ lineNumber: record.lineNumber, code: 'duplicate_id' });
      continue;
    }
    seenIds.add(id);
    transactions.push({
      id,
      date: record.values[positions.date] ?? '',
      amount,
      description: record.values[positions.description] ?? '',
    });
  }
  return { transactions, errors };
}

export function sumAcceptedTransactions(transactions) {
  return transactions.reduce((total, transaction) => total + transaction.amount, 0);
}

function escapeField(value) {
  let text = String(value ?? '');
  if (/^[=+\-@]/u.test(text)) text = "'" + text;
  return /[",\r\n]/u.test(text) ? '"' + text.replace(/"/gu, '""') + '"' : text;
}

export function exportTransactions(transactions) {
  const header = ['id', 'date', 'amount', 'description'].join(',');
  const rows = transactions.map((transaction) => [
    escapeField(transaction.id),
    escapeField(transaction.date),
    String(transaction.amount),
    escapeField(transaction.description),
  ].join(','));
  return [header, ...rows].join('\n');
}
