import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROMPT_EVIDENCE_SCHEMA, materialDigest, type EvidenceDraft, type JsonValue, type PromptEvidenceRequest, type RegisteredTask, type VerifierAdapter } from '@amabie/prompt-evidence';

export const REPORT_AGGREGATE_ADAPTER = 'amabie.reports.csv-aggregate';
export const REPORT_TASK_TYPE = 'reports';
export const SUMMARY_EVIDENCE = 'csv-aggregate';
export const GRAND_TOTAL_EVIDENCE = 'report-grand-total';
export const TOP_REGION_EVIDENCE = 'report-top-region';

const MAX_BYTES = 256 * 1024;

export interface ReportAdapterInput {
  /** The trusted source table (`date,region,amount`); never a file the executing agent may write. */
  sourcePath: string;
  /** Operator-pinned sha256 of the source bytes; a changed source blocks instead of verifying. */
  sourceDigest: string;
  /** Where the executing agent delivers `summary.csv` and `report.md`. */
  outDir: string;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Regular file only (no symlink, no oversize); null when absent. Throws on anything unsafe. */
function readDelivered(dir: string, name: string): Buffer | null {
  const file = path.join(dir, name);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); } catch { return null; }
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error(`${name} is not a regular file within ${MAX_BYTES} bytes`);
  return fs.readFileSync(file);
}

/** Exact decimal to integer cents so no floating point decides a verdict. */
function cents(text: string): number | null {
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/u.exec(text.trim());
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
}

function rows(text: string): string[][] {
  return text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).map(line => line.split(',').map(cell => cell.trim()));
}

function recompute(source: Buffer): Map<string, number> {
  const [header, ...body] = rows(source.toString('utf8'));
  if (!header || header.join() !== 'date,region,amount') throw new Error('the source table must have the header date,region,amount');
  const totals = new Map<string, number>();
  for (const row of body) {
    const amount = row.length === 3 ? cents(row[2]!) : null;
    if (amount === null || !row[1]) throw new Error('the source table has a malformed row');
    totals.set(row[1], (totals.get(row[1]) ?? 0) + amount);
  }
  if (totals.size === 0) throw new Error('the source table has no data rows');
  return totals;
}

const money = (value: number): string => `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;

/** Claims of the form `Label: value`; several lines with the label must all agree. */
function claim(report: string, label: string): string | null | 'conflict' {
  const values = [...report.matchAll(new RegExp(`^\\s*${label}\\s*:\\s*(.+?)\\s*$`, 'gimu'))].map(m => m[1]!);
  if (values.length === 0) return null;
  return new Set(values.map(v => v.toLowerCase())).size === 1 ? values[0]! : 'conflict';
}

/**
 * Collects facts about a delivered table and report by recomputing them from the pinned source itself.
 * Nothing the agent says about its own work is read as evidence, and the adapter never returns a verdict.
 */
export function createReportAggregateAdapter(input: ReportAdapterInput): VerifierAdapter {
  return {
    id: REPORT_AGGREGATE_ADAPTER,
    taskType: REPORT_TASK_TYPE,
    async collect(_request, criteria, context) {
      const evidence: EvidenceDraft[] = [];
      const blocked: Array<{ criterionId: string; reason: string }> = [];
      const unproven: Array<{ criterionId: string; reason: string }> = [];
      const blockAll = (reason: string) => ({ evidence, blocked: criteria.map(({ criterion }) => ({ criterionId: criterion.id, reason })) });
      if (context.runId.length === 0 || !Number.isSafeInteger(context.attempt) || context.attempt < 0) return blockAll('report evidence must be attached to a fresh verification run');
      let totals: Map<string, number>;
      try {
        const source = fs.readFileSync(input.sourcePath);
        if (sha256(source) !== input.sourceDigest) return blockAll('the source table differs from the operator-pinned digest');
        totals = recompute(source);
      } catch (error) { return blockAll(`the source table cannot be recomputed: ${error instanceof Error ? error.message : String(error)}`); }
      let summary: Buffer | null, report: Buffer | null;
      try { summary = readDelivered(input.outDir, 'summary.csv'); report = readDelivered(input.outDir, 'report.md'); }
      catch (error) { return blockAll(error instanceof Error ? error.message : String(error)); }
      const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
      const grand = [...totals.values()].reduce((a, b) => a + b, 0);

      for (const { requirement, criterion } of criteria) {
        const { evidenceType, predicate } = criterion;
        if (predicate.path !== '/matches' || predicate.equals !== true) { blocked.push({ criterionId: criterion.id, reason: 'the report adapter supports only a /matches equals true predicate' }); continue; }
        let facts: JsonValue, artifact: Buffer | null;
        if (evidenceType === SUMMARY_EVIDENCE) {
          artifact = summary;
          const delivered = new Map<string, string>();
          const [header, ...body] = summary ? rows(summary.toString('utf8')) : [];
          const shape = !!summary && header?.join() === 'region,total';
          for (const row of body) if (row.length === 2) delivered.set(row[0]!, row[1]!);
          const missing = [...totals.keys()].filter(region => !delivered.has(region));
          const extra = [...delivered.keys()].filter(region => !totals.has(region));
          const wrong = [...totals.entries()].filter(([region, total]) => delivered.has(region) && cents(delivered.get(region)!) !== total)
            .map(([region, total]) => ({ region, expected: money(total), found: delivered.get(region)! }));
          facts = { matches: shape && body.length === delivered.size && missing.length + extra.length + wrong.length === 0, delivered: !!summary, shape, regions: totals.size, missing, extra, wrong };
        } else if (evidenceType === GRAND_TOTAL_EVIDENCE || evidenceType === TOP_REGION_EVIDENCE) {
          artifact = report;
          const top = evidenceType === TOP_REGION_EVIDENCE;
          if (top && ranked.length > 1 && ranked[0]![1] === ranked[1]![1]) { unproven.push({ criterionId: criterion.id, reason: 'two regions tie for the highest total, so the requirement has no single correct answer' }); continue; }
          const found = report ? claim(report.toString('utf8'), top ? 'Top region' : 'Grand total') : null;
          const expected = top ? ranked[0]![0] : money(grand);
          const matches = found !== null && found !== 'conflict' && (top ? found.toLowerCase() === expected.toLowerCase() : cents(found) === grand);
          facts = { matches, delivered: !!report, claimed: found === 'conflict' ? 'conflicting claims' : found, expected };
        } else { blocked.push({ criterionId: criterion.id, reason: `the report adapter does not know evidence type ${evidenceType}` }); continue; }
        evidence.push({ requirementId: requirement.id, criterionId: criterion.id, evidenceType, facts, artifactRefs: artifact ? [`sha256:${sha256(artifact)}`] : [] });
      }
      return { evidence, blocked, unproven };
    },
  };
}

const REQUIREMENTS: ReadonlyArray<{ text: string; evidenceType: string }> = [
  { text: 'out/summary.csv lists every region of sales.csv exactly once with its correct total.', evidenceType: SUMMARY_EVIDENCE },
  { text: 'out/report.md states the correct grand total as a line "Grand total: <number>".', evidenceType: GRAND_TOTAL_EVIDENCE },
  { text: 'out/report.md names the region with the highest total as a line "Top region: <name>".', evidenceType: TOP_REGION_EVIDENCE },
];

/** The registered second-domain task: the goal is the requirement lines; every requirement has one criterion. */
export function reportTask(): { input: PromptEvidenceRequest; task: RegisteredTask } {
  const goalText = REQUIREMENTS.map(r => r.text).join('\n');
  let cursor = 0;
  const requirements = REQUIREMENTS.map(r => {
    const start = goalText.indexOf(r.text, cursor);
    cursor = start + r.text.length + 1;
    return {
      text: r.text,
      sourceRef: { kind: 'goal' as const, start, end: start + r.text.length, excerpt: r.text },
      clarity: 'clear' as const,
      criteria: [{ statement: `The recomputed ${r.evidenceType} matches the delivered file`, adapterId: REPORT_AGGREGATE_ADAPTER, evidenceType: r.evidenceType, predicate: { path: '/matches', equals: true } }],
    };
  });
  return {
    input: { schema: PROMPT_EVIDENCE_SCHEMA, goal: { taskType: REPORT_TASK_TYPE, text: goalText }, requirements },
    task: { taskType: REPORT_TASK_TYPE, taskDigest: materialDigest(goalText), requirementDigests: REQUIREMENTS.map(r => materialDigest(r.text)) },
  };
}
