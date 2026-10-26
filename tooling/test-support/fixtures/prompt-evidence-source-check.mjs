import fs from 'node:fs';

const [sourcePath, expectedText] = process.argv.slice(2);
if (!sourcePath || !expectedText) {
  console.error('usage: prompt-evidence-source-check.mjs <source> <expected text>');
  process.exit(2);
}

const source = fs.readFileSync(sourcePath, 'utf8');
if (!source.includes(expectedText)) {
  console.error(`required behavior is missing from ${sourcePath}`);
  process.exit(1);
}
console.log(`verified source behavior in ${sourcePath}`);
