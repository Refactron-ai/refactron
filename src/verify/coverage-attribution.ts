// src/verify/coverage-attribution.ts
// Map changed physical lines to the STATEMENTS that CONTAIN them, then judge
// coverage on those statements. Pure: no I/O, no process state. The containment
// map itself comes from the AST sidecar (checks/_py/statement_map.py).
//
// Why this exists. coverage.py records execution against a statement's FIRST
// line only. Continuation lines, closing brackets, comments and blanks appear in
// neither `executed_lines` nor `missing_lines`, so asking "is this exact
// physical line in the executed set?" answers "no" for every line a formatter
// wrapped. A 396-hunk `black` reformat of pydantic/_internal produced 3666 such
// entries, among them lines 24-30 of _generate_schema.py: the names inside a
// `from ipaddress import (...)` whose statement start (line 23) provably ran.
// The verdict direction was conservative, but the evidence was fiction.
//
// Why containment, and not a walk back to the nearest statement start. The
// obvious repair, `enclosing(L) = max{start <= L}`, is UNSOUND, and it shipped a
// false SAFE. Statement STARTS carry no extent, so that rule cannot distinguish
//
//   (a) L is a continuation line of that statement    (attribution is sound)
//   (b) L is a blank / comment / dead-branch line that merely FOLLOWS it and
//       belongs to a different, unexecuted block       (attribution is fiction)
//
// In case (b) an executed `def`/`class`/`if` header vouches for a body that
// never ran. Reproduced end to end: a `return a + b` -> `return a * b` inside a
// never-called function, plus ONE changed blank line elsewhere in the file, read
// SAFE. Formatters insert and remove blank lines constantly, so this fired on
// the exact workload the feature targets. Real extents from the AST are the only
// way to tell (a) from (b), and the sidecar supplies them.
//
// Two properties the AST buys that no coverage.py line list can:
//   * INERTNESS. A line carrying no code token (blank, or comment-only) belongs
//     to no statement. It can neither change behavior nor be proven by a test,
//     so it must not mark its file exercised and must not be reported uncovered.
//   * INNERMOST CONTAINMENT. A change inside `if False:` attributes to the
//     folded statement, which coverage never marked executed, rather than to the
//     `if False:` header, which it did. coverage 7.11 reports statements inside
//     a compiler-folded branch in NONE of executed / missing / excluded, so
//     `executed U missing U excluded` is still not the executable set; only the
//     AST closes that hole.
import { normalizePath } from '../analyze/coverage/index.js';
import type { ChangedRange } from './diff-input.js';

/** Ceiling on reported uncovered statements. Even after dedup a mass reformat
 *  can produce thousands; an 883 KB JSON report helps nobody. Truncation is
 *  always reported in `uncoveredTruncated`, because a silently short list
 *  would be a lie about the size of the gap. */
export const UNCOVERED_CAP = 200;

/** Slots each file is guaranteed before any file takes a second helping. A flat
 *  cap applied in diff order lets ONE pathological file consume every slot, so
 *  later files disappear from the report and `{shown,total}` discloses a count
 *  without disclosing that whole FILES are missing. */
export const PER_FILE_UNCOVERED_CAP = 5;

/** Owner value the sidecar uses for a code line inside no statement. Should be
 *  unreachable; it exists so an unanticipated shape degrades to "cannot
 *  attribute" (never exercised) instead of vanishing into the inert bucket. */
export const UNATTRIBUTABLE_OWNER = -1;

/** A contiguous stretch of physical lines sharing one enclosing statement.
 *  `owner` is that statement's first line, which is the line coverage.py records
 *  execution against. Runs are ascending and non-overlapping; a line in NO run
 *  is INERT. */
export interface StatementRun {
  first: number;
  last: number;
  owner: number;
}

export interface CoverageAttributionInput {
  ranges: ChangedRange[];
  /** `${normalizedRelPath}:${line}` for every line coverage.py saw execute. */
  coveredLines: Set<string>;
  /** `${relPath}:${line}` for each partially-taken branch (ADR-14). Absent means
   *  no `--branch` data; attribution then rests on the statement rule alone. */
  partialBranchLines?: Set<string>;
  /** Line-to-enclosing-statement runs per normalized relative path, from the AST
   *  sidecar. A file missing here is treated as fully unattributable (never
   *  exercised); verify-diff bails the whole assessment to UNKNOWN first. */
  statementRuns: Map<string, StatementRun[]>;
  /** Statement lines coverage.py EXCLUDED (`# pragma: no cover`,
   *  `if TYPE_CHECKING:`). Such a statement can never be exercised by any test,
   *  so the report words its hint differently instead of asking for an
   *  impossible one. */
  excludedLines?: Map<string, Set<number>>;
  /** Test seams; default to the caps above. */
  uncoveredCap?: number;
  perFileCap?: number;
}

export interface UncoveredStatement {
  file: string;
  line: number;
  /** Set when coverage.py excluded this statement, so no test can reach it. */
  excluded?: boolean;
}

export interface CoverageAttribution {
  changedLinesCovered: boolean;
  /** One entry per UNEXECUTED enclosing statement, deduped, capped. Always
   *  populated, including when the verdict is SAFE: a report that discloses the
   *  statements it did NOT prove is strictly more honest, and suppressing this
   *  list is what made the false SAFE invisible. */
  uncovered: UncoveredStatement[];
  uncoveredTruncated?: { shown: number; total: number };
  /** Distinct files with at least one uncovered statement, counted BEFORE any
   *  cap, so a truncated list still says how many files it spans. */
  filesWithUncovered: number;
  /** Distinct changed statements, and how many of them executed. A ratio the
   *  boolean cannot express ("12 of 40 changed statements exercised"). It does
   *  NOT feed the verdict rule. */
  changedStatements: { total: number; covered: number };
  /** Distinct CHANGED statements coverage.py excluded (`# pragma: no cover`,
   *  config `exclude_lines`, `if TYPE_CHECKING:`). Since ADR-18 these do NOT count
   *  toward SAFE: in the verify-untrusted-PR model the exclusion is
   *  attacker-controlled, so an excluded changed statement is unproven and floors
   *  the verdict. Surfaced so a consumer can see the floor's cause. */
  excludedChangedStatements: number;
  /** Files whose changed lines are ALL inert. Nothing to attest, so they get
   *  their own bucket and reason rather than a free pass: added lines are all a
   *  diff exposes, so a DELETED statement beside a moved blank line is invisible
   *  here, exactly as for a removal-only file. */
  inertOnlyFiles: string[];
  /** Changed conditionals with an untaken branch (ADR-14); each disqualifies SAFE. */
  partialBranches?: Array<{ file: string; line: number }>;
}

/** The run containing `line`, or null when the line is inert. Binary search, not
 *  a scan: a mass reformat pairs thousands of changed lines with thousands of
 *  runs, and the quadratic version of this is a visible stall. */
function runContaining(runs: StatementRun[], line: number): StatementRun | null {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const run = runs[mid] as StatementRun;
    if (line < run.first) hi = mid - 1;
    else if (line > run.last) lo = mid + 1;
    else return run;
  }
  return null;
}

interface FileAccumulator {
  /** The caller's own spelling of the path; normalization is for lookup only. */
  displayPath: string;
  seen: Set<number>;
  uncovered: UncoveredStatement[];
  /** Saw at least one changed line that was not inert. */
  attributable: boolean;
  /** Saw at least one changed line at all (false => removal-only). */
  hadChangedLines: boolean;
  /** Distinct changed statements in this file. */
  statements: number;
  /** How many of them coverage.py saw execute. */
  covered: number;
  /** How many changed statements coverage.py EXCLUDED (`# pragma: no cover`,
   *  config `exclude_lines`, `if TYPE_CHECKING:`). Counted for DISCLOSURE only,
   *  NOT subtracted from the requirement: an exclusion is attacker-controllable in
   *  the diff under verification, so an excluded changed statement floors the file
   *  to UNPROVEN rather than clearing it (ADR-18, superseding ADR-11's
   *  subtraction). */
  excluded: number;
  /** Changed lines that are partially-taken branches (ADR-14); disqualify SAFE. */
  branchGaps: number[];
}

export function attributeChangedLines(input: CoverageAttributionInput): CoverageAttribution {
  const cap = input.uncoveredCap ?? UNCOVERED_CAP;
  const perFileCap = input.perFileCap ?? PER_FILE_UNCOVERED_CAP;

  // Keyed by NORMALIZED path so two ranges naming the same file share one dedup
  // set, one exercised flag and one uncovered list. Insertion order is diff
  // order, which is the order the report reads back in.
  const files = new Map<string, FileAccumulator>();
  const changedStatements = { total: 0, covered: 0 };

  for (const range of input.ranges) {
    const rel = normalizePath(range.path);
    let acc = files.get(rel);
    if (!acc) {
      acc = {
        displayPath: range.path,
        seen: new Set(),
        uncovered: [],
        attributable: false,
        hadChangedLines: false,
        statements: 0,
        covered: 0,
        excluded: 0,
        branchGaps: [],
      };
      files.set(rel, acc);
    }
    if (range.lines.length > 0) acc.hadChangedLines = true;

    const runs = input.statementRuns.get(rel);
    const excluded = input.excludedLines?.get(rel);

    for (const line of range.lines) {
      // A file the sidecar never analyzed has no runs. Err strict: treat every
      // changed line as unattributable code rather than inert, so a map we
      // failed to build can never read as "nothing to prove".
      const run = runs
        ? runContaining(runs, line)
        : { first: line, last: line, owner: UNATTRIBUTABLE_OWNER };
      if (run === null) continue; // inert: no code token on this line
      acc.attributable = true;

      // An unattributable code line is reported at its own physical line. It can
      // never collide with a statement start in `seen`, since by definition it
      // sits inside no statement.
      const key = run.owner === UNATTRIBUTABLE_OWNER ? line : run.owner;
      if (acc.seen.has(key)) continue;
      acc.seen.add(key);
      changedStatements.total += 1;
      acc.statements += 1;

      // Before the covered-line short-circuit below: a partial branch DID
      // execute, so it would otherwise count as covered and reach SAFE (ADR-14).
      if (
        input.partialBranchLines !== undefined &&
        (input.partialBranchLines.has(`${rel}:${key}`) ||
          input.partialBranchLines.has(`${rel}:${line}`))
      ) {
        acc.branchGaps.push(key);
      }

      if (run.owner !== UNATTRIBUTABLE_OWNER && input.coveredLines.has(`${rel}:${run.owner}`)) {
        changedStatements.covered += 1;
        acc.covered += 1;
        continue;
      }
      const isExcluded = excluded?.has(key) === true;
      if (isExcluded) acc.excluded += 1;
      acc.uncovered.push({
        file: acc.displayPath,
        line: key,
        ...(isExcluded ? { excluded: true } : {}),
      });
    }
  }

  const inertOnlyFiles: string[] = [];
  const partialBranches: Array<{ file: string; line: number }> = [];
  let allFilesProven = true;
  for (const acc of files.values()) {
    // A file with changed lines but nothing attributable among them has nothing
    // to attest. Same treatment as removal-only: conservative, with its own
    // bucket so the verdict reason can say what actually happened.
    if (acc.hadChangedLines && !acc.attributable) inertOnlyFiles.push(acc.displayPath);

    // ADR-11 as amended by ADR-18. A file is proven when it has at least one
    // changed statement and EVERY changed statement executed. Excluded changed
    // statements are NOT subtracted from the requirement: coverage.py never lists
    // an excluded line in executed_lines, so `covered < statements` whenever any
    // changed statement is excluded, and the file floors to UNPROVEN.
    //
    // The old rule subtracted exclusions (`coverable = statements - excluded`),
    // which let a hostile diff annotate a changed backdoor with `# pragma: no
    // cover` (or a coveragerc/pyproject regex) and still earn SAFE
    // (GHSA-9xch-4mch-222g). In the verify-untrusted-PR model every exclusion
    // source is attacker-controlled, so an excluded changed statement is not
    // proof. The `statements === 0` arm keeps removal-only and inert-only files
    // UNPROVEN (they produced no changed statement): `0 === 0` must not read as
    // proof.
    if (acc.statements === 0 || acc.covered < acc.statements) allFilesProven = false;

    // ADR-14: an untaken arc disqualifies the file even when its statements ran.
    if (acc.branchGaps.length > 0) {
      allFilesProven = false;
      for (const line of acc.branchGaps) partialBranches.push({ file: acc.displayPath, line });
    }
  }

  return {
    // ADR-11 as amended by ADR-18: the change is covered iff EVERY changed file
    // has at least one changed statement and ALL of its changed statements
    // executed. Excluded changed statements do not count as proof (they floor to
    // UNPROVEN). The v1 rule cleared a whole file on ONE exercised statement, so a
    // diff changing 40 statements with 1 executed read SAFE while the reason
    // string claimed "the changed code is covered".
    // ADR-14 adds a second conjunct: no changed line may be a partial branch.
    changedLinesCovered: allFilesProven,
    ...selectUncovered([...files.values()], cap, perFileCap),
    changedStatements,
    excludedChangedStatements: [...files.values()].reduce((n, a) => n + a.excluded, 0),
    inertOnlyFiles,
    ...(partialBranches.length > 0 ? { partialBranches } : {}),
  };
}

/** Choose which uncovered statements to report, in two passes: a guaranteed
 *  per-file share first so no file can be squeezed out entirely, then leftovers
 *  in diff order until the global cap. The selection is emitted back in diff
 *  order, so the fair-share pass never shows through as a reordering. */
function selectUncovered(
  accs: FileAccumulator[],
  cap: number,
  perFileCap: number,
): Pick<CoverageAttribution, 'uncovered' | 'filesWithUncovered'> &
  Partial<Pick<CoverageAttribution, 'uncoveredTruncated'>> {
  let total = 0;
  let filesWithUncovered = 0;
  for (const acc of accs) {
    total += acc.uncovered.length;
    if (acc.uncovered.length > 0) filesWithUncovered += 1;
  }

  const taken = accs.map((acc) => Math.min(acc.uncovered.length, perFileCap));
  let budget = cap - taken.reduce((a, b) => a + b, 0);
  if (budget < 0) {
    // More files than slots: trim the fair shares from the tail so the earliest
    // files keep a full share rather than every file keeping a fractional one.
    for (let i = taken.length - 1; i >= 0 && budget < 0; i--) {
      const give = Math.min(taken[i] as number, -budget);
      taken[i] = (taken[i] as number) - give;
      budget += give;
    }
  } else {
    for (let i = 0; i < accs.length && budget > 0; i++) {
      const acc = accs[i] as FileAccumulator;
      const extra = Math.min(acc.uncovered.length - (taken[i] as number), budget);
      taken[i] = (taken[i] as number) + extra;
      budget -= extra;
    }
  }

  const uncovered: UncoveredStatement[] = [];
  for (let i = 0; i < accs.length; i++) {
    uncovered.push(...(accs[i] as FileAccumulator).uncovered.slice(0, taken[i] as number));
  }
  return {
    uncovered,
    filesWithUncovered,
    ...(total > uncovered.length ? { uncoveredTruncated: { shown: uncovered.length, total } } : {}),
  };
}
