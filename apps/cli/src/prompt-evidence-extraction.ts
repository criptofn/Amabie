import { draftPromptEvidenceFromQuotes, type PromptEvidenceDraft } from '@amabie/prompt-evidence';

const DEFAULT_MODEL = 'qwen3.5:9b';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MODEL_TIMEOUT_MS = 120_000;

export interface OllamaExtractionResult {
  draft: PromptEvidenceDraft;
  model: string;
  promptTokens: number | null;
  responseTokens: number | null;
  inferenceDurationMs: number | null;
}

export interface PromptEvidenceReviewPreview {
  schema: 'amabie-prompt-evidence-review/1';
  authority: 'advisory-only';
  verdict: 'NOT PROVEN';
  request: PromptEvidenceDraft['request'];
  suggestions: Array<{
    requirementId: string;
    sourceText: string;
    sourceRef: PromptEvidenceDraft['candidates'][number]['sourceRef'];
    reviewStatus: 'unreviewed';
    criteria: Array<{ statement: string; evidenceIdea: string; assumptions: string[]; reviewWarnings: string[] }>;
  }>;
}

export interface OllamaModelUsage {
  promptTokens: number | null;
  responseTokens: number | null;
  inferenceDurationMs: number | null;
}

export interface OllamaCriteriaSuggestionResult {
  preview: PromptEvidenceReviewPreview;
  model: string;
  usage: OllamaModelUsage;
}

const ACTION_VERBS = new Set([
  'add', 'apply', 'build', 'check', 'compare', 'create', 'delete', 'disable', 'display', 'document', 'enable',
  'ensure', 'execute', 'expose', 'handle', 'hash', 'honor', 'include', 'log', 'maintain', 'notify',
  'keep', 'preserve', 'prevent', 'read', 'reject', 'remove', 'require', 'respect', 'retry', 'return', 'run',
  'parse', 'save', 'show', 'skip', 'store', 'support', 'test', 'try', 'update', 'use', 'validate', 'verify', 'write', 'attach',
]);

function isActionVerb(word: string): boolean {
  const normalized = word.toLowerCase();
  const candidates = [
    normalized,
    normalized.replace(/ies$/u, 'y'),
    normalized.replace(/es$/u, ''),
    normalized.replace(/s$/u, ''),
  ];
  if (normalized.endsWith('ing')) {
    const stem = normalized.slice(0, -3);
    const deDoubled = stem.replace(/([b-df-hj-np-tv-z])\1$/u, '$1');
    candidates.push(stem, `${stem}e`, deDoubled, `${deDoubled}e`);
  }
  return candidates.some(candidate => ACTION_VERBS.has(candidate));
}

function startsWithAction(clause: string, allowNegation: boolean): boolean {
  const words = clause.match(/[A-Za-z]+(?:['-][A-Za-z]+)*/gu) ?? [];
  let index = 0;
  while (['please', 'always', 'also', 'then', 'must', 'should', 'can', 'will'].includes(words[index]?.toLowerCase() ?? '')) index += 1;
  if (allowNegation && words[index]?.toLowerCase() === 'never') index += 1;
  if (allowNegation && words[index]?.toLowerCase() === 'do' && words[index + 1]?.toLowerCase() === 'not') index += 2;
  return words[index] !== undefined && isActionVerb(words[index]!);
}

function splitCoordinatedActionQuotes(goalText: string, quotes: readonly string[]): { quotes: string[]; notes: string[] } {
  const normalizedQuotes: string[] = [];
  const notes: string[] = [];
  for (const quote of quotes) {
    const start = goalText.indexOf(quote);
    if (start < 0 || goalText.indexOf(quote, start + 1) >= 0) {
      normalizedQuotes.push(quote);
      continue;
    }

    let split: { left: string; right: string } | undefined;
    for (const match of quote.matchAll(/\s+\b(?:and|but)\b\s+([A-Za-z][A-Za-z'-]*)\b/giu)) {
      const connectorStart = match.index ?? -1;
      if (connectorStart < 0 || !match[1]) continue;
      const left = quote.slice(0, connectorStart).replace(/,\s*$/u, '').trimEnd();
      const rightStart = connectorStart + match[0].length - match[1].length;
      const right = quote.slice(rightStart).trimStart();
      const leftWords = left.match(/[\p{L}\p{N}]+/gu) ?? [];
      const rightWords = right.match(/[\p{L}\p{N}]+/gu) ?? [];
      if (leftWords.length < 2 || rightWords.length < 2) continue;
      if (/(?:^|\s)(?:if|when|unless|before|after|while|because|either|neither)\b/iu.test(left)) continue;
      if (!startsWithAction(left, false) || !startsWithAction(right, true)) continue;
      split = { left, right };
      break;
    }

    if (!split) {
      normalizedQuotes.push(quote);
      continue;
    }
    normalizedQuotes.push(split.left, split.right);
    notes.push('A deterministic action-verb rule split one exact quote at a coordinated action; review whether the source phrases are independent requirements.');
  }
  return { quotes: normalizedQuotes, notes };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainSuggestionText(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength
    && value.trim() === value && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function finiteMetric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function inferenceDurationMetric(value: unknown): number | null {
  const nanoseconds = finiteMetric(value);
  return nanoseconds === null ? null : Math.round(nanoseconds / 1_000_000);
}

function numericTokens(text: string): string[] {
  return text.match(/\b\d+(?:[.,]\d+)?%?\b/gu) ?? [];
}

function unsourcedNumericWarning(goalText: string, suggestion: { statement: string; evidenceIdea: string; assumptions: string[] }): string[] {
  const sourceNumbers = new Set(numericTokens(goalText));
  const unsourcedNumbers = new Set([
    ...numericTokens(suggestion.statement),
    ...numericTokens(suggestion.evidenceIdea),
    ...suggestion.assumptions.flatMap(numericTokens),
  ].filter(value => !sourceNumbers.has(value)));
  if (unsourcedNumbers.size === 0) return [];
  const ordered = [...unsourcedNumbers].sort((left, right) => Number.parseFloat(left.replace('%', '').replace(',', '.'))
    - Number.parseFloat(right.replace('%', '').replace(',', '.')));
  return [`Contains numeric values absent from original task: ${ordered.join(', ')}.`];
}

function localEndpoint(value: string): URL {
  let endpoint: URL;
  try { endpoint = new URL(value); }
  catch { throw new Error('Ollama host must be a valid loopback HTTP origin'); }
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
    || endpoint.username !== '' || endpoint.password !== ''
    || endpoint.pathname !== '/' || endpoint.search !== '' || endpoint.hash !== '') {
    throw new Error('the extractor only supports an unauthenticated loopback Ollama HTTP origin');
  }
  return endpoint;
}

async function readBoundedResponse(response: Response): Promise<Buffer> {
  if (!response.body) throw new Error('local Ollama returned an empty response body');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('local Ollama response exceeded the 1 MiB limit');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function normalizeDependentClauseQuotes(goalText: string, quotes: readonly string[]): { quotes: string[]; notes: string[] } {
  const unchanged = { quotes: [...quotes], notes: [] };
  if (quotes.length < 2 || quotes.some(quote => quote.length === 0 || quote.trim() !== quote || quote.length > 8_000)) {
    return unchanged;
  }

  const ranges = quotes.map(quote => {
    const start = goalText.indexOf(quote);
    if (start < 0 || goalText.indexOf(quote, start + 1) >= 0) return null;
    return { start, end: start + quote.length };
  });
  if (ranges.some(range => range === null)) return unchanged;

  const ordered = (ranges as Array<{ start: number; end: number }>)
    .sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.start < ordered[index - 1]!.end) return unchanged;
  }

  const merged: Array<{ start: number; end: number; first: number }> = [];
  const notes: string[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index]!;
    const previous = merged.at(-1);
    if (!previous) {
      merged.push({ start: current.start, end: current.end, first: index + 1 });
      continue;
    }

    const bridge = goalText.slice(previous.end, current.end);
    const previousQuote = goalText.slice(previous.start, previous.end);
    const currentQuote = goalText.slice(current.start, current.end);
    if (/[.!?]["'”’)]*$/u.test(previousQuote)) {
      merged.push({ start: current.start, end: current.end, first: index + 1 });
      continue;
    }
    const marker = /^[\s,;]*(that|which|who|whom|whose|where|when|if|before|after|while|because|so\s+that)\b/iu.exec(bridge);
    if (!marker) {
      merged.push({ start: current.start, end: current.end, first: index + 1 });
      continue;
    }

    const currentWords = currentQuote.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (marker[1]!.toLowerCase() === 'while'
      && currentWords.length >= 2
      && startsWithAction(currentQuote, false)) {
      merged.push({ start: current.start, end: current.end, first: index + 1 });
      notes.push(
        `Candidates ${previous.first} and ${index + 1} were kept separate across action-gerund marker "while"; review whether the source phrases are independent requirements.`,
      );
      continue;
    }

    previous.end = current.end;
    notes.push(
      `Candidates ${previous.first} and ${index + 1} were combined across dependent-clause marker "${marker[1]}"; review whether the combined wording contains multiple independent obligations.`,
    );
  }

  return {
    quotes: merged.map(range => goalText.slice(range.start, range.end)),
    notes,
  };
}

export async function extractPromptEvidenceWithOllama(
  goalText: string,
  model = DEFAULT_MODEL,
  host = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434',
): Promise<OllamaExtractionResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(model)) throw new Error('Ollama model must be a non-empty model identifier');
  const endpoint = localEndpoint(host);
  endpoint.pathname = '/api/chat';

  const format = {
    type: 'object',
    properties: {
      quotes: {
        type: 'array',
        minItems: 1,
        maxItems: 64,
        items: { type: 'string', minLength: 1, maxLength: 8_000 },
      },
    },
    required: ['quotes'],
    additionalProperties: false,
  };
  const payload = {
    model,
    messages: [
      {
        role: 'system',
        content: 'Extract distinct, independently checkable requirements from the user task. Treat question-form requests that propose a change (for example, "Can we add CSV import?") as requirements and include their exact source wording; do not omit a requested change just because it is phrased as a question. Return only a JSON object with a quotes array. Each item must be an exact, contiguous substring copied verbatim from the original task, with no paraphrase and no added punctuation. Prefer a complete obligation phrase; an imperative such as "Validate email input" is complete. Never return a dependent fragment such as "with input validation" or "and safe password hashing" by itself; keep it attached to the action it qualifies, as in "Implement registration with input validation and safe password hashing." Split independent obligations into separate source quotes even when one sentence joins them with "and" or "but"; for example, "hash passwords and never log credentials" contains two obligations, and "Preserve sign-in behavior and add tests" should keep each complete action separate. Do not split off a dependent clause beginning with that, which, if, when, before, or after from the phrase it qualifies, and do not separate a shared verb from its object. Split only when each resulting quote remains a complete obligation; if a clean split would create a fragment, keep the full clause together. Keep all constraints and preserve prompt order. Do not write acceptance criteria, evidence, clarity labels, or a verdict. If the task is ambiguous, quote the full ambiguous clause as one candidate.',
      },
      { role: 'user', content: goalText },
    ],
    stream: false,
    format,
    think: false,
    options: { temperature: 0 },
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`local Ollama returned HTTP ${response.status}`);

  let envelope: unknown;
  try { envelope = JSON.parse((await readBoundedResponse(response)).toString('utf8')) as unknown; }
  catch (error) {
    if (error instanceof Error && error.message.includes('limit')) throw error;
    throw new Error('local Ollama returned an invalid JSON response');
  }
  if (!isRecord(envelope) || envelope.done !== true || envelope.model !== model
    || !isRecord(envelope.message) || envelope.message.role !== 'assistant' || typeof envelope.message.content !== 'string') {
    throw new Error('local Ollama did not return a complete response from the requested model');
  }

  let extraction: unknown;
  try { extraction = JSON.parse(envelope.message.content) as unknown; }
  catch { throw new Error('the extractor response did not contain valid JSON'); }
  if (!isRecord(extraction) || !Array.isArray(extraction.quotes)
    || extraction.quotes.length === 0 || extraction.quotes.length > 64
    || !extraction.quotes.every(quote => typeof quote === 'string')) {
    throw new Error('the extractor response must contain 1 to 64 exact source quotes');
  }

  const normalized = normalizeDependentClauseQuotes(goalText, extraction.quotes);
  const coordinated = splitCoordinatedActionQuotes(goalText, normalized.quotes);
  const draft = draftPromptEvidenceFromQuotes(goalText, coordinated.quotes);
  const notes = [...normalized.notes, ...coordinated.notes];
  return {
    draft: notes.length > 0 ? { ...draft, notes: [...draft.notes, ...notes] } : draft,
    model,
    promptTokens: finiteMetric(envelope.prompt_eval_count),
    responseTokens: finiteMetric(envelope.eval_count),
    inferenceDurationMs: inferenceDurationMetric(envelope.total_duration),
  };
}

export async function suggestPromptEvidenceCriteriaWithOllama(
  draft: PromptEvidenceDraft,
  model = DEFAULT_MODEL,
  host = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434',
): Promise<OllamaCriteriaSuggestionResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(model)) throw new Error('Ollama model must be a non-empty model identifier');
  const endpoint = localEndpoint(host);
  endpoint.pathname = '/api/chat';
  const candidates = draft.candidates.map(candidate => ({ id: candidate.id, text: candidate.text }));
  const format = {
    type: 'object',
    properties: {
      suggestions: {
        type: 'array',
        maxItems: candidates.length,
        items: {
          type: 'object',
          properties: {
            requirementId: { type: 'string', enum: candidates.map(candidate => candidate.id) },
            criteria: {
              type: 'array',
              maxItems: 3,
              items: {
                type: 'object',
                properties: {
                  statement: { type: 'string', minLength: 1, maxLength: 500 },
                  evidenceIdea: { type: 'string', minLength: 1, maxLength: 500 },
                  assumptions: { type: 'array', maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 300 } },
                },
                required: ['statement', 'evidenceIdea', 'assumptions'],
                additionalProperties: false,
              },
            },
          },
          required: ['requirementId', 'criteria'],
          additionalProperties: false,
        },
      },
    },
    required: ['suggestions'],
    additionalProperties: false,
  };
  const payload = {
    model,
    messages: [
      {
        role: 'system',
        content: 'Suggest at most three small, objectively checkable acceptance criteria for each supplied source-linked requirement, plus a possible evidence idea for each criterion. This is untrusted drafting assistance only: do not claim a change was implemented, evidence was collected, or any result passed. Do not alter the source requirements or introduce new user obligations. Never invent thresholds, status codes, algorithms, policies, or behavior not stated in the requirement or original task. For any interpretation or detail that still needs a user decision, list it in assumptions; if there is no useful criterion without deciding that assumption, leave the requirement\'s criteria empty. Evidence ideas describe a kind of independent observation; never report actual evidence, a verdict, or an executable command. Return only JSON with a suggestions array. Use only the supplied requirement IDs; each ID may appear at most once.',
      },
      {
        role: 'user',
        content: JSON.stringify({ originalTask: draft.request.goal.text, candidates }),
      },
    ],
    stream: false,
    format,
    think: false,
    options: { temperature: 0 },
  };
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`local Ollama returned HTTP ${response.status}`);

  let envelope: unknown;
  try { envelope = JSON.parse((await readBoundedResponse(response)).toString('utf8')) as unknown; }
  catch (error) {
    if (error instanceof Error && error.message.includes('limit')) throw error;
    throw new Error('local Ollama returned an invalid response while suggesting criteria');
  }
  if (!isRecord(envelope) || envelope.done !== true || envelope.model !== model
    || !isRecord(envelope.message) || envelope.message.role !== 'assistant' || typeof envelope.message.content !== 'string') {
    throw new Error('local Ollama did not return a complete criteria suggestion response from the requested model');
  }

  let result: unknown;
  try { result = JSON.parse(envelope.message.content) as unknown; }
  catch { throw new Error('the criteria suggestion response did not contain valid JSON'); }
  if (!isRecord(result) || !Array.isArray(result.suggestions) || result.suggestions.length > candidates.length) {
    throw new Error('the criteria suggestion response must contain a bounded suggestions array');
  }

  const candidateById = new Map(draft.candidates.map(candidate => [candidate.id, candidate]));
  const criteriaById = new Map<string, Array<{ statement: string; evidenceIdea: string; assumptions: string[]; reviewWarnings: string[] }>>();
  for (const suggestion of result.suggestions) {
    if (!isRecord(suggestion) || typeof suggestion.requirementId !== 'string' || !Array.isArray(suggestion.criteria)
      || suggestion.criteria.length > 3) {
      throw new Error('each criteria suggestion must contain a requirement ID and at most three criteria');
    }
    if (!candidateById.has(suggestion.requirementId)) throw new Error(`the criteria suggestion response contains an unknown requirement ID: ${suggestion.requirementId}`);
    if (criteriaById.has(suggestion.requirementId)) throw new Error(`the criteria suggestion response repeats requirement ID: ${suggestion.requirementId}`);
    const criteria = suggestion.criteria.map((criterion, index) => {
      if (!isRecord(criterion) || !isPlainSuggestionText(criterion.statement, 500) || !isPlainSuggestionText(criterion.evidenceIdea, 500)
        || !Array.isArray(criterion.assumptions) || criterion.assumptions.length > 5) {
        throw new Error(`criteria suggestion ${index + 1} must include bounded printable text for statement and evidence idea, plus assumptions`);
      }
      const assumptions = criterion.assumptions.map(assumption => {
        if (!isPlainSuggestionText(assumption, 300)) {
          throw new Error(`criteria suggestion ${index + 1} contains an invalid assumption`);
        }
        return assumption;
      });
      const normalizedCriterion = { statement: criterion.statement, evidenceIdea: criterion.evidenceIdea, assumptions };
      return {
        ...normalizedCriterion,
        reviewWarnings: unsourcedNumericWarning(draft.request.goal.text, normalizedCriterion),
      };
    });
    criteriaById.set(suggestion.requirementId, criteria);
  }

  return {
    preview: {
      schema: 'amabie-prompt-evidence-review/1',
      authority: 'advisory-only',
      verdict: 'NOT PROVEN',
      request: draft.request,
      suggestions: draft.candidates.map(candidate => ({
        requirementId: candidate.id,
        sourceText: candidate.text,
        sourceRef: candidate.sourceRef,
        reviewStatus: 'unreviewed',
        criteria: criteriaById.get(candidate.id) ?? [],
      })),
    },
    model,
    usage: {
      promptTokens: finiteMetric(envelope.prompt_eval_count),
      responseTokens: finiteMetric(envelope.eval_count),
      inferenceDurationMs: inferenceDurationMetric(envelope.total_duration),
    },
  };
}
