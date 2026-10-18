function parseLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted && character === '"' && line[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else {
      field += character;
    }
  }
  fields.push(field);
  return fields;
}

export function parseTransactions(csv) {
  const text = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;
  const lines = text.split(/\r?\n/u).filter((line, index, rows) => line !== '' || index < rows.length - 1);
  const headers = parseLine(lines[0] ?? '').map((header) => header.trim().toLowerCase());
  const required = ['id', 'date', 'amount', 'description'];
  const missing = required.filter((header) => !headers.includes(header));
  if (missing.length > 0) {
    return {
      transactions: [],
      errors: missing.map((column) => ({ lineNumber: 1, code: 'missing_header', column })),
    };
  }
  const positions = Object.fromEntries(headers.map((header, index) => [header, index]));
  const transactions = [];
  const errors = [];
  for (let index = 1; index < lines.length; index += 1) {
    const values = parseLine(lines[index] ?? '');
    const id = (values[positions.id] ?? '').trim();
    if (id === '') {
      errors.push({ lineNumber: index + 1, code: 'invalid_id' });
      continue;
    }
    transactions.push({
      id,
      date: values[positions.date] ?? '',
      amount: Number(values[positions.amount] ?? ''),
      description: values[positions.description] ?? '',
    });
  }
  return { transactions, errors };
}

export function sumAcceptedTransactions(transactions) {
  return transactions.reduce((total, transaction) => total + transaction.amount, 0);
}

export function exportTransactions(transactions) {
  return [
    'id,date,amount,description',
    ...transactions.map((transaction) => [
      transaction.id,
      transaction.date,
      transaction.amount,
      transaction.description,
    ].join(',')),
  ].join('\n');
}
