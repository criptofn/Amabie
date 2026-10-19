import fs from 'node:fs';
import path from 'node:path';

// The fixture baseline already contains src/app.js exporting 1, plus an
// existing tests/regression.test.cjs that asserts only when
// tests/regression.expected.json exists. The discriminating oracle is that
// data file, which the worker CREATES; the sealed f-regression.cjs reads it and
// it travels onto the baseline during discrimination and must fail there.
// The existing regression.test.cjs is deliberately NOT rewritten: rewriting an
// existing check is the P0:21 attack and must stay unproven.
export function addRegression(candidate) {
  fs.writeFileSync(path.join(candidate, 'src', 'app.js'), 'module.exports = 2;\n');
  fs.mkdirSync(path.join(candidate, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(candidate, 'tests', 'regression.expected.json'), '2\n');
}
