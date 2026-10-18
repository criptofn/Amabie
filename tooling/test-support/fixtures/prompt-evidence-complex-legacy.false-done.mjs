export function sumLegacyAmounts(rows) {
  return rows.reduce((sum, row) => sum + Math.abs(Number(row.amount)), 0);
}
