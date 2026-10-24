import { draftPromptEvidence } from '@amabie/prompt-evidence';
import { cmdPromptEvidenceLoop } from './prompt-evidence-correction.js';
import {
  extractPromptEvidenceWithOllama,
  suggestPromptEvidenceCriteriaWithOllama,
  type OllamaModelUsage,
  type PromptEvidenceReviewPreview,
} from './prompt-evidence-extraction.js';

function formatModelUsage(label: string, usage: OllamaModelUsage): string {
  if (usage.promptTokens === null || usage.responseTokens === null || usage.inferenceDurationMs === null) {
    return ` ${label}: metrics unavailable.`;
  }
  return ` ${label}: ${usage.promptTokens} prompt tokens, ${usage.responseTokens} response tokens, ${usage.inferenceDurationMs} ms.`;
}

/** Experimental, review-only intake plus an opt-in, bounded correction workflow. */
export async function cmdPromptEvidence(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (action === 'loop') return cmdPromptEvidenceLoop(rest);
  if (action !== 'draft') {
    console.error('usage: amabie prompt-evidence draft "<original task>" [--extractor ollama] [--suggest-criteria] [--model MODEL] [--ollama-host LOOPBACK_URL] [--json] | loop --request FILE --agent-executable PROGRAM [--agent-arg ARG]... --authorize-corrections [--json]');
    return 3;
  }

  let json = false;
  let suggestCriteria = false;
  let extractor: 'deterministic' | 'ollama' = 'deterministic';
  let model: string | undefined;
  let ollamaHost: string | undefined;
  const goalParts: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    const value = (option: string): string | undefined => {
      const next = rest[index + 1];
      if (next === undefined || next.startsWith('--')) {
        console.error(`${option} needs a value`);
        return undefined;
      }
      index += 1;
      return next;
    };
    if (argument === '--json') json = true;
    else if (argument === '--suggest-criteria') suggestCriteria = true;
    else if (argument === '--extractor') {
      const selected = value(argument);
      if (!selected) return 3;
      if (selected !== 'ollama') { console.error('supported extractors: ollama; omit --extractor for the deterministic local heuristic'); return 3; }
      extractor = selected;
    } else if (argument === '--model') {
      const selected = value(argument);
      if (!selected) return 3;
      if (model !== undefined) { console.error('--model may be provided once'); return 3; }
      model = selected;
    } else if (argument === '--ollama-host') {
      const selected = value(argument);
      if (!selected) return 3;
      if (ollamaHost !== undefined) { console.error('--ollama-host may be provided once'); return 3; }
      ollamaHost = selected;
    } else if (argument.startsWith('--')) {
      console.error(`unknown prompt-evidence draft option: ${argument}`);
      return 3;
    } else goalParts.push(argument);
  }
  const goalText = goalParts.length === 1 ? goalParts[0]! : goalParts.join(' ');
  if (!goalText || goalText.trim() === '') {
    console.error('the draft command needs the original task text; no project files were changed');
    return 3;
  }
  if (extractor !== 'ollama' && (model !== undefined || ollamaHost !== undefined)) {
    console.error('--model and --ollama-host require --extractor ollama');
    return 3;
  }
  if (suggestCriteria && extractor !== 'ollama') {
    console.error('--suggest-criteria requires --extractor ollama');
    return 3;
  }

  let draft;
  let reviewPreview: PromptEvidenceReviewPreview | undefined;
  let extractorLabel = 'deterministic local heuristic';
  let modelUsage = '';
  let criteriaModelUsage = '';
  try {
    if (extractor === 'ollama') {
      const result = await extractPromptEvidenceWithOllama(goalText, model, ollamaHost);
      draft = result.draft;
      extractorLabel = `local Ollama model ${result.model}`;
      const extractionUsage: OllamaModelUsage = {
        promptTokens: result.promptTokens,
        responseTokens: result.responseTokens,
        inferenceDurationMs: result.inferenceDurationMs,
      };
      modelUsage = formatModelUsage(suggestCriteria ? 'Extraction call inference' : 'Local inference', extractionUsage);
      if (suggestCriteria) {
        const suggestionResult = await suggestPromptEvidenceCriteriaWithOllama(draft, result.model, ollamaHost);
        reviewPreview = suggestionResult.preview;
        criteriaModelUsage = formatModelUsage('Criteria suggestion call inference', suggestionResult.usage);
      }
    } else draft = draftPromptEvidence(goalText);
  }
  catch (error) {
    console.error(`could not prepare the prompt-evidence draft: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}; no request was written`);
    return 3;
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(reviewPreview ?? draft.request, null, 2)}\n`);
    const mapped = `${draft.sourceCoverage.mappedNonWhitespaceCharacters}/${draft.sourceCoverage.nonWhitespaceCharacters}`;
    const suggestionWarning = reviewPreview ? ' Criterion and evidence suggestions are advisory only, unreviewed, may contain unstated assumptions, and are not added to the request; the verdict remains NOT PROVEN.' : '';
    console.error(`DRAFT ONLY — NOT PROVEN. Extractor: ${extractorLabel}.${modelUsage}${criteriaModelUsage} Source text mapped: ${mapped} non-whitespace characters.${suggestionWarning} ${draft.notes.join(' ')}`);
  } else {
    console.log(`DRAFT ONLY — NOT PROVEN. Extractor: ${extractorLabel}. This command made no project changes.${reviewPreview ? ' Criterion and evidence suggestions are advisory only, may contain unstated assumptions, and require human review.' : ''}`);
    console.log(`Source text mapped: ${draft.sourceCoverage.mappedNonWhitespaceCharacters}/${draft.sourceCoverage.nonWhitespaceCharacters} non-whitespace characters.`);
    if (modelUsage) console.log(modelUsage.trim());
    if (criteriaModelUsage) console.log(criteriaModelUsage.trim());
    for (const [index, candidate] of draft.candidates.entries()) {
      console.log(`${index + 1}. [UNCLEAR] ${candidate.text} (focus ${candidate.sourceRef.focusStart}:${candidate.sourceRef.focusEnd}; mapped source ${candidate.sourceRef.start}:${candidate.sourceRef.end})`);
    }
    if (reviewPreview) {
      for (const suggestion of reviewPreview.suggestions) {
        console.log(`  Review suggestions for ${suggestion.requirementId} — ${suggestion.sourceText}`);
        if (suggestion.criteria.length === 0) console.log('    No criteria suggested; clarify or write criteria manually.');
        for (const criterion of suggestion.criteria) {
          console.log(`    Unreviewed criterion idea: ${criterion.statement}`);
          console.log(`    Possible evidence (not collected): ${criterion.evidenceIdea}`);
          for (const assumption of criterion.assumptions) console.log(`    Assumption to review: ${assumption}`);
          for (const warning of criterion.reviewWarnings) console.log(`    Review warning: ${warning}`);
        }
      }
    }
    for (const note of draft.notes) console.log(`Review: ${note}`);
  }
  return 0;
}
