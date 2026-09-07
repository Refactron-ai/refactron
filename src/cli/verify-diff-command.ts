// src/cli/verify-diff-command.ts
// `refactron verify-diff [repoRoot] --diff <file>` — verify an arbitrary diff
// and print the SAFE/UNSAFE/UNPROVEN verdict. The local primitive under the MCP tool.
import * as fs from 'node:fs/promises';
import { verifyDiff } from '../verify/verify-diff.js';
import type { VerdictReport } from '../verify/verdict-fuse.js';
import { requireAuth } from './auth-gate.js';
import { applyColor } from './apply-color.js';

export class VerifyDiffFlagError extends Error {}

interface VerifyDiffFlags {
  repoRoot: string;
  diffPath: string | null;
  json: boolean;
  testCmd: string | null;
  mutate: boolean;
  flakyCheck: boolean;
  trusted: boolean;
}

export function parseVerifyDiffFlags(argv: string[]): VerifyDiffFlags {
  let repoRoot: string | null = null;
  let diffPath: string | null = null;
  let json = false;
  let testCmd: string | null = null;
  let mutate = false;
  let flakyCheck = false;
  let trusted = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--trusted') {
      trusted = true;
      continue;
    }
    if (a === '--mutate') {
      mutate = true;
      continue;
    }
    if (a === '--flaky-check') {
      flakyCheck = true;
      continue;
    }
    if (a === '--diff') {
      diffPath = argv[++i] ?? null;
      if (!diffPath) throw new VerifyDiffFlagError('--diff requires a file path');
      continue;
    }
    if (a.startsWith('--diff=')) {
      diffPath = a.slice('--diff='.length);
      if (!diffPath) throw new VerifyDiffFlagError('--diff requires a file path');
      continue;
    }
    if (a === '--test-cmd') {
      testCmd = argv[++i] ?? null;
      if (!testCmd) throw new VerifyDiffFlagError('--test-cmd requires a command');
      continue;
    }
    if (a.startsWith('--test-cmd=')) {
      testCmd = a.slice('--test-cmd='.length);
      if (!testCmd) throw new VerifyDiffFlagError('--test-cmd requires a command');
      continue;
    }
    if (a.startsWith('-')) throw new VerifyDiffFlagError(`unknown flag: ${a}`);
    if (repoRoot !== null) throw new VerifyDiffFlagError(`unexpected extra argument: ${a}`);
    repoRoot = a;
  }
  return { repoRoot: repoRoot ?? '.', diffPath, json, testCmd, mutate, flakyCheck, trusted };
}

const VERDICT_COLOR: Record<string, string> = {
  SAFE: '#3fb950', // success
  UNSAFE: '#f85149', // error
  UNPROVEN: '#d29922', // warning
};

// One-line advisory when a diff touches test files. Not a verdict change — a
// heads-up that the diff could be weakening its own safety net. Returns null
// when nothing test-shaped changed. Previews the first three paths.
export function formatTestFilesNote(testFilesChanged: string[]): string | null {
  if (testFilesChanged.length === 0) return null;
  const preview = testFilesChanged.slice(0, 3).join(', ');
  const suffix = testFilesChanged.length > 3 ? ', ...' : '';
  return `note: this diff modifies test files (${testFilesChanged.length}): ${preview}${suffix}`;
}

// One-line advisory when the test command named a subset of the suite. Unlike
// formatTestFilesNote this one explains a VERDICT: a narrowed scope disqualifies
// SAFE (ADR-12), so the reader needs to know which signal cost them the verdict
// and what to run instead. Returns null for a full or unparsed command.
export function formatTestScopeNote(testScope: VerdictReport['testScope']): string | null {
  if (!testScope) return null;
  const signals = testScope.signals.join('; ');
  if (testScope.scope === 'narrowed') {
    return (
      `  note: the test command narrowed the suite (${signals}), so this run cannot be SAFE. ` +
      `Re-run without the filter to get a verdict on the whole suite.`
    );
  }
  // An `unknown` scope does NOT change the verdict, so a SAFE here rests on a
  // command we could not parse. Staying silent about that is the same mistake
  // `coverage.unknownReason` exists to prevent: a failed measurement must not
  // read as a clean one.
  if (testScope.scope === 'unknown' && testScope.source === 'override') {
    return (
      `  note: could not determine whether the test command runs the whole suite` +
      `${signals ? ` (${signals})` : ''}; the verdict assumes it does.`
    );
  }
  return null;
}

// One line per unexercised STATEMENT (deduped upstream), not per physical line:
// coverage.py attributes execution to a statement's first line, so a rewrapped
// statement would otherwise print once per wrapped line. A capped list always
// ends with the shortfall, because a short list that looks complete understates
// the gap the user has to close.
//
// SAFE takes the one-line summary below instead. The report still CARRIES every
// unexercised statement (see formatCoverageSummary and `--json`), but a green
// headline followed by 128 "uncovered:" lines reads like a contradiction, and a
// terminal is the wrong place to dump a list nobody is being asked to act on.
export function formatUncoveredLines(coverage: VerdictReport['coverage']): string[] {
  const out = coverage.uncovered.map(
    (u) =>
      `  uncovered: ${u.file}:${u.line}` +
      (u.excluded ? ' (excluded from coverage; no test can reach it)' : ''),
  );
  const cut = coverage.uncoveredTruncated;
  if (cut) {
    const files = coverage.filesWithUncovered;
    const spread = files !== undefined && files > 1 ? ` across ${files} files` : '';
    out.push(
      `  ... and ${cut.total - cut.shown} more uncovered statement(s) (${cut.total} total${spread})`,
    );
  }
  return out;
}

// What a SAFE verdict did NOT prove, in one line. Since ADR-11 a SAFE requires
// every COVERABLE changed statement to have run, so the only gap a SAFE can now
// carry is statements coverage.py excluded (`# pragma: no cover`,
// `if TYPE_CHECKING:`), which no test could ever reach. Saying so is the
// difference between a verdict you can audit and one you have to take on faith.
// Returns null when every changed statement ran, or when there is no ratio.
export function formatCoverageSummary(coverage: VerdictReport['coverage']): string | null {
  const stats = coverage.changedStatements;
  if (!stats || stats.total === 0 || stats.covered >= stats.total) return null;
  const gap = stats.total - stats.covered;
  const files = coverage.filesWithUncovered;
  const spread = files !== undefined && files > 1 ? ` across ${files} files` : '';
  return (
    `  note: ${stats.covered} of ${stats.total} changed statements were exercised; ` +
    `${gap} could not be${spread} (excluded from coverage). See --json for the list.`
  );
}

// One-line advisory when tests failed once then passed on the gate's same-shadow
// retry. Those were treated as flaky (not the diff's fault) and did not change
// the verdict; the note keeps that decision visible. Returns null when none.
export function formatFlakyNote(flakyTests: string[]): string | null {
  if (flakyTests.length === 0) return null;
  const preview = flakyTests.slice(0, 3).join(', ');
  const suffix = flakyTests.length > 3 ? ', ...' : '';
  return `note: ${flakyTests.length} test(s) flipped on retry and were treated as flaky: ${preview}${suffix}`;
}

// Disclose when --mutate did not fully conclude, so a SAFE beside it is not read
// as a clean mutation sweep. Survivors are already in the verdict reason; this
// covers the "skipped", "capped", and "all inconclusive" states. Null when
// mutation was not requested or ran to a complete conclusion.
export function formatMutationNote(mutation: VerdictReport['mutation']): string | null {
  if (!mutation) return null;
  if (!mutation.ran) {
    return `note: --mutate did not run (${mutation.skippedReason ?? 'no conclusion'}); this verdict is not mutation-checked`;
  }
  if (mutation.tested === 0) {
    return `note: --mutate found no mutable operators or constants in the changed statements; nothing to check`;
  }
  const parts: string[] = [];
  if (mutation.truncated) {
    parts.push(
      `only ${mutation.truncated.tested} of ${mutation.truncated.total} mutants were run (budget)`,
    );
  }
  if (mutation.inconclusive > 0) parts.push(`${mutation.inconclusive} inconclusive (skipped)`);
  if (parts.length === 0) return null;
  return `note: --mutate was incomplete — ${parts.join('; ')}; a surviving mutant could have been missed`;
}

// Disclose when --flaky-check did not fully conclude, so a SAFE beside it is not
// read as a clean stability sweep. A confirmed varied test is already in the
// verdict reason; this covers "skipped" and "every rerun was inconclusive". Null
// when the check was not requested or ran to a real conclusion.
export function formatStabilityNote(stability: VerdictReport['stability']): string | null {
  if (!stability) return null;
  if (!stability.ran) {
    return `note: --flaky-check did not run (${stability.skippedReason ?? 'no conclusion'}); this verdict is not stability-checked`;
  }
  if (stability.varied.length === 0 && stability.runs === 0 && stability.inconclusive > 0) {
    return `note: --flaky-check reran the suite but every rerun was inconclusive (${stability.inconclusive} timed out); flakiness could have been missed`;
  }
  return null;
}

export async function runVerifyDiffCommand(argv: string[]): Promise<number> {
  const authResult = await requireAuth('verify-diff');
  if (authResult !== true) return authResult;

  let flags: VerifyDiffFlags;
  try {
    flags = parseVerifyDiffFlags(argv);
  } catch (err) {
    if (err instanceof VerifyDiffFlagError) {
      process.stderr.write(`refactron verify-diff: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
  if (!flags.diffPath) {
    process.stderr.write('refactron verify-diff: --diff <file> is required\n');
    return 2;
  }

  let report;
  try {
    const unifiedDiff = await fs.readFile(flags.diffPath, 'utf8');
    report = await verifyDiff({
      repoRoot: flags.repoRoot,
      unifiedDiff,
      ...(flags.testCmd ? { testCmd: flags.testCmd } : {}),
      ...(flags.mutate ? { mutate: true } : {}),
      ...(flags.flakyCheck ? { flakyCheck: true } : {}),
      ...(flags.trusted ? { trusted: true } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`refactron verify-diff: ${msg}\n`);
    return 2;
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(
      applyColor(`[${report.verdict}] ${report.reason}`, VERDICT_COLOR[report.verdict]) + '\n',
    );
    if (report.verdict === 'SAFE') {
      const summary = formatCoverageSummary(report.coverage);
      if (summary) process.stdout.write(summary + '\n');
    } else {
      for (const line of formatUncoveredLines(report.coverage)) {
        process.stdout.write(line + '\n');
      }
    }
    // Printed before the other notes: when the scope was narrowed it is the
    // reason the verdict is not SAFE, so it outranks the advisories.
    const scopeNote = formatTestScopeNote(report.testScope);
    if (scopeNote) process.stdout.write(scopeNote + '\n');
    const note = formatTestFilesNote(report.testFilesChanged);
    if (note) process.stdout.write(note + '\n');
    const flakyNote = formatFlakyNote(report.flakyTests ?? []);
    if (flakyNote) process.stdout.write(flakyNote + '\n');
    const mutationNote = formatMutationNote(report.mutation);
    if (mutationNote) process.stdout.write(mutationNote + '\n');
    const stabilityNote = formatStabilityNote(report.stability);
    if (stabilityNote) process.stdout.write(stabilityNote + '\n');
  }
  return report.verdict === 'UNSAFE' ? 1 : 0;
}
