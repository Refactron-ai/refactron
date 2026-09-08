// src/verify/verify-diff.ts
// Verify an arbitrary diff Refactron did NOT author. Composes the existing
// RefactronVerifier (pass/fail gates) with reportCoverage (changed-line
// coverage, Python only) into a SAFE/UNSAFE/UNPROVEN verdict. Read-only:
// never mutates the caller's repo.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { RefactronVerifier } from './engine.js';
import { createShadowTree } from './shadow-tree.js';
import { reportCoverage, normalizePath } from '../analyze/coverage/index.js';
import { attributeChangedLines } from './coverage-attribution.js';
import { buildStatementMap } from './statement-map.js';
import {
  fuseVerdict,
  isTestFile,
  type CoverageAssessment,
  type VerdictReport,
} from './verdict-fuse.js';
import { detectTestWeakening } from './test-weakening.js';
import {
  assessTestScope,
  configsDeclareTestpaths,
  PYTEST_CONFIG_FILES,
  type PytestConfigContext,
  type PytestConfigSource,
  type TestScopeAssessment,
} from './test-scope.js';
import { detectRunner } from './runners/detect.js';
import { ENGINE_VERSION } from '../engine-version.js';
import { changedLinesForEdits, editsFromUnifiedDiff, type FileEdit } from './diff-input.js';
import { runMutation, type MutationResult } from './mutation.js';
import { runStabilityCheck, type StabilityResult } from './stability.js';
import type { FileChange, RefactorPlan, TransformId } from '../contracts.js';

export interface VerifyDiffInput {
  repoRoot: string;
  edits?: FileEdit[];
  unifiedDiff?: string;
  testCmd?: string;
  timeoutMs?: number;
  // Opt-in mutation testing (ADR-15). Off by default; when set, a surviving
  // mutant of a changed statement downgrades SAFE to UNPROVEN. Never strengthens.
  mutate?: boolean;
  // Opt-in stability check (#146). Off by default; when set, a would-be-SAFE
  // suite is rerun under varied conditions and a test whose outcome varies
  // downgrades SAFE to UNPROVEN. Never strengthens.
  flakyCheck?: boolean;
  // Whether the DIFF AUTHOR is trusted (ADR-19). Default false — the safe
  // default, because coverage/pass-fail are measured by running the diff's own
  // suite in-process, which a hostile diff can forge (GHSA Finding 1). When
  // false, a would-be-SAFE floors to UNPROVEN. Set true ONLY for a diff whose
  // author you trust (self/dev use); it restores SAFE by trusting the in-process
  // measurement. It is never inferred from the diff — the diff is the untrusted
  // input — so it must be asserted by the operator.
  trusted?: boolean;
}

// Inert at verify time (keystone spike: transformId/oldHash are never read).
const SYNTHETIC_TRANSFORM = 'external-diff' as unknown as TransformId;

// FileEdit paths are repo-relative, but the shadow tree keys off
// `path.relative(sourceRoot, change.path)` and rejects anything that escapes
// the root. A bare relative path is resolved against process.cwd(), which is
// rarely the repo root — so we resolve it against `repoRoot` here, matching the
// absolute-path convention the verify engine already uses for FileChange.
function toChanges(repoRoot: string, edits: FileEdit[]): FileChange[] {
  return edits.map((e) => ({
    path: path.resolve(repoRoot, e.path),
    oldHash: '',
    newContent: e.newContent,
    transformId: SYNTHETIC_TRANSFORM,
  }));
}

// The caller passes ONE full shell command. RefactronVerifier runs it verbatim
// via `sh -c`; reportCoverage decides for itself how to wrap it for `coverage
// run` (see toCoverageRunArgs). This module deliberately does no pre-mangling:
// the old `python -m ` strip destroyed script-form commands such as Django's
// `python3 tests/runtests.py`, which then measured no coverage at all.

export async function verifyDiff(input: VerifyDiffInput): Promise<VerdictReport> {
  const edits =
    input.edits ??
    (input.unifiedDiff ? await editsFromUnifiedDiff(input.repoRoot, input.unifiedDiff) : []);
  if (edits.length === 0) {
    throw new Error('verifyDiff: no edits provided (pass `edits` or `unifiedDiff`)');
  }
  const changedFiles = edits.map((e) => e.path);

  // #163: which changed test files did the diff WEAKEN (assertions removed, tests
  // deleted, skips added)? Read the pre-diff content from the base tree and compare
  // to the edit. A would-be-SAFE resting on tests the same diff relaxed is withheld
  // in fuseVerdict. A missing base file (a newly-added test) reads as empty → never
  // weakening.
  const testWeakening = detectTestWeakening(
    await Promise.all(
      edits
        .filter((e) => isTestFile(e.path))
        .map(async (e) => ({
          file: e.path,
          oldContent: await fs
            .readFile(path.resolve(input.repoRoot, e.path), 'utf8')
            .catch(() => ''),
          newContent: e.newContent,
        })),
    ),
  );

  // 1. Gates (pass/fail) — the existing verifier manages its own shadow tree.
  const verifier = new RefactronVerifier({
    projectRoot: input.repoRoot,
    ...(input.testCmd ? { testCmd: input.testCmd } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });
  const result = await verifier.verify({
    changes: toChanges(input.repoRoot, edits),
    preconditions: [],
  } as RefactorPlan);

  // Scope resolved before coverage so mutation can gate on the FULL would-be-SAFE
  // precondition. A narrowed suite already floors the verdict, so mutating it
  // would burn minutes for a decided verdict (ADR-15 perf; the tests-gate flaky
  // signal is the other half).
  const testScope = await resolveTestScope(input);
  const flaky = (result.gates.tests as { flakySuspects?: unknown[] }).flakySuspects?.length ?? 0;
  const wouldBeSafe = result.passed && flaky === 0 && testScope.scope !== 'narrowed';

  // 2. Coverage (only when gates pass; Python only), and the opt-in deep checks
  // alongside it (mutation, stability) when requested and the change could still
  // reach SAFE. Both only downgrade, so running them on an already-floored
  // verdict burns minutes for a decided answer.
  let cov: CoverageAssessment = unknownCoverage();
  let mutation: MutationResult | undefined;
  let stability: StabilityResult | undefined;
  if (result.passed) {
    const assessed = await assessCoverage(input, edits, {
      runMut: input.mutate === true && wouldBeSafe,
      runFlaky: input.flakyCheck === true && wouldBeSafe,
    });
    cov = assessed.coverage;
    mutation = assessed.mutation;
    stability = assessed.stability;
  }

  // 3. Fuse. The scope of the run is a verdict input, not a note: a green run of
  // a caller-chosen subset cannot earn SAFE (issue #110, ADR-12).
  //
  // engineVersion is stamped HERE rather than inside fuseVerdict, which
  // documents itself as pure with no I/O. This is already the I/O layer.
  return {
    ...fuseVerdict(
      result,
      changedFiles,
      cov,
      testScope,
      input.trusted === true,
      testWeakening,
      mutation,
      stability,
    ),
    engineVersion: ENGINE_VERSION,
  };
}

/** Resolve the scope of the run, including the runner the engine WOULD pick when
 *  the caller supplied no command.
 *
 *  Without the detected command, ambient option variables were scanned with the
 *  pytest table for every project, so a `PYTEST_ADDOPTS` left in a shell floored
 *  a vitest project - the exact thing docs/verification/verdicts.mdx promises it
 *  will not do. `detectRunner` is a few fs.access calls; the tests gate calls it
 *  again with the same inputs and gets the same answer. */
async function resolveTestScope(input: VerifyDiffInput): Promise<TestScopeAssessment> {
  const pytestConfig = await readPytestContext(input.repoRoot);
  if (input.testCmd !== undefined && input.testCmd.trim() !== '') {
    return assessTestScope(input.testCmd, process.env, undefined, pytestConfig);
  }
  const spec = await detectRunner(input.repoRoot);
  const detected = spec ? [spec.cmd, ...spec.args].join(' ') : undefined;
  return assessTestScope(undefined, process.env, detected, pytestConfig);
}

/** pytest configuration living at the repository root (#137).
 *
 *  Root only, deliberately. pytest walks UP to find its rootdir, but the suite
 *  runs inside the shadow tree, whose parent is a temp directory: a config above
 *  the repository is not copied and therefore does not apply to the run we are
 *  judging. Reading it would report narrowing that never happened.
 *
 *  A missing file is the overwhelming case and is simply skipped. */
async function readPytestContext(repoRoot: string): Promise<PytestConfigContext> {
  const configs: PytestConfigSource[] = [];
  for (const name of PYTEST_CONFIG_FILES) {
    try {
      configs.push({ name, content: await fs.readFile(path.join(repoRoot, name), 'utf8') });
    } catch {
      // Absent, unreadable, or not UTF-8. pytest could not read it either.
    }
  }
  // Walked ONLY when a config actually declares `testpaths`, which is the only
  // question the list answers. The walk costs about a second on a large
  // checkout, and most projects never set the key, so this keeps the common
  // path free.
  const testFiles = configsDeclareTestpaths(configs) ? await findTestFiles(repoRoot) : null;
  return { configs, testFiles };
}

/** Directories pytest would not collect from, or that would make the walk
 *  unbounded on a real checkout. */
const UNWALKED = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '.tox',
  '.nox',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'dist',
  'build',
  '.eggs',
]);

/** pytest's DEFAULT discovery patterns. A project that overrides `python_files`
 *  is detected by the caller of this list and treated conservatively, because
 *  this list would then have been built with the wrong pattern. */
function looksLikeTest(name: string): boolean {
  return /^test_.*\.py$/.test(name) || /_test\.py$/.test(name);
}

/** Repo-relative POSIX paths of the files pytest would discover as tests.
 *
 *  Used only to answer whether a `testpaths` entry excludes anything.
 *
 *  Returns `null` when the answer would be a guess. Truncation is the case that
 *  matters: a capped walk returns a non-empty but INCOMPLETE list, and the file
 *  that `testpaths` excludes could be exactly the one past the cap. Reporting
 *  that as "nothing outside testpaths" would clear a verdict on an answer we do
 *  not have, so it floors instead. */
async function findTestFiles(root: string): Promise<string[] | null> {
  const out: string[] = [];
  const CAP = 5000;
  let truncated = false;
  async function walk(dir: string, rel: string): Promise<void> {
    if (out.length >= CAP) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= CAP) {
        truncated = true;
        return;
      }
      if (e.name.startsWith('.') && e.isDirectory()) continue;
      if (UNWALKED.has(e.name)) continue;
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(path.join(dir, e.name), childRel);
      else if (e.isFile() && looksLikeTest(e.name)) out.push(childRel);
    }
  }
  await walk(root, '');
  return truncated ? null : out;
}

/** Coverage we could not establish. A fresh object each time: callers own it.
 *  Never a shared literal, and never "covered": every degradation path in
 *  assessCoverage lands here, and reporting an unmeasured change as covered
 *  would be a false SAFE. */
function unknownCoverage(reason?: string): CoverageAssessment {
  return {
    tool: 'none',
    changedLinesCovered: 'unknown',
    uncovered: [],
    ...(reason ? { unknownReason: reason } : {}),
  };
}

/** Ceiling on how many paths a reason string names before it summarises. A
 *  reason is read by a human in a terminal and by an agent paying for context;
 *  a 200-file reformat must not spend either on a comma-separated wall. The
 *  shortfall is always stated, never silently dropped. */
const REASON_FILE_CAP = 5;

function listFiles(paths: string[]): string {
  if (paths.length <= REASON_FILE_CAP) return paths.join(', ');
  return `${paths.slice(0, REASON_FILE_CAP).join(', ')} and ${paths.length - REASON_FILE_CAP} more`;
}

async function assessCoverage(
  input: VerifyDiffInput,
  edits: FileEdit[],
  deep: { runMut: boolean; runFlaky: boolean },
): Promise<{
  coverage: CoverageAssessment;
  mutation?: MutationResult;
  stability?: StabilityResult;
}> {
  const pyEdits = edits.filter((e) => e.path.endsWith('.py'));
  // Coverage is Python-only. If ANY edit is non-Python (or there are no Python
  // edits at all), we cannot assess the WHOLE change. Reporting "covered" here
  // would silently pass an unverified non-Python change through as SAFE — a
  // false SAFE, which is forbidden. Bail to 'unknown' (→ UNPROVEN) unless every
  // edit is a `.py` file we can actually assess.
  if (pyEdits.length !== edits.length || pyEdits.length === 0) {
    // Say WHICH files, and say it every time. A bare `unknown` here is
    // indistinguishable from a coverage.py crash or a declined test command,
    // and this is the most common bail of the three on real diffs: a commit
    // touching a `.py` and its `.pyi` stub, a README, or a YAML fixture lands
    // here, and that describes most commits. Naming the offenders is also what
    // stops a reader concluding the tool is broken when it is working exactly
    // as designed.
    const nonPy = edits.filter((e) => !e.path.endsWith('.py')).map((e) => e.path);
    return {
      coverage: unknownCoverage(
        nonPy.length === 0
          ? 'the change contains no Python files, and changed-line coverage is measured only for Python (coverage.py)'
          : `changed-line coverage is measured only for Python (coverage.py), and this change also touches ${listFiles(nonPy)}`,
      ),
    };
  }
  const shadow = await createShadowTree(input.repoRoot, toChanges(input.repoRoot, edits));
  try {
    const report = await reportCoverage({
      projectRoot: shadow.path,
      ...(input.testCmd ? { testCmd: input.testCmd } : {}),
    });
    // No tool, or a measurement we could not actually perform, both mean the
    // same thing: coverage is UNKNOWN. Reporting an unmeasured empty set as
    // "not exercised by any test" would be a confident lie about the suite.
    if (!report.coverageToolFound || report.measurementFailed) {
      // Carry the reason. `reportCoverage` knows exactly why it could not
      // measure ("cannot wrap test command for coverage: ..."), and
      // tool-reference.mdx promises agents that `coverage.unknownReason` says
      // why coverage is unknown when we know. Dropping it here reproduced the
      // very failure this file guards against: a silent UNPROVEN that looks
      // identical whether the wrapper declined the command or the suite simply
      // never touched the code. Absent when we genuinely have no reason.
      return { coverage: unknownCoverage(report.measurementFailureReason) };
    }
    const ranges = await changedLinesForEdits(input.repoRoot, pyEdits);
    // Shadow-bypass guard. If a changed file was never MEASURED at all, the
    // suite never loaded our copy of it. The usual cause is the project being
    // pip-installed (editable or not) so `import pkg` resolves to the installed
    // copy instead of the tree under verification, meaning the tests ran the
    // ORIGINAL code and this run proves nothing about the change. Proven on
    // django: without the shadow root on sys.path the same diff read UNPROVEN
    // while with it the auth suite caught the change. Report unknown, never
    // "not exercised by any test".
    const unmeasured = ranges.filter(
      (r) => r.lines.length > 0 && !report.measuredFiles.has(normalizePath(r.path)),
    );
    if (unmeasured.length > 0) {
      // Say WHY, and say what fixes it. This is the dominant degradation path
      // for a project whose tests import an installed copy, and a bare "could
      // not be determined" leaves the user with no idea that a one-line change
      // to their test command would give them a real verdict. The remedy is
      // documented at verdicts.mdx "Make sure the tests run the code being
      // verified", but nobody who lands here has a reason to go read it.
      const names = unmeasured.map((r) => r.path).join(', ');
      return {
        coverage: unknownCoverage(
          `the test run never imported ${names}, so the suite exercised a different copy ` +
            `than the one being verified (usually an installed or editable package). ` +
            `Put the verified tree first on sys.path, for example by prefixing the test ` +
            `command with PYTHONPATH=. (or PYTHONPATH=src for a src layout).`,
        ),
      };
    }
    // Judge coverage on STATEMENTS, not physical lines, using real extents from
    // the Python AST. coverage.py only ever marks a statement's FIRST line, so a
    // diff that rewraps statements (any formatter) would otherwise report every
    // continuation line as uncovered. The cheap repair of walking back to
    // the nearest statement start above the line is unsound, because it cannot
    // tell a continuation line from a blank/comment/dead-branch line that merely
    // follows it. See coverage-attribution.ts. The map is built from the SHADOW
    // copies, which hold the changed content the changed-line numbers refer to.
    let statements;
    try {
      statements = await buildStatementMap(
        shadow.path,
        pyEdits.map((e) => e.path),
      );
    } catch (err) {
      // The sidecar could not run. Coverage of the change is UNKNOWN; degrading
      // to "covered" here would be a false SAFE bought with no evidence at all.
      // Carry WHY: a silent unknown is indistinguishable from an untested change
      // and cost us a full CI cycle to diagnose once already.
      return { coverage: unknownCoverage(err instanceof Error ? err.message : String(err)) };
    }
    // A file we could not parse has no honest containment map, and guessing one
    // means guessing which changed lines are inert. Unknown, never covered.
    if (statements.errors.size > 0) {
      const [file, reason] = [...statements.errors.entries()][0] ?? [];
      return { coverage: unknownCoverage(`could not map statements in ${file}: ${reason}`) };
    }
    const attributed = attributeChangedLines({
      ranges,
      coveredLines: report.coveredLines,
      statementRuns: statements.runs,
      excludedLines: report.excludedLines,
      ...(report.partialBranchLines ? { partialBranchLines: report.partialBranchLines } : {}),
    });
    // A removal-only file has no added lines, so it can never satisfy the
    // per-file heuristic; report it distinctly so the verdict reason can say
    // "nothing to attest" instead of implying a coverage miss. (Its inert-only
    // sibling gets the same treatment and rides along on `attributed`.)
    const removalOnlyFiles = ranges.filter((r) => r.lines.length === 0).map((r) => r.path);
    // The deep checks run only when the change is otherwise coverage-complete:
    // both can only downgrade, so a change already floored needs neither (the
    // caller's flags already exclude flaky/narrowed; ADR-15, #146).
    let mutation: MutationResult | undefined;
    let stability: StabilityResult | undefined;
    if (attributed.changedLinesCovered === true) {
      if (deep.runMut) {
        mutation = await runMutation({
          shadowRoot: shadow.path,
          ranges,
          ...(input.testCmd ? { testCmd: input.testCmd } : {}),
          ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        });
      }
      if (deep.runFlaky) {
        // A fresh shadow per rerun, so the check builds its own from the same
        // changes rather than sharing the coverage shadow (state isolation).
        stability = await runStabilityCheck({
          repoRoot: input.repoRoot,
          changes: toChanges(input.repoRoot, edits),
          ...(input.testCmd ? { testCmd: input.testCmd } : {}),
          ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        });
      }
    }
    // Spread, never rebuild field by field: an allow-list silently drops any
    // field a future CoverageAttribution adds, and the last allow-list here also
    // DELETED `uncovered` whenever the verdict was SAFE, which is precisely how
    // the false SAFE stayed invisible. A SAFE report that discloses the changed
    // statements it did not prove is strictly more honest.
    const coverage: CoverageAssessment = {
      tool: 'coverage.py',
      ...attributed,
      ...(removalOnlyFiles.length > 0 ? { removalOnlyFiles } : {}),
    };
    return { coverage, ...(mutation ? { mutation } : {}), ...(stability ? { stability } : {}) };
  } finally {
    await shadow.cleanup();
  }
}
