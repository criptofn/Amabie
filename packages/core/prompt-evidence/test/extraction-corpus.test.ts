import assert from 'node:assert/strict';
import test from 'node:test';
import { draftPromptEvidence } from '../src/index.js';
import { EXTRACTION_CORPUS } from './extraction-corpus.js';

for (const entry of EXTRACTION_CORPUS) {
  test(`extraction corpus invariants hold: ${entry.id}`, () => {
    const draft = draftPromptEvidence(entry.goal);
    const requirements = draft.request.requirements;

    // Whatever the segmentation, the draft is traceable and can never PASS on its own.
    assert.equal(draft.verdict, 'NOT PROVEN');
    assert.equal(draft.sourceCoverage.complete, true);
    assert.ok(requirements.every(r => r.clarity === 'unclear' && r.criteria.length === 0));
    for (const [index, r] of requirements.entries()) {
      const ref = r.sourceRef;
      assert.equal(entry.goal.slice(ref.start, ref.end), ref.excerpt);
      assert.equal(entry.goal.slice(ref.focusStart!, ref.focusEnd!), r.text);
      if (index > 0) {
        const gap = entry.goal.slice(requirements[index - 1]!.sourceRef.end, ref.start);
        assert.match(gap, /^\s*$/, 'only whitespace may lie between source ranges');
      }
    }
  });

  test(`extraction corpus boundaries: ${entry.id}`, () => {
    const actual = draftPromptEvidence(entry.goal).request.requirements.map(r => r.text);
    if (entry.knownGap === undefined) {
      assert.deepEqual(actual, entry.expected);
      return;
    }
    // Pinned disagreement: if the splitter now agrees, delete `knownGap` from the corpus entry.
    assert.notDeepEqual(actual, entry.expected, `known gap is closed (${entry.knownGap.reason}); remove knownGap`);
  });
}
