import fs from 'node:fs';

const [targetPath, expectedRequirement, reportPath, mode] = process.argv.slice(2);
const input = JSON.parse(fs.readFileSync(0, 'utf8'));

if (mode === 'initial-false-done') {
  if (!targetPath || input.schema !== 'amabie-agent-task/1' || typeof input.goal?.text !== 'string') {
    console.error('invalid initial agent task');
    process.exit(2);
  }
  fs.writeFileSync(targetPath, 'export const passwordRule = "accepts blank input";\n');
  console.log('Everything is done. Registration and password handling are complete.');
  process.exit(0);
}

if (mode === 'initial-false-done-behavior') {
  if (!targetPath || input.schema !== 'amabie-agent-task/1' || typeof input.goal?.text !== 'string') {
    console.error('invalid initial agent task');
    process.exit(2);
  }
  fs.writeFileSync(targetPath, 'export function acceptsPassword(value) { return typeof value === "string"; }\n');
  console.log('Everything is done. Registration and password storage are complete.');
  process.exit(0);
}

if (!targetPath || !expectedRequirement || !reportPath
  || input.schema !== 'amabie-correction-request/1'
  || !Array.isArray(input.report?.unresolved)) {
  console.error('invalid Amabie correction request');
  process.exit(2);
}

fs.writeFileSync(reportPath, `${JSON.stringify(input, null, 2)}\n`);
if (input.report.unresolved.length !== 1
  || input.report.unresolved[0].requirement !== expectedRequirement
  || input.report.unresolved[0].status !== 'unmet') {
  console.error('the independent report did not identify the expected missing requirement');
  process.exit(3);
}

if (mode === 'claim-only') {
  console.log('All requirements are done.');
  process.exit(0);
}

if (mode === 'scope-change') {
  const request = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  request.correctionScopeChanged = true;
  fs.writeFileSync(targetPath, `${JSON.stringify(request, null, 2)}\n`);
  console.log('All requirements are done.');
  process.exit(0);
}

if (mode === 'persistent-unresolved') {
  const attemptPath = `${targetPath}.attempts`;
  const previous = fs.existsSync(attemptPath) ? Number(fs.readFileSync(attemptPath, 'utf8')) : 0;
  if (!Number.isSafeInteger(previous) || previous < 0) {
    console.error('invalid correction attempt counter');
    process.exit(4);
  }
  fs.writeFileSync(attemptPath, String(previous + 1));
  console.log('Everything is done. No verified requirement was changed.');
  process.exit(0);
}

fs.writeFileSync(targetPath, 'export const passwordRule = "rejects blank input";\n');
console.log('All requirements are done.');
