import { createHash, randomUUID } from 'node:crypto';

export const PROMPT_EVIDENCE_SCHEMA = 'amabie-prompt-evidence/1' as const;
export const MAX_CORRECTION_CYCLES = 3 as const;
const MAX_GOAL_CHARS = 64_000;
const MAX_REQUIREMENTS = 64;
const MAX_CRITERIA_PER_REQUIREMENT = 32;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type RequirementStatus = 'met' | 'unmet' | 'unproven' | 'blocked';
export type PromptVerdict = 'PASS' | 'FAIL' | 'NOT PROVEN' | 'BLOCKED';

export interface RegisteredTask {
  taskType: string;
  taskDigest: string;
  requirementDigests: readonly string[];
}

export interface PromptEvidenceRequest {
  schema: typeof PROMPT_EVIDENCE_SCHEMA;
  goal: { taskType: string; text: string };
  requirements: RequirementDeclaration[];
}

export interface PromptSourceCoverage {
  nonWhitespaceCharacters: number;
  mappedNonWhitespaceCharacters: number;
  overlappingSourceCharacters: number;
  unmatchedSourceReferences: number;
  complete: boolean;
}

export interface PromptEvidenceDraft {
  schema: 'amabie-prompt-evidence-draft/1';
  request: PromptEvidenceRequest;
  candidates: Array<{ id: string; text: string; sourceRef: RequirementDeclaration['sourceRef'] }>;
  reviewRequired: true;
  verdict: 'NOT PROVEN';
  sourceCoverage: PromptSourceCoverage;
  notes: string[];
}

export interface RequirementDeclaration {
  text: string;
  sourceRef: {
    kind: 'goal' | 'declared-requirement';
    start: number;
    end: number;
    excerpt: string;
    /** Exact candidate text span inside a broader source span partition. */
    focusStart?: number;
    focusEnd?: number;
  };
  clarity: 'clear' | 'unclear';
  criteria: CriterionDeclaration[];
  /** Digests (materialDigest of the text) of registered requirements this one depends on. Reviewer-declared only. */
  dependsOn?: string[];
}

export interface CriterionDeclaration {
  statement: string;
  adapterId: string;
  evidenceType: string;
  predicate: { path: string; equals: JsonPrimitive };
}

function sourceCandidateText(sourceRef: RequirementDeclaration['sourceRef']): string {
  const excerpt = sourceRef.excerpt.trim();
  const listItem = /^(?:[-*+•]|\d+[.)])\s+(.+)$/u.exec(excerpt);
  return (listItem?.[1] ?? excerpt).trim();
}

function sourceMatchesRequirement(requirement: Pick<RequirementDeclaration, 'text' | 'sourceRef'>): boolean {
  const { focusStart, focusEnd } = requirement.sourceRef;
  if (focusStart !== undefined || focusEnd !== undefined) {
    if (focusStart === undefined || focusEnd === undefined
      || !Number.isSafeInteger(focusStart) || !Number.isSafeInteger(focusEnd)
      || focusStart < requirement.sourceRef.start || focusEnd < focusStart || focusEnd > requirement.sourceRef.end) return false;
    return requirement.sourceRef.excerpt.slice(
      focusStart - requirement.sourceRef.start,
      focusEnd - requirement.sourceRef.start,
    ) === requirement.text;
  }
  if (requirement.sourceRef.kind === 'declared-requirement') return requirement.sourceRef.excerpt === requirement.text;
  return sourceCandidateText(requirement.sourceRef) === requirement.text;
}

function promptSourceCoverage(
  goalText: string,
  requirements: readonly Pick<RequirementDeclaration, 'text' | 'sourceRef'>[],
): PromptSourceCoverage {
  const covered = new Uint8Array(goalText.length);
  let overlappingSourceCharacters = 0;
  for (const requirement of requirements) {
    if (requirement.sourceRef.kind !== 'goal') continue;
    for (let i = requirement.sourceRef.start; i < requirement.sourceRef.end; i += 1) {
      if (/\s/u.test(goalText[i]!)) continue;
      if (covered[i] === 1) overlappingSourceCharacters += 1;
      else covered[i] = 1;
    }
  }
  let nonWhitespaceCharacters = 0;
  let mappedNonWhitespaceCharacters = 0;
  for (let i = 0; i < goalText.length; i += 1) {
    if (/\s/u.test(goalText[i]!)) {
      continue;
    }
    nonWhitespaceCharacters += 1;
    if (covered[i] === 1) mappedNonWhitespaceCharacters += 1;
  }
  const unmatchedSourceReferences = requirements.filter(requirement => !sourceMatchesRequirement(requirement)).length;
  return {
    nonWhitespaceCharacters,
    mappedNonWhitespaceCharacters,
    overlappingSourceCharacters,
    unmatchedSourceReferences,
    complete: mappedNonWhitespaceCharacters === nonWhitespaceCharacters
      && overlappingSourceCharacters === 0
      && unmatchedSourceReferences === 0,
  };
}

export interface ValidatedCriterion extends CriterionDeclaration {
  id: string;
}

export interface ValidatedRequirement extends Omit<RequirementDeclaration, 'criteria'> {
  id: string;
  digest: string;
  criteria: ValidatedCriterion[];
}

export interface ValidatedPromptEvidenceRequest {
  schema: typeof PROMPT_EVIDENCE_SCHEMA;
  goal: { taskType: string; text: string };
  goalDigest: string;
  requirements: ValidatedRequirement[];
  requirementDigests: string[];
  sourceCoverage: PromptSourceCoverage;
  scopeDigest: string;
}

export interface EvidenceDraft {
  requirementId: string;
  criterionId: string;
  evidenceType: string;
  facts: JsonValue;
  artifactRefs?: string[];
}

export interface EvidenceRecord extends EvidenceDraft {
  id: string;
  adapterId: string;
  taskType: string;
  runId: string;
  attempt: number;
  collectedAt: string;
  provenance: 'verifier-collected';
  integrity: { algorithm: 'sha256'; digest: string; label: 'tamper-evidence-only' };
}

export interface AdapterCollection {
  evidence: readonly EvidenceDraft[];
  blocked?: readonly { criterionId: string; reason: string }[];
  unproven?: readonly { criterionId: string; reason: string }[];
}

export interface VerificationContext {
  runId: string;
  attempt: number;
}

/** A domain adapter collects facts; it never returns a verdict or requirement status. */
export interface VerifierAdapter {
  readonly id: string;
  readonly taskType: string;
  collect(
    request: ValidatedPromptEvidenceRequest,
    criteria: readonly { requirement: ValidatedRequirement; criterion: ValidatedCriterion }[],
    context: VerificationContext,
  ): Promise<AdapterCollection>;
}

export interface CriterionEvaluation {
  criterionId: string;
  status: RequirementStatus;
  note: string;
  evidenceId?: string;
}

export interface RequirementEvaluation {
  id: string;
  text: string;
  clarity: 'clear' | 'unclear';
  note: string;
  status: RequirementStatus;
  criteria: CriterionEvaluation[];
  dependsOn?: string[];
}

export interface VerificationReport {
  schema: 'amabie-prompt-evidence-report/2';
  taskType: string;
  goalDigest: string;
  scopeDigest: string;
  runId: string;
  attempt: number;
  verdict: PromptVerdict;
  requirements: RequirementEvaluation[];
  evidence: EvidenceRecord[];
  sourceCoverage: PromptSourceCoverage;
  coverage: { total: number; met: number; unmet: number; unproven: number; blocked: number };
  issues: string[];
}

export interface CorrectionReport {
  schema: 'amabie-correction-report/3';
  goalDigest: string;
  scopeDigest: string;
  attempt: number;
  scopeGaps: string[];
  unresolved: Array<{
    requirementId: string;
    requirement: string;
    status: RequirementStatus;
    gaps: string[];
    criteria: Array<{
      criterionId: string;
      statement: string;
      adapterId: string;
      evidenceType: string;
      predicate: { path: string; equals: JsonPrimitive };
      status: RequirementStatus;
      gap: string;
    }>;
  }>;
  instruction: 'Address only the listed gaps within the original authorized task; do not broaden scope.';
}

export interface CorrectionLoopResult {
  status: 'verified' | 'scope-incomplete' | 'not-authorized' | 'no-corrector' | 'correction-blocked' | 'scope-change-blocked' | 'limit-reached';
  verification: VerificationReport;
  correctionAttempts: number;
  correctionReport: CorrectionReport | null;
  stopReason: string | null;
}

export interface CorrectionLoopOptions {
  request: ValidatedPromptEvidenceRequest;
  adapters: readonly VerifierAdapter[];
  /** This must only be true after the caller has authorized workspace changes. */
  authorized: boolean;
  /** A per-run cap that can lower, but never raise, the hard three-cycle maximum. */
  maxAttempts?: number;
  correct?: (input: { report: CorrectionReport; cycle: number }) => Promise<{
    outcome: 'applied' | 'no-change' | 'blocked';
    /** The executor reports the unchanged, request-derived scope fingerprint. */
    scopeDigest: string;
    reason?: string;
  }>;
  makeRunId?: () => string;
}

export function normalizeTaskText(text: string): string {
  return text.trim().replace(/\s+/gu, ' ');
}

export function materialDigest(text: string): string {
  return createHash('sha256').update(normalizeTaskText(text), 'utf8').digest('hex');
}

function validateDraftInput(goalText: string, taskType: string): void {
  if (typeof goalText !== 'string' || goalText.trim() === '' || goalText.length > MAX_GOAL_CHARS) {
    throw new Error('the original goal must be non-empty and no longer than 64,000 characters');
  }
  if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(taskType)) {
    throw new Error('taskType must be a short, lowercase task-domain identifier');
  }
}

function conditionalComma(goalText: string, contentStart: number, commaIndex: number): boolean {
  const beforeComma = goalText.slice(contentStart, commaIndex);
  const sentenceStart = Math.max(
    beforeComma.lastIndexOf('.'),
    beforeComma.lastIndexOf('!'),
    beforeComma.lastIndexOf('?'),
    beforeComma.lastIndexOf(';'),
  ) + 1;
  const clause = beforeComma.slice(sentenceStart);
  return /(?:^|,\s*(?:and\s+)?)(?:if|when|unless|provided(?: that)?|assuming|as long as|in case|once|after|before)\b/iu.test(clause.trim());
}

function makePromptEvidenceDraft(
  goalText: string,
  taskType: string,
  requirements: RequirementDeclaration[],
  notes: string[],
): PromptEvidenceDraft {
  const request: PromptEvidenceRequest = {
    schema: PROMPT_EVIDENCE_SCHEMA,
    goal: { taskType, text: goalText },
    requirements,
  };
  const registeredTask: RegisteredTask = {
    taskType,
    taskDigest: materialDigest(goalText),
    requirementDigests: requirements.map(requirement => materialDigest(requirement.text)),
  };
  const validated = validatePromptEvidenceRequest(request, registeredTask);
  return {
    schema: 'amabie-prompt-evidence-draft/1',
    request,
    candidates: validated.requirements.map(({ id, text, sourceRef }) => ({ id, text, sourceRef })),
    reviewRequired: true,
    verdict: 'NOT PROVEN',
    sourceCoverage: validated.sourceCoverage,
    notes,
  };
}

const ACTION_CLAUSE_VERBS = [
  'implement', 'add', 'build', 'create', 'ensure', 'validate', 'verify', 'reject', 'store', 'hash', 'encrypt',
  'preserve', 'maintain', 'support', 'update', 'remove', 'write', 'generate', 'run', 'document', 'include', 'use',
  'prevent', 'return', 'expose', 'handle', 'log', 'measure', 'compare', 'detect', 'report', 'keep', 'provide',
  'check', 'test', 'parse', 'render', 'display', 'allow', 'require', 'configure', 'install', 'record', 'list', 'total',
  'show', 'send', 'accept', 'attach', 'deny', 'sanitize', 'escape', 'encode', 'decode', 'restore', 'delete',
  'refuse', 'export', 'neutralize',
] as const;

function thirdPersonAction(verb: string): string {
  if (/[^aeiou]y$/u.test(verb)) return `${verb.slice(0, -1)}ies`;
  if (/(?:s|x|z|ch|sh|o)$/u.test(verb)) return `${verb}es`;
  return `${verb}s`;
}

function actionGerund(verb: string): string {
  if (verb.endsWith('ie')) return `${verb.slice(0, -2)}ying`;
  if (verb.endsWith('e') && !verb.endsWith('ee')) return `${verb.slice(0, -1)}ing`;
  if (/^[^aeiou]*[aeiou][^aeiouwxy]$/u.test(verb) && !/(.)\1$/u.test(verb)) {
    return `${verb}${verb.at(-1)}ing`;
  }
  return `${verb}ing`;
}

const ACTION_CLAUSE_PATTERN = [...new Set(ACTION_CLAUSE_VERBS.flatMap(verb => [
  verb,
  // In prompts, "tests" is commonly a noun in lists such as "validation, tests, and storage".
  ...(verb === 'test' ? [] : [thirdPersonAction(verb)]),
]))].join('|');
const ACTION_GERUND_PATTERN = [...new Set(ACTION_CLAUSE_VERBS.map(actionGerund))].join('|');
const SUBJECT_MODAL_ACTION_PATTERN = '(?:(?!if\\b|when\\b|unless\\b|provided\\b|assuming\\b|once\\b|before\\b|after\\b|while\\b|because\\b)[\\p{L}\\p{N}_-]+[ \\t]+){1,6}(?:must|should|can|cannot|will|shall|may|might)(?:[ \\t]+(?:not|never))?[ \\t]+(?:' + ACTION_CLAUSE_PATTERN + ')\\b';
const ACTION_CLAUSE_START_PATTERN = '(?:' + ACTION_CLAUSE_PATTERN + '|' + SUBJECT_MODAL_ACTION_PATTERN + ')';

/**
 * Produce review-only source-linked candidates from the exact goal text. The
 * deterministic splitter recognizes line/list, sentence, semicolon, and
 * conservative action-clause boundaries. Commas inside coordinated lists and
 * conditional clauses are preserved. Subject-modal coordinated actions are split conservatively. Candidates remain unclear: segmentation
 * is a traceable proposal, not proof of semantic completeness.
 */
export function draftPromptEvidence(goalText: string, taskType = 'coding'): PromptEvidenceDraft {
  validateDraftInput(goalText, taskType);

  const requirements: RequirementDeclaration[] = [];
  const separator = new RegExp(String.raw`,\s*(?:(?:and|but|then|also)\s+)?(?=(?:${ACTION_CLAUSE_START_PATTERN})\b)|;\s*(?:(?:and|but|then|also)\s+)?|\s+(?:and|but|then|also)\s+(?=(?:${ACTION_CLAUSE_START_PATTERN})\b)|\s+while\s+(?=(?:${ACTION_GERUND_PATTERN})\b)|(?<!\be\.g\.)(?<!\bi\.e\.)(?<!\bvs\.)(?<=\.)\s+(?=[A-Z0-9])|(?<=[!?])\s+(?=[A-Z0-9])`, 'giu');
  let lineStart = 0;
  while (lineStart <= goalText.length) {
    const newline = goalText.indexOf('\n', lineStart);
    const rawLineEnd = newline < 0 ? goalText.length : newline;
    const lineEnd = rawLineEnd > lineStart && goalText[rawLineEnd - 1] === '\r' ? rawLineEnd - 1 : rawLineEnd;
    const line = goalText.slice(lineStart, lineEnd);
    const first = line.search(/\S/u);
    if (first >= 0) {
      let last = line.length;
      while (last > first && /\s/u.test(line[last - 1]!)) last -= 1;
      const start = lineStart + first;
      const end = lineStart + last;
      const excerpt = goalText.slice(start, end);
      const listItem = /^(?:[-*+•]|\d+[.)])\s+/u.exec(excerpt);
      const contentStart = start + (listItem?.[0].length ?? 0);
      const focusRanges: Array<{ start: number; end: number }> = [];
      let focusStart = contentStart;
      separator.lastIndex = contentStart;
      for (let boundary = separator.exec(goalText); boundary !== null && boundary.index < end; boundary = separator.exec(goalText)) {
        if (goalText[boundary.index] === ',' && conditionalComma(goalText, contentStart, boundary.index)) continue;
        let focusEnd = boundary.index;
        while (focusEnd > focusStart && /\s/u.test(goalText[focusEnd - 1]!)) focusEnd -= 1;
        while (focusStart < focusEnd && /\s/u.test(goalText[focusStart]!)) focusStart += 1;
        if (focusEnd > focusStart) focusRanges.push({ start: focusStart, end: focusEnd });
        focusStart = boundary.index + boundary[0].length;
      }
      let focusEnd = end;
      while (focusEnd > focusStart && /\s/u.test(goalText[focusEnd - 1]!)) focusEnd -= 1;
      while (focusStart < focusEnd && /\s/u.test(goalText[focusStart]!)) focusStart += 1;
      if (focusEnd > focusStart) focusRanges.push({ start: focusStart, end: focusEnd });

      for (let index = 0; index < focusRanges.length; index += 1) {
        const focus = focusRanges[index]!;
        const sourceStart = index === 0 ? start : focus.start;
        const sourceEnd = focusRanges[index + 1]?.start ?? end;
        const text = goalText.slice(focus.start, focus.end);
        requirements.push({
          text,
          sourceRef: {
            kind: 'goal', start: sourceStart, end: sourceEnd,
            excerpt: goalText.slice(sourceStart, sourceEnd),
            focusStart: focus.start,
            focusEnd: focus.end,
          },
          clarity: 'unclear',
          criteria: [],
        });
        if (requirements.length > MAX_REQUIREMENTS) {
          throw new Error(`the draft contains more than ${MAX_REQUIREMENTS} candidates; review and reduce the task before drafting`);
        }
      }
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }

  return makePromptEvidenceDraft(goalText, taskType, requirements, [
      'Candidates are split with deterministic line, sentence, semicolon, and conservative action-clause boundaries; commas inside coordinated lists and conditional clauses are preserved. Exact focus offsets link every candidate back to the original prompt.',
      'This heuristic does not establish semantic completeness. Review every candidate, split any remaining compound request, resolve unclear wording, and add independently verifiable criteria.',
      'Every candidate starts unclear with no criteria, so this draft cannot produce PASS.',
  ]);
}

function unquotedSourceFragments(
  goalText: string,
  ranges: readonly { start: number; end: number }[],
): Array<{ start: number; end: number; text: string; candidateStart: number; candidateEnd: number }> {
  const connectiveWords = new Set(['and', 'or', 'then', 'also', 'but', 'that', 'while', 'please']);
  const fragments: Array<{ start: number; end: number; text: string; candidateStart: number; candidateEnd: number }> = [];
  let cursor = 0;
  const inspectGap = (start: number, end: number) => {
    const text = goalText.slice(start, end);
    const words = [...text.matchAll(/[\p{L}\p{N}]+/gu)];
    const substantive = words.filter(word => {
      const value = word[0]!.toLowerCase();
      if (connectiveWords.has(value)) return false;
      if (!/^\d+$/u.test(value)) return true;
      const lineStart = text.lastIndexOf('\n', word.index! - 1) + 1;
      const lineEndIndex = text.indexOf('\n', word.index!);
      const lineEnd = lineEndIndex < 0 ? text.length : lineEndIndex;
      const before = text.slice(lineStart, word.index);
      const after = text.slice(word.index! + word[0]!.length, lineEnd);
      return !/^\s*$/u.test(before) || !/^\s*[.)]\s*$/u.test(after);
    });
    if (substantive.length === 0) return;
    const candidateStart = start + substantive[0]!.index!;
    const last = substantive.at(-1)!;
    const candidateEnd = start + last.index! + last[0]!.length;
    fragments.push({ start, end, text: text.trim(), candidateStart, candidateEnd });
  };

  for (const range of ranges) {
    inspectGap(cursor, range.start);
    cursor = range.end;
  }
  inspectGap(cursor, goalText.length);
  return fragments;
}

/**
 * Build review-only requirements from exact, model-proposed source quotes. The
 * model chooses candidate boundaries; this core maps each quote to one distinct
 * source occurrence, rejects incomplete repeated-quote mappings, overlaps and
 * paraphrases, and recomputes complete lexical coverage.
 * It never accepts model-proposed clarity, criteria, evidence, or verdicts.
 */
export function draftPromptEvidenceFromQuotes(
  goalText: string,
  quotes: readonly string[],
  taskType = 'coding',
): PromptEvidenceDraft {
  validateDraftInput(goalText, taskType);
  if (!Array.isArray(quotes) || quotes.length === 0) throw new Error('at least one exact source quote is required');
  if (quotes.length > MAX_REQUIREMENTS) throw new Error(`the extractor returned more than ${MAX_REQUIREMENTS} candidates`);

  const validatedQuotes = quotes.map((quote, index) => {
    if (typeof quote !== 'string' || quote.length === 0 || quote.trim() !== quote || quote.length > 8_000) {
      throw new Error(`candidate ${index + 1} must be a non-empty exact source quote without outer whitespace and no longer than 8,000 characters`);
    }
    return quote;
  });
  const candidateCounts = new Map<string, number>();
  for (const quote of validatedQuotes) candidateCounts.set(quote, (candidateCounts.get(quote) ?? 0) + 1);

  const sourceOccurrences = new Map<string, number[]>();
  for (const [quote, candidateCount] of candidateCounts) {
    const occurrences: number[] = [];
    let offset = 0;
    while (offset <= goalText.length - quote.length) {
      const start = goalText.indexOf(quote, offset);
      if (start < 0) break;
      occurrences.push(start);
      offset = start + 1;
    }
    const candidateIndex = validatedQuotes.indexOf(quote) + 1;
    if (occurrences.length === 0) throw new Error(`candidate ${candidateIndex} is not an exact source quote`);
    if (occurrences.length > candidateCount) {
      throw new Error(`candidate ${candidateIndex} is ambiguous because it occurs more than once in the original prompt and not every occurrence has a candidate`);
    }
    if (occurrences.length < candidateCount) {
      throw new Error(`candidate ${candidateIndex} occurrence count does not match the exact source occurrences in the original prompt`);
    }
    sourceOccurrences.set(quote, occurrences);
  }

  const nextOccurrence = new Map<string, number>();
  const ranges = validatedQuotes.map(quote => {
    const occurrenceIndex = nextOccurrence.get(quote) ?? 0;
    const start = sourceOccurrences.get(quote)![occurrenceIndex]!;
    nextOccurrence.set(quote, occurrenceIndex + 1);
    return { start, end: start + quote.length, text: quote };
  }).sort((left, right) => left.start - right.start);

  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index]!.start < ranges[index - 1]!.end) throw new Error('extractor candidate source quotes overlap');
  }

  const unquotedFragments = unquotedSourceFragments(goalText, ranges);
  const candidateRanges = [
    ...ranges,
    ...unquotedFragments.map(fragment => ({ start: fragment.candidateStart, end: fragment.candidateEnd })),
  ].sort((left, right) => left.start - right.start);
  for (let index = 1; index < candidateRanges.length; index += 1) {
    if (candidateRanges[index]!.start < candidateRanges[index - 1]!.end) {
      throw new Error('the extractor produced overlapping source candidates after omitted text recovery');
    }
  }

  const reviewNotes: string[] = [];
  if (unquotedFragments.length > 0) {
    const shownFragments = unquotedFragments.slice(0, 4).map(fragment => {
      const excerpt = fragment.text.length > 160 ? `${fragment.text.slice(0, 157)}…` : fragment.text;
      return `“${excerpt}”`;
    });
    const remaining = unquotedFragments.length - shownFragments.length;
    reviewNotes.push(`Unquoted prompt text was not covered by the extractor's exact quotes and has been preserved as additional unresolved candidates: ${shownFragments.join(', ')}${remaining > 0 ? `, and ${remaining} more fragment(s)` : ''}. Review each candidate and split any compound obligations before registering.`);
  }

  const requirements: RequirementDeclaration[] = candidateRanges.map((focus, index) => {
    const sourceStart = index === 0 ? 0 : focus.start;
    const sourceEnd = candidateRanges[index + 1]?.start ?? goalText.length;
    const text = goalText.slice(focus.start, focus.end);
    if (text.length > 8_000) throw new Error(`candidate ${index + 1} exceeds 8,000 characters after omitted prompt text recovery; shorten the prompt and review it in smaller parts`);
    return {
      text,
      sourceRef: {
        kind: 'goal',
        start: sourceStart,
        end: sourceEnd,
        excerpt: goalText.slice(sourceStart, sourceEnd),
        focusStart: focus.start,
        focusEnd: focus.end,
      },
      clarity: 'unclear',
      criteria: [],
    };
  });

  return makePromptEvidenceDraft(goalText, taskType, requirements, [...reviewNotes,
    'An extractor proposed exact source quotes. The core matched each candidate to a distinct exact source occurrence, rejected incomplete repeated-quote coverage and overlaps, and mapped every prompt character to a source span.',
    'Source coverage is lexical, not semantic completeness. Review every candidate, split remaining compound requirements, resolve unclear wording, and add independently verifiable criteria.',
    'The model cannot set clarity, criteria, evidence, or verdicts. Every candidate remains unclear with no criteria, so this draft cannot produce PASS.',
  ]);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite numbers are not JSON evidence');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  throw new Error('value is not JSON-serializable');
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 10_000 && value.every(v => isJsonValue(v, depth + 1));
  return isRecord(value) && Object.keys(value).length <= 10_000
    && Object.values(value).every(v => isJsonValue(v, depth + 1));
}

function stableRequirementId(
  goalDigest: string,
  declaration: RequirementDeclaration,
  digest: string,
  duplicateOrdinal: number,
): string {
  return `req_${hash({ goalDigest, digest, sourceRef: declaration.sourceRef, duplicateOrdinal }).slice(0, 20)}`;
}

function stableCriterionId(requirementId: string, criterion: CriterionDeclaration, ordinal: number): string {
  return `crit_${hash({ requirementId, criterion, ordinal }).slice(0, 20)}`;
}

function scopeFingerprint(request: Pick<ValidatedPromptEvidenceRequest, 'goal' | 'goalDigest' | 'requirements'>): string {
  return hash({
    taskType: request.goal.taskType,
    goalDigest: request.goalDigest,
    requirements: request.requirements.map(r => ({
      id: r.id, digest: r.digest, clarity: r.clarity,
      criteria: r.criteria.map(c => c.id),
      // Only bound when declared, so scope digests of requests without dependencies stay unchanged.
      ...(r.dependsOn && r.dependsOn.length > 0 ? { dependsOn: r.dependsOn } : {}),
    })),
  });
}

/** dependsOn must name registered, unambiguous requirements other than itself, without cycles. */
function validateDependencies(declarations: RequirementDeclaration[]): void {
  const counts = new Map<string, number>();
  for (const d of declarations) counts.set(materialDigest(d.text), (counts.get(materialDigest(d.text)) ?? 0) + 1);
  const edges = new Map<string, string[]>();
  for (const d of declarations) {
    const own = materialDigest(d.text);
    for (const dep of d.dependsOn ?? []) {
      if (dep === own) throw new Error('a requirement cannot depend on itself');
      if (!counts.has(dep)) throw new Error('dependsOn names a requirement that is not registered');
      if (counts.get(dep)! > 1) throw new Error('dependsOn names a requirement whose text is declared more than once and is ambiguous');
    }
    if (d.dependsOn?.length) edges.set(own, d.dependsOn);
  }
  const state = new Map<string, 1 | 2>();
  const visit = (node: string): void => {
    if (state.get(node) === 2) return;
    if (state.get(node) === 1) throw new Error('dependsOn contains a cycle');
    state.set(node, 1);
    for (const next of edges.get(node) ?? []) visit(next);
    state.set(node, 2);
  };
  for (const node of edges.keys()) visit(node);
}

/** Validate that the agent's structured proposal neither drops nor adds an authorized requirement. */
export function validatePromptEvidenceRequest(
  input: unknown,
  registeredTask: RegisteredTask,
): ValidatedPromptEvidenceRequest {
  if (!isRecord(input) || input.schema !== PROMPT_EVIDENCE_SCHEMA) throw new Error(`request schema must be ${PROMPT_EVIDENCE_SCHEMA}`);
  if (!isRecord(input.goal) || typeof input.goal.taskType !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/u.test(input.goal.taskType)) {
    throw new Error('goal.taskType must be a short, lowercase task-domain identifier');
  }
  const goal = input.goal as Record<string, unknown>;
  if (registeredTask.taskType !== goal.taskType) throw new Error('goal task type does not match the task registered with Amabie');
  if (typeof goal.text !== 'string' || goal.text.trim() === '' || goal.text.length > MAX_GOAL_CHARS) {
    throw new Error('goal.text must contain the original user task and stay within 64,000 characters');
  }
  if (materialDigest(goal.text as string) !== registeredTask.taskDigest) throw new Error('goal.text does not match the task registered with Amabie');
  if (!Array.isArray(input.requirements) || input.requirements.length > MAX_REQUIREMENTS) throw new Error(`requirements must be an array of at most ${MAX_REQUIREMENTS} items`);
  if (input.requirements.length !== registeredTask.requirementDigests.length) throw new Error('the structured request must include every registered requirement exactly once');

  const declarations = input.requirements.map((value, index): RequirementDeclaration => {
    if (!isRecord(value) || typeof value.text !== 'string' || value.text.trim() === '') throw new Error(`requirements[${index}].text must be non-empty`);
    if (value.text.length > 8_000) throw new Error(`requirements[${index}].text exceeds 8,000 characters`);
    if (!isRecord(value.sourceRef) || (value.sourceRef.kind !== 'goal' && value.sourceRef.kind !== 'declared-requirement')
      || !Number.isSafeInteger(value.sourceRef.start) || !Number.isSafeInteger(value.sourceRef.end)
      || typeof value.sourceRef.excerpt !== 'string') throw new Error(`requirements[${index}].sourceRef is invalid`);
    const sourceRef = value.sourceRef as unknown as RequirementDeclaration['sourceRef'];
    const hasFocusStart = sourceRef.focusStart !== undefined;
    const hasFocusEnd = sourceRef.focusEnd !== undefined;
    if (hasFocusStart !== hasFocusEnd
      || (hasFocusStart && (!Number.isSafeInteger(sourceRef.focusStart) || !Number.isSafeInteger(sourceRef.focusEnd)))) {
      throw new Error(`requirements[${index}].sourceRef focus offsets are invalid`);
    }
    if (sourceRef.start < 0 || sourceRef.end < sourceRef.start || sourceRef.end - sourceRef.start !== sourceRef.excerpt.length) {
      throw new Error(`requirements[${index}].sourceRef offsets do not match the excerpt`);
    }
    if (sourceRef.kind === 'goal') {
      if ((sourceRef.end > (goal.text as string).length) || (goal.text as string).slice(sourceRef.start, sourceRef.end) !== sourceRef.excerpt) {
        throw new Error(`requirements[${index}].sourceRef does not quote the original goal at its stated offsets`);
      }
      if (hasFocusStart && (sourceRef.focusStart! < sourceRef.start || sourceRef.focusEnd! < sourceRef.focusStart!
        || sourceRef.focusEnd! > sourceRef.end || (goal.text as string).slice(sourceRef.focusStart, sourceRef.focusEnd) !== value.text)) {
        throw new Error(`requirements[${index}].sourceRef focus offsets do not quote the exact candidate text`);
      }
    } else if (sourceRef.start !== 0 || sourceRef.end !== value.text.length || sourceRef.excerpt !== value.text) {
      throw new Error(`requirements[${index}].sourceRef for a declared requirement must quote that exact requirement`);
    } else if (hasFocusStart) {
      throw new Error(`requirements[${index}].sourceRef focus offsets are only supported for goal-linked requirements`);
    }
    if (value.clarity !== 'clear' && value.clarity !== 'unclear') throw new Error(`requirements[${index}].clarity must be clear or unclear`);
    if (!Array.isArray(value.criteria) || value.criteria.length > MAX_CRITERIA_PER_REQUIREMENT) {
      throw new Error(`requirements[${index}].criteria must be an array of at most ${MAX_CRITERIA_PER_REQUIREMENT} items`);
    }
    const criteria = value.criteria.map((raw, criterionIndex): CriterionDeclaration => {
      if (!isRecord(raw) || typeof raw.statement !== 'string' || raw.statement.trim() === ''
        || typeof raw.adapterId !== 'string' || !/^[a-z][a-z0-9._-]{0,95}$/u.test(raw.adapterId)
        || typeof raw.evidenceType !== 'string' || !/^[a-z][a-z0-9._-]{0,95}$/u.test(raw.evidenceType)
        || !isRecord(raw.predicate) || typeof raw.predicate.path !== 'string' || !raw.predicate.path.startsWith('/')
        || !Object.hasOwn(raw.predicate, 'equals') || !isJsonValue(raw.predicate.equals)
        || Array.isArray(raw.predicate.equals) || isRecord(raw.predicate.equals)) {
        throw new Error(`requirements[${index}].criteria[${criterionIndex}] must define an adapter, evidence type, JSON Pointer predicate, and scalar expected value`);
      }
      return {
        statement: raw.statement,
        adapterId: raw.adapterId,
        evidenceType: raw.evidenceType,
        predicate: { path: raw.predicate.path, equals: raw.predicate.equals as JsonPrimitive },
      };
    });
    const sourceMatches = sourceMatchesRequirement({ text: value.text, sourceRef });
    let dependsOn: string[] | undefined;
    if (value.dependsOn !== undefined) {
      if (!Array.isArray(value.dependsOn) || value.dependsOn.length > MAX_REQUIREMENTS
        || !value.dependsOn.every(d => typeof d === 'string')) {
        throw new Error(`requirements[${index}].dependsOn must be an array of requirement digests`);
      }
      dependsOn = [...new Set(value.dependsOn as string[])].sort();
    }
    return {
      text: value.text,
      sourceRef,
      clarity: value.clarity === 'clear' && !sourceMatches ? 'unclear' : value.clarity,
      criteria,
      ...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
    };
  });

  const registered = [...registeredTask.requirementDigests].sort();
  const proposed = declarations.map(r => materialDigest(r.text)).sort();
  if (registered.some((digest, i) => digest !== proposed[i])) throw new Error('the structured requirements do not exactly match the requirements registered with Amabie');
  validateDependencies(declarations);
  const goalDigest = materialDigest(goal.text as string);
  const duplicateCounts = new Map<string, number>();
  const requirements: ValidatedRequirement[] = declarations.map(declaration => {
    const digest = materialDigest(declaration.text);
    const ordinal = duplicateCounts.get(digest) ?? 0;
    duplicateCounts.set(digest, ordinal + 1);
    const id = stableRequirementId(goalDigest, declaration, digest, ordinal);
    return {
      ...declaration,
      id,
      digest,
      criteria: declaration.criteria.map((criterion, index) => ({
        ...criterion,
        id: stableCriterionId(id, criterion, index),
      })),
    };
  });
  if (new Set(requirements.map(r => r.id)).size !== requirements.length) throw new Error('requirement IDs are not unique; disambiguate their source references');
  const validated: ValidatedPromptEvidenceRequest = {
    schema: PROMPT_EVIDENCE_SCHEMA,
    goal: { taskType: input.goal.taskType, text: goal.text as string },
    goalDigest,
    requirements,
    requirementDigests: requirements.map(r => r.digest),
    sourceCoverage: promptSourceCoverage(goal.text as string, declarations),
    scopeDigest: '',
  };
  validated.scopeDigest = scopeFingerprint(validated);
  return validated;
}

function pointerValue(value: JsonValue, pointer: string): { found: boolean; value?: JsonValue } {
  if (pointer === '') return { found: true, value };
  let current: JsonValue = value;
  const parts = pointer.split('/').slice(1).map(p => p.replace(/~1/gu, '/').replace(/~0/gu, '~'));
  for (const part of parts) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/u.test(part)) return { found: false };
      const index = Number(part);
      if (index >= current.length) return { found: false };
      current = current[index]!;
    } else if (isRecord(current) && Object.hasOwn(current, part)) {
      const next = current[part];
      if (!isJsonValue(next)) return { found: false };
      current = next;
    } else return { found: false };
  }
  return { found: true, value: current };
}

function evidencePayload(record: Omit<EvidenceRecord, 'integrity'>): unknown {
  return {
    id: record.id,
    adapterId: record.adapterId,
    taskType: record.taskType,
    requirementId: record.requirementId,
    criterionId: record.criterionId,
    evidenceType: record.evidenceType,
    facts: record.facts,
    artifactRefs: record.artifactRefs ?? [],
    runId: record.runId,
    attempt: record.attempt,
    collectedAt: record.collectedAt,
    provenance: record.provenance,
  };
}

export function evidenceIntegrityValid(record: EvidenceRecord): boolean {
  if (record.integrity.algorithm !== 'sha256' || record.integrity.label !== 'tamper-evidence-only') return false;
  const { integrity: _integrity, ...payload } = record;
  return record.integrity.digest === hash(evidencePayload(payload));
}

function makeEvidence(
  draft: EvidenceDraft,
  adapterId: string,
  request: ValidatedPromptEvidenceRequest,
  context: VerificationContext,
  collectedAt: string,
): EvidenceRecord {
  const payload = {
    adapterId,
    taskType: request.goal.taskType,
    requirementId: draft.requirementId,
    criterionId: draft.criterionId,
    evidenceType: draft.evidenceType,
    facts: draft.facts,
    artifactRefs: draft.artifactRefs ?? [],
    runId: context.runId,
    attempt: context.attempt,
    collectedAt,
    provenance: 'verifier-collected' as const,
  };
  const id = `ev_${hash(payload).slice(0, 20)}`;
  const withoutIntegrity = { id, ...payload };
  return {
    id,
    ...payload,
    integrity: { algorithm: 'sha256', digest: hash(evidencePayload(withoutIntegrity)), label: 'tamper-evidence-only' },
  };
}

function statusOf(results: readonly RequirementStatus[]): RequirementStatus {
  if (results.length === 0) return 'unproven';
  if (results.includes('unmet')) return 'unmet';
  if (results.includes('blocked')) return 'blocked';
  if (results.includes('unproven')) return 'unproven';
  return 'met';
}

function sourceCoverageGaps(sourceCoverage: PromptSourceCoverage): string[] {
  const gaps: string[] = [];
  const unmapped = sourceCoverage.nonWhitespaceCharacters - sourceCoverage.mappedNonWhitespaceCharacters;
  if (unmapped > 0) gaps.push(`the original goal has ${unmapped} uncovered non-whitespace character(s) without a requirement source link`);
  if (sourceCoverage.overlappingSourceCharacters > 0) gaps.push(`requirement source references overlap on ${sourceCoverage.overlappingSourceCharacters} non-whitespace character(s)`);
  if (sourceCoverage.unmatchedSourceReferences > 0) gaps.push(`${sourceCoverage.unmatchedSourceReferences} requirement source reference(s) do not match their quoted text`);
  return gaps;
}

function verdictOf(results: readonly RequirementEvaluation[], sourceCoverageComplete = true): PromptVerdict {
  if (results.length === 0) return 'NOT PROVEN';
  const statuses = results.map(r => r.status);
  if (statuses.includes('unmet')) return 'FAIL';
  if (statuses.includes('blocked')) return 'BLOCKED';
  if (!sourceCoverageComplete || statuses.includes('unproven')) return 'NOT PROVEN';
  return 'PASS';
}

export function evaluatePromptEvidence(
  request: ValidatedPromptEvidenceRequest,
  evidence: readonly EvidenceRecord[],
  blockedCriteria: ReadonlyMap<string, string> = new Map(),
  issues: readonly string[] = [],
  context: VerificationContext = { runId: evidence[0]?.runId ?? randomUUID(), attempt: 0 },
  unprovenCriteria: ReadonlyMap<string, string> = new Map(),
): VerificationReport {
  const sourceCoverage = promptSourceCoverage(request.goal.text, request.requirements);
  const sourceCheckedRequirements = request.requirements.map(requirement =>
    sourceMatchesRequirement(requirement) ? requirement : { ...requirement, clarity: 'unclear' as const });
  const matching = new Map<string, EvidenceRecord[]>();
  for (const record of evidence) {
    const key = `${record.requirementId}\u0000${record.criterionId}`;
    const list = matching.get(key) ?? [];
    list.push(record);
    matching.set(key, list);
  }
  const requirements: RequirementEvaluation[] = sourceCheckedRequirements.map(requirement => {
    const criterionResults: CriterionEvaluation[] = requirement.criteria.map(criterion => {
      const key = `${requirement.id}\u0000${criterion.id}`;
      const blocked = blockedCriteria.get(criterion.id);
      if (blocked) return { criterionId: criterion.id, status: 'blocked', note: blocked };
      const records = matching.get(key) ?? [];
      if (records.length === 0) return { criterionId: criterion.id, status: 'unproven', note: unprovenCriteria.get(criterion.id) ?? 'no evidence was collected for this criterion' };
      if (records.length > 1) return { criterionId: criterion.id, status: 'unproven', note: 'multiple evidence records matched this criterion; the result is ambiguous' };
      const record = records[0]!;
      if (record.taskType !== request.goal.taskType || record.adapterId !== criterion.adapterId
        || record.evidenceType !== criterion.evidenceType || record.provenance !== 'verifier-collected'
        || record.runId !== context.runId || record.attempt !== context.attempt || !evidenceIntegrityValid(record)) {
        return { criterionId: criterion.id, status: 'unproven', note: 'evidence provenance, scope, or integrity validation failed' };
      }
      const observed = pointerValue(record.facts, criterion.predicate.path);
      if (!observed.found) return { criterionId: criterion.id, status: 'unproven', note: `evidence does not contain the required fact at ${criterion.predicate.path}`, evidenceId: record.id };
      if (stableJson(observed.value) !== stableJson(criterion.predicate.equals)) {
        return { criterionId: criterion.id, status: 'unmet', note: `observed ${criterion.predicate.path} contradicts the required value`, evidenceId: record.id };
      }
      return { criterionId: criterion.id, status: 'met', note: 'the deterministic evidence predicate matched', evidenceId: record.id };
    });
    const status = requirement.clarity === 'unclear'
      ? 'unproven'
      : criterionResults.length === 0
        ? 'unproven'
        : statusOf(criterionResults.map(c => c.status));
    const note = requirement.clarity === 'unclear'
      ? 'requirement clarity is unresolved; clarify or review its intended meaning before treating it as satisfied'
      : criterionResults.length === 0
        ? 'no machine-verifiable criterion was supplied for this requirement'
        : '';
    if (requirement.clarity === 'unclear') {
      for (const result of criterionResults) {
        if (result.status !== 'blocked') { result.status = 'unproven'; result.note = note; }
      }
    }
    return { id: requirement.id, text: requirement.text, clarity: requirement.clarity, note, status, criteria: criterionResults, ...(requirement.dependsOn ? { dependsOn: requirement.dependsOn } : {}) };
  });
  const counts = { total: requirements.length, met: 0, unmet: 0, unproven: 0, blocked: 0 };
  for (const requirement of requirements) counts[requirement.status] += 1;
  const allIssues = [...issues, ...sourceCoverageGaps(sourceCoverage)];
  return {
    schema: 'amabie-prompt-evidence-report/2',
    taskType: request.goal.taskType,
    goalDigest: request.goalDigest,
    scopeDigest: request.scopeDigest,
    runId: context.runId,
    attempt: context.attempt,
    verdict: verdictOf(requirements, sourceCoverage.complete),
    requirements,
    evidence: [...evidence],
    sourceCoverage,
    coverage: counts,
    issues: allIssues,
  };
}

export async function verifyPromptEvidence(
  request: ValidatedPromptEvidenceRequest,
  adapters: readonly VerifierAdapter[],
  context: VerificationContext = { runId: randomUUID(), attempt: 0 },
): Promise<VerificationReport> {
  const criteriaByAdapter = new Map<string, Array<{ requirement: ValidatedRequirement; criterion: ValidatedCriterion }>>();
  for (const requirement of request.requirements) {
    for (const criterion of requirement.criteria) {
      const group = criteriaByAdapter.get(criterion.adapterId) ?? [];
      group.push({ requirement, criterion });
      criteriaByAdapter.set(criterion.adapterId, group);
    }
  }
  const evidence: EvidenceRecord[] = [];
  const blocked = new Map<string, string>();
  const unproven = new Map<string, string>();
  const issues: string[] = [];
  const adaptersById = new Map<string, VerifierAdapter[]>();
  for (const adapter of adapters) {
    const list = adaptersById.get(adapter.id) ?? [];
    list.push(adapter);
    adaptersById.set(adapter.id, list);
  }
  for (const [adapterId, criteria] of criteriaByAdapter) {
    const candidates = (adaptersById.get(adapterId) ?? []).filter(a => a.taskType === request.goal.taskType);
    if (candidates.length !== 1) {
      const reason = candidates.length === 0 ? `no verifier adapter is available for ${adapterId} on task type ${request.goal.taskType}` : `more than one verifier adapter is registered as ${adapterId}`;
      for (const { criterion } of criteria) blocked.set(criterion.id, reason);
      issues.push(reason);
      continue;
    }
    let rawCollection: unknown;
    try {
      rawCollection = await candidates[0]!.collect(request, criteria, context);
    } catch (error) {
      const reason = `verifier adapter ${adapterId} could not complete: ${safeError(error)}`;
      for (const { criterion } of criteria) blocked.set(criterion.id, reason);
      issues.push(reason);
      continue;
    }
    if (!isRecord(rawCollection)
      || !Array.isArray(rawCollection.evidence)
      || !Array.from(rawCollection.evidence).every(isEvidenceDraft)
      || (rawCollection.blocked !== undefined && (!Array.isArray(rawCollection.blocked)
        || !Array.from(rawCollection.blocked).every(isAdapterStatus)))
      || (rawCollection.unproven !== undefined && (!Array.isArray(rawCollection.unproven)
        || !Array.from(rawCollection.unproven).every(isAdapterStatus)))) {
      const reason = `verifier adapter ${adapterId} returned an invalid collection`;
      for (const { criterion } of criteria) blocked.set(criterion.id, reason);
      issues.push(reason);
      continue;
    }
    const collection = rawCollection as unknown as AdapterCollection;
    const requested = new Map(criteria.map(({ requirement, criterion }) => [`${requirement.id}\u0000${criterion.id}`, criterion]));
    for (const item of collection.evidence) {
      const key = `${item.requirementId}\u0000${item.criterionId}`;
      const criterion = requested.get(key);
      if (!criterion || item.evidenceType !== criterion.evidenceType || !isJsonValue(item.facts)
        || (item.artifactRefs !== undefined && (!Array.isArray(item.artifactRefs) || !item.artifactRefs.every((ref: unknown) => typeof ref === 'string' && ref.length <= 512)))) {
        issues.push(`verifier adapter ${adapterId} returned unbound or malformed evidence`);
        continue;
      }
      evidence.push(makeEvidence(item, adapterId, request, context, new Date().toISOString()));
    }
    for (const item of collection.blocked ?? []) {
      const criterion = criteria.find(({ criterion }) => criterion.id === item.criterionId)?.criterion;
      if (criterion && typeof item.reason === 'string' && item.reason.trim() !== '') blocked.set(item.criterionId, item.reason.slice(0, 300));
    }
    for (const item of collection.unproven ?? []) {
      const criterion = criteria.find(({ criterion }) => criterion.id === item.criterionId)?.criterion;
      if (criterion && typeof item.reason === 'string' && item.reason.trim() !== '') unproven.set(item.criterionId, item.reason.slice(0, 300));
    }
  }
  return evaluatePromptEvidence(request, evidence, blocked, issues, context, unproven);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/gu, ' ').slice(0, 240);
}

function isEvidenceDraft(value: unknown): value is EvidenceDraft {
  return isRecord(value)
    && typeof value.requirementId === 'string'
    && typeof value.criterionId === 'string'
    && typeof value.evidenceType === 'string'
    && isJsonValue(value.facts)
    && (value.artifactRefs === undefined || (Array.isArray(value.artifactRefs)
      && value.artifactRefs.every((ref: unknown) => typeof ref === 'string' && ref.length <= 512)));
}

function isAdapterStatus(value: unknown): value is { criterionId: string; reason: string } {
  return isRecord(value) && typeof value.criterionId === 'string' && typeof value.reason === 'string';
}

export function correctionReportFor(
  report: VerificationReport,
  request: ValidatedPromptEvidenceRequest,
): CorrectionReport {
  if (report.goalDigest !== request.goalDigest
    || report.scopeDigest !== request.scopeDigest
    || report.taskType !== request.goal.taskType) {
    throw new Error('verification report does not match the verified request');
  }

  const requirements = new Map(request.requirements.map(requirement => [requirement.id, requirement]));
  if (!Array.isArray(report.requirements) || report.requirements.length !== requirements.size) {
    throw new Error('verification report does not match the verified request');
  }
  const seenRequirementIds = new Set<string>();
  for (const evaluation of report.requirements) {
    const declaration = requirements.get(evaluation.id);
    if (!declaration || declaration.text !== evaluation.text || seenRequirementIds.has(evaluation.id)
      || evaluation.criteria.length !== declaration.criteria.length) {
      throw new Error('verification report does not match the verified request');
    }
    seenRequirementIds.add(evaluation.id);
    const declaredCriterionIds = new Set(declaration.criteria.map(criterion => criterion.id));
    const evaluatedCriterionIds = new Set(evaluation.criteria.map(criterion => criterion.criterionId));
    if (evaluatedCriterionIds.size !== evaluation.criteria.length
      || evaluatedCriterionIds.size !== declaredCriterionIds.size
      || [...evaluatedCriterionIds].some(criterionId => !declaredCriterionIds.has(criterionId))) {
      throw new Error('verification report does not match the verified request');
    }
  }

  return {
    schema: 'amabie-correction-report/3',
    goalDigest: report.goalDigest,
    scopeDigest: report.scopeDigest,
    attempt: report.attempt,
    scopeGaps: sourceCoverageGaps(report.sourceCoverage),
    unresolved: report.requirements.filter(r => r.status !== 'met').map(requirement => {
      const declaration = requirements.get(requirement.id);
      if (!declaration || declaration.text !== requirement.text) {
        throw new Error('verification report does not match the verified request');
      }
      const criteria = new Map(declaration.criteria.map(criterion => [criterion.id, criterion]));
      return {
        requirementId: requirement.id,
        requirement: requirement.text,
        status: requirement.status,
        gaps: [...(requirement.note ? [requirement.note] : [])],
        criteria: requirement.criteria.filter(criterion => criterion.status !== 'met').map(criterion => {
          const criterionDeclaration = criteria.get(criterion.criterionId);
          if (!criterionDeclaration) throw new Error('verification report does not match the verified request');
          return {
            criterionId: criterion.criterionId,
            statement: criterionDeclaration.statement,
            adapterId: criterionDeclaration.adapterId,
            evidenceType: criterionDeclaration.evidenceType,
            predicate: criterionDeclaration.predicate,
            status: criterion.status,
            gap: criterion.note,
          };
        }),
      };
    }),
    instruction: 'Address only the listed gaps within the original authorized task; do not broaden scope.',
  };
}

/** Opt-in orchestration only. It does not grant filesystem authority to the corrector. */
export async function runBoundedCorrectionLoop(options: CorrectionLoopOptions): Promise<CorrectionLoopResult> {
  const maxAttempts = options.maxAttempts ?? MAX_CORRECTION_CYCLES;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_CORRECTION_CYCLES) {
    throw new Error(`maxAttempts must be an integer from 1 to ${MAX_CORRECTION_CYCLES}`);
  }
  const makeRunId = options.makeRunId ?? randomUUID;
  let verification = await verifyPromptEvidence(options.request, options.adapters, { runId: makeRunId(), attempt: 0 });
  if (verification.verdict === 'PASS') return { status: 'verified', verification, correctionAttempts: 0, correctionReport: null, stopReason: null };
  let report = correctionReportFor(verification, options.request);
  if (report.scopeGaps.length > 0) {
    return { status: 'scope-incomplete', verification, correctionAttempts: 0, correctionReport: report, stopReason: 'the original goal is not fully mapped to reviewed requirements; complete the requirement source mapping before code correction' };
  }
  if (!options.authorized) return { status: 'not-authorized', verification, correctionAttempts: 0, correctionReport: report, stopReason: 'corrections were not authorized' };
  if (!options.correct) return { status: 'no-corrector', verification, correctionAttempts: 0, correctionReport: report, stopReason: 'no correction agent callback is configured' };

  for (let cycle = 1; cycle <= maxAttempts; cycle += 1) {
    let rawCorrection: unknown;
    try { rawCorrection = await options.correct({ report, cycle }); }
    catch (error) {
      return { status: 'correction-blocked', verification, correctionAttempts: cycle, correctionReport: report, stopReason: `correction callback failed: ${safeError(error)}` };
    }
    if (!isRecord(rawCorrection)
      || (rawCorrection.outcome !== 'applied' && rawCorrection.outcome !== 'no-change' && rawCorrection.outcome !== 'blocked')
      || typeof rawCorrection.scopeDigest !== 'string'
      || (rawCorrection.reason !== undefined && typeof rawCorrection.reason !== 'string')) {
      return { status: 'correction-blocked', verification, correctionAttempts: cycle, correctionReport: report, stopReason: 'correction callback returned an invalid correction response' };
    }
    const correction = rawCorrection as Awaited<ReturnType<NonNullable<CorrectionLoopOptions['correct']>>>;
    if (correction.scopeDigest !== options.request.scopeDigest) {
      return { status: 'scope-change-blocked', verification, correctionAttempts: cycle, correctionReport: report, stopReason: 'the correction executor reported a changed scope; no further verification or correction was attempted' };
    }
    if (correction.outcome !== 'applied') {
      const reason = correction.reason?.slice(0, 300);
      return { status: 'correction-blocked', verification, correctionAttempts: cycle, correctionReport: report, stopReason: reason || (correction.outcome === 'no-change' ? 'the correction made no change' : 'the correction executor is blocked') };
    }
    verification = await verifyPromptEvidence(options.request, options.adapters, { runId: makeRunId(), attempt: cycle });
    if (verification.verdict === 'PASS') return { status: 'verified', verification, correctionAttempts: cycle, correctionReport: null, stopReason: null };
    report = correctionReportFor(verification, options.request);
  }
  return { status: 'limit-reached', verification, correctionAttempts: maxAttempts, correctionReport: report, stopReason: `the ${maxAttempts}-cycle correction limit was reached with unresolved requirements` };
}
