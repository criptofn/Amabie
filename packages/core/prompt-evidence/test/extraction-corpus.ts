/**
 * Realistic goal sentences with the requirement boundaries a careful human reader
 * would draw. `expected` lists the exact focus text of each requirement, in order.
 *
 * The corpus is a measuring instrument for the deterministic splitter, not a
 * definition of success: matching it does not make a draft PASS (every candidate
 * stays unclear until a person adds independently checkable criteria), and the
 * expectations are written from the prompt alone, never from the splitter output.
 */
export interface ExtractionCase {
  id: string;
  goal: string;
  /** Exact focus text of each requirement a human reader would separate. */
  expected: string[];
  /**
   * Set when the current splitter is known to disagree with `expected`. The
   * corpus test pins the disagreement so that fixing the splitter (or breaking
   * it differently) fails loudly and forces this entry to be revisited.
   */
  knownGap?: { reason: string };
}

export const EXTRACTION_CORPUS: readonly ExtractionCase[] = [
  // --- covered: the splitter already agrees with a careful reader ---
  {
    id: 'multi-sentence-feature',
    goal: 'Add a /health endpoint returning JSON with status and version. Cache the version at startup. Do not break the existing /status route.',
    expected: [
      'Add a /health endpoint returning JSON with status and version.',
      'Cache the version at startup.',
      'Do not break the existing /status route.',
    ],
  },
  {
    id: 'bullet-list-with-header',
    goal: 'Harden the upload handler:\n- Reject files larger than 5 MiB.\n- Store files outside the web root.\n- Log every rejected upload.',
    expected: [
      'Harden the upload handler:',
      'Reject files larger than 5 MiB.',
      'Store files outside the web root.',
      'Log every rejected upload.',
    ],
  },
  {
    id: 'coordinated-noun-list-stays-whole',
    goal: 'Validate name, email, and phone number before saving.',
    expected: ['Validate name, email, and phone number before saving.'],
  },
  {
    id: 'conditional-comma-stays-whole',
    goal: 'If the token has expired, return 401 and clear the session cookie.',
    // The condition scopes over both actions; splitting would strip it from the second duty.
    expected: ['If the token has expired, return 401 and clear the session cookie.'],
  },
  {
    id: 'while-clause-is-not-a-new-duty',
    goal: 'Keep the cache warm while the server is running.',
    expected: ['Keep the cache warm while the server is running.'],
  },
  {
    id: 'negative-single-requirement-with-and',
    goal: 'Use a hash that is both fast and collision resistant.',
    expected: ['Use a hash that is both fast and collision resistant.'],
  },
  {
    id: 'semicolon-separated',
    goal: 'Hash passwords with argon2; reject passwords shorter than 12 characters; add tests.',
    expected: ['Hash passwords with argon2', 'reject passwords shorter than 12 characters', 'add tests.'],
  },
  {
    id: 'filename-with-dots-does-not-split',
    goal: 'Update config.json and package.json. Keep the lockfile unchanged.',
    expected: ['Update config.json and package.json.', 'Keep the lockfile unchanged.'],
  },

  // --- reproduced gaps: common verbs / phrasings the splitter does not know ---
  {
    id: 'gap-fix-refactor-bump',
    goal: 'Fix the login bug, refactor the session store, and bump the version.',
    expected: ['Fix the login bug', 'refactor the session store', 'bump the version.'],
  },
  {
    id: 'gap-make-verb',
    goal: 'Make the API respond in under 200 ms and make the tests deterministic.',
    expected: ['Make the API respond in under 200 ms', 'make the tests deterministic.'],
  },
  {
    id: 'gap-migrate-rename-drop',
    goal: 'Migrate the database, rename the column and drop the old table.',
    expected: ['Migrate the database', 'rename the column', 'drop the old table.'],
  },
  {
    id: 'gap-elliptical-second-clause',
    goal: 'Return 404 when the user is not found, and 403 when access is denied.',
    expected: ['Return 404 when the user is not found', '403 when access is denied.'],
    knownGap: { reason: 'the second duty has no verb of its own (ellipsis), so it is not recognized as a separate clause' },
  },
  {
    id: 'gap-imperative-negation',
    goal: 'Add pagination to the list endpoint and do not change the response schema for existing clients.',
    expected: ['Add pagination to the list endpoint', 'do not change the response schema for existing clients.'],
  },
  {
    id: 'gap-inline-enumeration',
    goal: 'The importer must (1) parse CSV (2) reject duplicate rows (3) log skipped rows.',
    expected: ['The importer must', '(1) parse CSV', '(2) reject duplicate rows', '(3) log skipped rows.'],
  },
  {
    id: 'gap-german-prompt',
    goal: 'Implementiere die Registrierung, validiere die E-Mail-Adresse und hashe die Passwörter.',
    expected: ['Implementiere die Registrierung', 'validiere die E-Mail-Adresse', 'hashe die Passwörter.'],
    knownGap: { reason: 'the action-verb list is English only; a German prompt stays one candidate' },
  },
  {
    id: 'gap-quoted-sentence-boundary',
    goal: 'Print "Done. Next steps follow." after the import finishes.',
    expected: ['Print "Done. Next steps follow." after the import finishes.'],
  },
  {
    id: 'gap-abbreviation-title',
    goal: 'Support the address format used by Dr. Mueller in the legacy export.',
    expected: ['Support the address format used by Dr. Mueller in the legacy export.'],
  },
  {
    id: 'code-spans-with-commas',
    goal: 'Run `npm test`, then run `npm run lint`.',
    expected: ['Run `npm test`', 'run `npm run lint`.'],
  },
];
