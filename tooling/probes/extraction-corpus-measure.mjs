// Measures the deterministic prompt splitter against the extraction corpus.
// No model call, no writes. Prints one line per case and the actual focus texts
// for every disagreement. Exit 0 always: this is a measurement, the pinned
// assertions live in packages/core/prompt-evidence/test/extraction-corpus.test.ts.
import { draftPromptEvidence } from '../../packages/core/prompt-evidence/dist/src/index.js';
import { EXTRACTION_CORPUS } from '../../packages/core/prompt-evidence/dist/test/extraction-corpus.js';

let agree = 0;
for (const c of EXTRACTION_CORPUS) {
  const actual = draftPromptEvidence(c.goal).request.requirements.map(r => r.text);
  const same = JSON.stringify(actual) === JSON.stringify(c.expected);
  if (same) agree += 1;
  console.log(`${same ? 'MATCH   ' : 'MISMATCH'} ${c.id}${c.knownGap ? '  [knownGap]' : ''}`);
  if (!same) {
    console.log('   expected:', JSON.stringify(c.expected));
    console.log('   actual:  ', JSON.stringify(actual));
  }
}
console.log(`\n${agree}/${EXTRACTION_CORPUS.length} cases agree with the reader-drawn boundaries`);
