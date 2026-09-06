// src/verify/verdict-fuse.ts
// Pure fusion of the verify engine's pass/fail gates with changed-line coverage
// into the honest three-way verdict. No I/O.
import type { VerificationResult, GateResult } from '../contracts.js';
import type { TestScopeAssessment } from './test-scope.js';
import type { MutationResult } from './mutation.js';
import type { StabilityResult } from './stability.js';

export type Verdict = 'SAFE' | 'UNSAFE' | 'UNPROVEN';

export interface CoverageAssessment {
  tool: 'coverage.py' | 'none';
  changedLinesCovered: boolean | 'unknown';
  // One entry per UNEXECUTED enclosing statement (deduped), not per physical
  // line: coverage.py attributes execution to a statement's first line, so a
  // multi-line statement reports once, at a line a human can write a test for.
  // ALWAYS populated, including under a SAFE verdict: since ADR-11 the only
  // entries a SAFE can carry are statements coverage.py EXCLUDED, which no test
  // could reach. Hiding them is what let a false SAFE pass unnoticed.
  // Disclosure never weakens a verdict, it only explains it.
  uncovered: Array<{ file: string; line: number; excluded?: boolean }>;
  // Present only when `uncovered` was capped. `total` is the true number of
  // uncovered statements; a short list without this field would misstate the gap.
  uncoveredTruncated?: { shown: number; total: number };
  // Distinct files with at least one uncovered statement, BEFORE any cap. The
  // cap can drop entries, so `{shown,total}` alone cannot tell the reader
  // whether whole files fell off the list.
  filesWithUncovered?: number;
  // Distinct changed statements and how many executed. A ratio ("12 of 40
  // changed statements exercised") the boolean cannot express. Since ADR-11 the
  // verdict rule is per-file and statement-level, so this aggregate is the
  // reader's view of the same evidence rather than an independent signal.
  changedStatements?: { total: number; covered: number };
  // Distinct changed statements coverage.py excluded. Since ADR-18 these floor
  // the verdict (an exclusion is attacker-controllable in the diff), so this is a
  // verdict-relevant disclosure, not a footnote. Drives the exclusion-floor
  // reason so the remedy is not "add a test" (no test can reach an excluded line).
  excludedChangedStatements?: number;
  // Changed files whose edit only REMOVES lines: there are no added lines for
  // coverage to attest, which is a different situation from "the added code is
  // untested" and gets its own reason string.
  removalOnlyFiles?: string[];
  // Why coverage is 'unknown', when we know. A bare unknown is indistinguishable
  // from an untested change to a reader, and diagnosing one cost a full CI cycle.
  unknownReason?: string;
  // Changed files whose added lines are ALL semantically inert (blank lines,
  // comment-only lines). Nothing to attest, same as removal-only: a deletion is
  // invisible in the added lines, so "provably inert edits" is not "provably
  // unchanged file".
  inertOnlyFiles?: string[];
  // Changed conditionals with an untaken branch (ADR-14); block SAFE.
  partialBranches?: Array<{ file: string; line: number }>;
}

export interface VerdictReport {
  // Schema version for this report. The MCP tool and `--json` serialize the
  // whole object verbatim, so its shape is a public contract; a consumer that
  // stores reports as fleet history needs to know which shape it is holding.
  // Bump on any breaking change to the fields below.
  reportVersion: 1;
  verdict: Verdict;
  gates: { syntax: GateResult; imports: GateResult; tests: GateResult };
  changedFiles: string[];
  // Subset of changedFiles matching test conventions. A note, not a verdict
  // input: an agent that weakens tests can otherwise ride a green verdict, so we
  // surface which test files the diff touched without changing the verdict.
  testFilesChanged: string[];
  coverage: CoverageAssessment;
  reason: string;
  missingTests?: Array<{ file: string; hint: string }>;
  // Present only when `missingTests` was capped, carrying the true shortfall.
  missingTestsTruncated?: { shown: number; total: number };
  // Tests that failed once in the changed shadow then passed on a same-shadow
  // retry. The tests gate treated them as flaky rather than blaming the diff; we
  // surface them so the human/JSON report can note them. Not a verdict input.
  flakyTests?: string[];
  // The engine version that produced this report. `reportVersion` says which
  // SHAPE you are holding; this says which RULES produced it. Two releases have
  // now changed what `SAFE` means without changing the shape, so a consumer
  // storing reports as history needs both. Attached by verify-diff.ts, which is
  // the I/O layer; this module stays pure. Absent on reports from before it
  // existed, and on direct fuseVerdict callers.
  engineVersion?: string;
  // What the test command actually ran. IS a verdict input: a `narrowed` scope
  // disqualifies SAFE (see the fusion rule below and ADR-12). Present whenever
  // the caller supplied an assessment; absent only for direct callers of
  // fuseVerdict that omit it, which cannot happen through verify-diff.
  testScope?: TestScopeAssessment;
  // The mutation half of the evidence (ADR-15), a sibling of `coverage` because
  // it is a different tool. Present only under opt-in --mutate. A surviving
  // mutant blocks SAFE; `ran: false` with a `skippedReason` says the deep check
  // did not conclude, so a SAFE beside it is coverage-backed, not mutation-proven.
  mutation?: MutationResult;
  // The stability half of the evidence (#146), present only under opt-in
  // --flaky-check. Distinct from `flakyTests` (the fail→heal signal from the
  // tests gate): this is the result of rerunning a would-be-SAFE suite under
  // varied conditions. A non-empty `varied` blocks SAFE; `ran: false` with a
  // `skippedReason` says the check did not conclude. `varied` entries are test
  // ids OR synthetic `run N (seed S)` markers when the output did not parse, so
  // it is not a deduped test-id list (see StabilityResult).
  stability?: StabilityResult;
}

// The tests gate carries flakySuspects on the SAME object it returns as the
// tests GateResult (a verify-land extension; GateResult itself is locked). Read
// it back structurally here without importing from the locked contract or
// widening it.
function flakySuspectsOf(tests: GateResult): string[] | undefined {
  const suspects = (tests as { flakySuspects?: unknown }).flakySuspects;
  return Array.isArray(suspects) && suspects.length > 0 ? (suspects as string[]) : undefined;
}

// Changed-file paths (repo-relative, posix) that look like tests: a `tests/` or
// `test/` path segment, or a filename matching Python/TS test conventions.
function isTestFile(p: string): boolean {
  const parts = p.replace(/\\/g, '/').split('/');
  if (parts.includes('tests') || parts.includes('test')) return true;
  const base = parts[parts.length - 1] ?? '';
  return (
    base === 'conftest.py' ||
    /^test_.+\.py$/.test(base) ||
    /_test\.py$/.test(base) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(base)
  );
}

// Stable substrings emitted by the tests gate (src/verify/gates/tests.ts) for
// the two "we cannot establish a verdict" cases. A tests-gate failure carrying
// either of these does NOT mean the diff broke anything — it means we could not
// prove anything at all — so it must map to UNPROVEN, never UNSAFE.
/** Ceiling on `missingTests` hints. Truncation is always disclosed in
 *  `missingTestsTruncated`; silently dropping hints would misstate the gap. */
export const MISSING_TESTS_CAP = 50;

const NO_RUNNER_SUBSTRING = 'no test runner detected';
const BASELINE_RED_SUBSTRING = 'baseline tests already fail';

// REQUIRED, deliberately. An optional scope would make "a new call site forgot
// to pass it" a silent false SAFE, which is the mechanism behind two of the
// three false SAFEs this project has already shipped. Required makes it a
// compile error instead. The FIELD on VerdictReport stays optional, which is
// load-bearing for a different reason: its absence is how a consumer tells a
// pre-0.5.0 stored report from one produced by an engine that floors.
export function fuseVerdict(
  result: VerificationResult,
  changedFiles: string[],
  cov: CoverageAssessment,
  testScope: TestScopeAssessment,
  mutation?: MutationResult,
  stability?: StabilityResult,
): VerdictReport {
  const flakyTests = flakySuspectsOf(result.gates.tests);
  const base = {
    reportVersion: 1 as const,
    gates: result.gates,
    changedFiles,
    testFilesChanged: changedFiles.filter(isTestFile),
    coverage: cov,
    ...(flakyTests ? { flakyTests } : {}),
    testScope,
    ...(mutation ? { mutation } : {}),
    ...(stability ? { stability } : {}),
  };

  if (!result.passed) {
    const failedGate: 'syntax' | 'imports' | 'tests' = !result.gates.syntax.passed
      ? 'syntax'
      : !result.gates.imports.passed
        ? 'imports'
        : 'tests';
    const reason = result.gates[failedGate].blockingReason ?? `${failedGate} gate failed`;
    // "Cannot establish a verdict" case: syntax + imports both passed, and the
    // ONLY failure is the tests gate reporting no runner or an already-red
    // baseline. Neither is evidence the diff broke anything, so report UNPROVEN
    // (honest) rather than UNSAFE. A genuine syntax/imports failure, or a tests
    // failure for any other reason, still falls through to UNSAFE below.
    if (
      failedGate === 'tests' &&
      result.gates.syntax.passed &&
      result.gates.imports.passed &&
      (reason.includes(NO_RUNNER_SUBSTRING) || reason.includes(BASELINE_RED_SUBSTRING))
    ) {
      // No suite ran, so `full` would be a claim about a run that never
      // happened. The verdict is already UNPROVEN either way, but this object is
      // stored as fleet history and `scope: full` in it would read as evidence
      // that a whole suite went green.
      return {
        verdict: 'UNPROVEN',
        ...base,
        testScope: { ...testScope, scope: 'unknown' },
        reason,
      };
    }
    return { verdict: 'UNSAFE', ...base, reason };
  }

  // C1 (zero-false-SAFE): a flaky heal is never a clean stable green. If any
  // test flipped on retry, no stable green was ever observed, so SAFE is
  // disqualified and the verdict floors at UNPROVEN below. Its reason pre-empts
  // the would-be-SAFE reason only; when coverage already forces UNPROVEN, the
  // coverage reason stands (see the tie-break comment below).
  const flakyReason = flakyTests
    ? `Tests pass, but ${flakyTests.length} test(s) flipped on retry (flaky); a stable green could not be established.`
    : null;

  // C2 (zero-false-SAFE): a green run of a SUBSET is not a green suite. When the
  // caller's test command names a filter, coverage can report the changed code
  // as fully exercised while the test that would have caught the change was
  // never selected. Reproduced in issue #110: the same diff reads UNSAFE under
  // `python3 -m pytest -q` and SAFE under `python3 -m pytest -q tests/x.py`.
  //
  // Only `narrowed` floors. `unknown` does NOT: the commands that land there
  // are dominated by plugin flags on a full suite (`pytest --doctest-modules`),
  // and flooring them would turn every unrecognised flag in the wild into a
  // SAFE-killer fixable only by a PR to us. The residual hole that leaves is
  // recorded in ADR-12 and tracked, not papered over.
  const narrowedReason =
    testScope.scope === 'narrowed'
      ? `Tests pass, but the test command narrowed the suite (${testScope.signals.join('; ')}), so the tests that ran are a subset the caller chose.`
      : null;

  // C3 (zero-false-SAFE): a suite whose outcome VARIES across reruns under
  // varied conditions was never a stable green (#146). Distinct from the C1
  // fail→heal flake above: this is the opt-in --flaky-check rerunning a
  // would-be-SAFE suite. Any confirmed variance disqualifies SAFE. An
  // inconclusive rerun (a timeout) is not variance and does not floor.
  // "test outcome(s) varied", not "N tests": a `varied` entry can be a run-level
  // token when the output did not parse, so counting them as distinct tests would
  // overstate. An outcome that varied is exactly what was observed either way.
  const stabilityReason =
    stability && stability.varied.length > 0
      ? stability.varied.length === 1
        ? `Tests pass, but a test outcome varied across reruns (${stability.varied[0]}); the green is flaky, not stable. Fix the flakiness or the verdict cannot be SAFE.`
        : `Tests pass, but ${stability.varied.length} test outcomes varied across reruns; the green is flaky, not stable. Fix the flakiness or the verdict cannot be SAFE.`
      : null;

  // Each blocking signal is asserted at the gate, not only via
  // changedLinesCovered, so a future producer that sets one without flooring
  // cannot leak SAFE. A surviving mutant is the ADR-15 conjunct; a varied test
  // is the #146 conjunct.
  if (
    cov.changedLinesCovered === true &&
    (cov.partialBranches?.length ?? 0) === 0 &&
    (mutation?.survivors.length ?? 0) === 0 &&
    (stability?.varied.length ?? 0) === 0 &&
    !flakyReason &&
    !narrowedReason
  ) {
    return {
      verdict: 'SAFE',
      ...base,
      reason: 'Tests pass and the changed code is covered.',
    };
  }

  // Nothing-to-attest case: EVERY changed file either only deletes lines, or
  // changes nothing but comments and blank lines. Conservative UNPROVEN stands
  // (a deletion is invisible in the added lines, so a green suite proves nothing
  // about what left), but the reason must say what actually happened instead of
  // implying a coverage miss.
  //
  // Two things this predicate must get right. First, the zero-check reads the
  // PRE-CAP total: `uncovered` is capped, so a long list truncated to zero would
  // never happen today but the intent is "no uncovered statements at all", not
  // "none survived the cap". Second, it requires every changed file to be
  // accounted for. Checking only "some removal-only file exists" printed "the
  // change only removes code" for a MIXED diff (a removal-only file plus a file
  // with real, fully covered additions), which is simply false.
  const removalOnlyFiles = cov.removalOnlyFiles ?? [];
  const inertOnlyFiles = cov.inertOnlyFiles ?? [];
  const uncoveredTotal = cov.uncoveredTruncated?.total ?? cov.uncovered.length;
  const nothingToAttestFiles = new Set([...removalOnlyFiles, ...inertOnlyFiles]);
  const nothingToAttest =
    cov.changedLinesCovered === false &&
    uncoveredTotal === 0 &&
    nothingToAttestFiles.size > 0 &&
    changedFiles.every((f) => nothingToAttestFiles.has(f));
  const nothingToAttestReason =
    inertOnlyFiles.length === 0
      ? 'Tests pass. The change only removes code; there are no added lines for coverage to attest.'
      : removalOnlyFiles.length === 0
        ? 'Tests pass. The change only touches comments and blank lines; there are no added statements for coverage to attest.'
        : 'Tests pass. The change only removes code and touches comments and blank lines; there are no added statements for coverage to attest.';
  // ADR-11 made SAFE require every coverable changed statement to have run, so
  // the common UNPROVEN is now PARTIAL coverage, not zero. Saying "not exercised
  // by any test" there would be false — some of it was — and would send the
  // reader hunting for a test that already exists. Name the ratio instead.
  const stats = cov.changedStatements;
  const partialReason =
    stats && stats.total > 0 && stats.covered > 0
      ? `Tests pass, but only ${stats.covered} of ${stats.total} changed statements were exercised.`
      : 'Tests pass, but the changed code is not exercised by any test.';
  // ADR-18: when the ONLY thing keeping the change from SAFE is excluded changed
  // statements (every non-covered changed statement is excluded), name that
  // distinctly and give the RIGHT remedy — an excluded line can't be tested, so
  // "add a test" would be the confidently-wrong advice. Gated on covered+excluded
  // === total so a genuinely-uncovered statement still gets the partial reason
  // (and its missingTests hint). Distinct substring: consumers pattern-match on it.
  const excludedCount = cov.excludedChangedStatements ?? 0;
  const excludedReason =
    stats && excludedCount > 0 && stats.covered + excludedCount === stats.total
      ? excludedCount === 1
        ? `Tests pass, but a changed statement is excluded from coverage (e.g. \`# pragma: no cover\` or a coverage config) and cannot be proven; for an untrusted diff an excluded change is not verified. Remove the exclusion or verify it another way.`
        : `Tests pass, but ${excludedCount} changed statements are excluded from coverage and cannot be proven; for an untrusted diff an excluded change is not verified. Remove the exclusions or verify them another way.`
      : null;
  // Named before partialReason: statement coverage can be complete here, so
  // "N of N exercised" would mislead (ADR-14).
  const branchGaps = cov.partialBranches ?? [];
  const branchReason =
    branchGaps.length === 1
      ? `Tests pass, but a changed conditional has a branch no test took (${branchGaps[0]!.file}:${branchGaps[0]!.line}). Add a test that enters the other branch.`
      : `Tests pass, but ${branchGaps.length} changed conditionals have a branch no test took. Add tests that enter the untaken branches.`;
  // Top precedence, and gated on complete coverage: a survivor is only reported
  // when mutation ran, which is only when coverage was complete, so "N of N
  // exercised" would mislead. The changedLinesCovered guard is defense in depth
  // against a future producer emitting survivors under incomplete coverage.
  const survivors = cov.changedLinesCovered === true ? (mutation?.survivors ?? []) : [];
  const fmt = (s: { file: string; line: number; operator: string; mutatedTo: string }) =>
    `${s.file}:${s.line}, ${s.operator} to ${s.mutatedTo}`;
  const mutationReason =
    survivors.length === 1
      ? `Tests pass, but a mutant of a changed statement survived (${fmt(survivors[0]!)}): no test failed when its behaviour changed. Add a test that asserts on it.`
      : `Tests pass, but ${survivors.length} mutants of changed statements survived: no test failed when their behaviour changed. Add assertions that would catch them.`;
  const coverageReason =
    survivors.length > 0
      ? mutationReason
      : nothingToAttest
        ? nothingToAttestReason
        : cov.changedLinesCovered === 'unknown'
          ? 'Tests pass, but coverage of the changed code could not be determined.'
          : branchGaps.length > 0
            ? branchReason
            : (excludedReason ?? partialReason);
  // Tie-break when more than one thing could explain the UNPROVEN. A scope or
  // flaky reason wins ONLY when coverage would otherwise have said SAFE; when
  // coverage already forces UNPROVEN ('unknown' or false) the coverage reason
  // stands, because it is the more specific fact. Scope outranks flaky: if the
  // suite was narrowed, "a stable green could not be established" understates
  // the problem, which is that no full green was ever attempted. Both ride on
  // `base` in every branch, so the report always carries them regardless.
  // stabilityReason outranks coverageReason (which carries the mutation reason):
  // a flaky suite makes the mutation result itself unreliable, so a varied test
  // is the more fundamental fact to surface. It ranks below narrowed/fail→heal
  // for the same reason those outrank each other — a suite that never ran a
  // stable full green is a deeper problem than one that ran once and varied.
  const reason =
    cov.changedLinesCovered === true
      ? (narrowedReason ?? flakyReason ?? stabilityReason ?? coverageReason)
      : coverageReason;
  // Cap the hint list. A mass reformat once emitted 3666 hints and an 883 KB
  // JSON report; nobody reads that, and no agent should have to stream it. The
  // shortfall is still reported in full via `missingTestsTruncated.total`, which
  // must reflect the count BEFORE any upstream capping of `cov.uncovered`;
  // otherwise the notice under-counts the gap it exists to disclose.
  const missingTests = cov.uncovered.slice(0, MISSING_TESTS_CAP).map((u) => ({
    file: u.file,
    // A statement coverage.py EXCLUDED (`# pragma: no cover`, `if
    // TYPE_CHECKING:`) is deliberately unreachable by the suite. Telling the
    // user to "add a test exercising" it hands them an uncompletable task and
    // makes the tool look broken; name the real situation instead.
    hint: u.excluded
      ? `${u.file}:${u.line} is excluded from coverage (e.g. \`# pragma: no cover\`, \`if TYPE_CHECKING:\`), so no test can exercise it; review this change by hand`
      : `add a test exercising ${u.file}:${u.line}`,
  }));
  const truncated = missingTests.length > 0 && uncoveredTotal > missingTests.length;
  return {
    verdict: 'UNPROVEN',
    ...base,
    reason,
    ...(missingTests.length > 0 ? { missingTests } : {}),
    ...(truncated
      ? { missingTestsTruncated: { shown: missingTests.length, total: uncoveredTotal } }
      : {}),
  };
}
