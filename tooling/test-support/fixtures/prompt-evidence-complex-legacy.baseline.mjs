export function sumLegacyAmounts(rows) {
  return rows.reduce((sum, row) => sum + Number(row.amount), 0);
}
