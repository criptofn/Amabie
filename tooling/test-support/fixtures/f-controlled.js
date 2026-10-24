import fs from 'node:fs';

const marker = process.argv[2];
if (!marker) throw new Error('fixture requires an explicit marker path');
if (fs.existsSync(marker)) {
  console.error('controlled fixture failure requested');
  process.exitCode = 1;
} else {
  console.log('controlled fixture passed');
}