import { draftPromptEvidence } from '@amabie/prompt-evidence';

/** Experimental, read-only structural draft for review before any verification. */
export function cmdPromptEvidence(args: string[]): number {
  const [action, ...rest] = args;
  if (action !== 'draft') {
    console.error('usage: amabie prompt-evidence draft "<original task>" [--json]');
    return 3;
  }
  const json = rest[rest.length - 1] === '--json';
  const goalParts = json ? rest.slice(0, -1) : rest;
  const goalText = goalParts.length === 1 ? goalParts[0]! : goalParts.join(' ');
  if (!goalText || goalText.trim() === '') {
    console.error('the draft command needs the original task text; no project files were changed');
    return 3;
  }

  let draft;
  try { draft = draftPromptEvidence(goalText); }
  catch (error) {
    console.error(`could not draft requirements: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
    return 3;
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(draft.request, null, 2)}\n`);
    console.error('DRAFT ONLY — NOT PROVEN. Review every candidate, split compound requests, resolve unclear wording, and add criteria before verification.');
  } else {
    console.log('DRAFT ONLY — NOT PROVEN. This command made no project changes.');
    console.log(`Source text mapped: ${draft.sourceCoverage.mappedNonWhitespaceCharacters}/${draft.sourceCoverage.nonWhitespaceCharacters} non-whitespace characters.`);
    for (const [index, candidate] of draft.candidates.entries()) {
      console.log(`${index + 1}. [UNCLEAR] ${candidate.text} (source ${candidate.sourceRef.start}:${candidate.sourceRef.end})`);
    }
    for (const note of draft.notes) console.log(`Review: ${note}`);
  }
  return 0;
}
