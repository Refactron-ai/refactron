import { describe, it, expect } from 'vitest';
import {
  attributeChangedLines,
  UNCOVERED_CAP,
  PER_FILE_UNCOVERED_CAP,
  UNATTRIBUTABLE_OWNER,
  type StatementRun,
} from '../../../src/verify/coverage-attribution.js';
import type { ChangedRange } from '../../../src/verify/diff-input.js';

// Shorthand builders. `covered` is the `${relPath}:${line}` key set coverage.py
// produces from executed_lines. `stmts` is the containment map the AST sidecar
// emits: ascending, non-overlapping `[first, last, owner]` runs over PHYSICAL
// lines, where `owner` is the first line of the innermost statement containing
// them. A line in NO run is INERT (blank, or comment-only): it carries no code
// token, so it can neither change behavior nor be proven by a test.
function cov(...keys: string[]): Set<string> {
  return new Set(keys);
}
function stmts(
  entries: Record<string, Array<[number, number, number]>>,
): Map<string, StatementRun[]> {
  return new Map(
    Object.entries(entries).map(([k, v]) => [
      k,
      v.map(([first, last, owner]) => ({ first, last, owner })),
    ]),
  );
}
function excl(entries: Record<string, number[]>): Map<string, Set<number>> {
  return new Map(Object.entries(entries).map(([k, v]) => [k, new Set(v)]));
}
function ranges(...rs: ChangedRange[]): ChangedRange[] {
  return rs;
}

describe('attributeChangedLines (AST statement containment)', () => {
  // The pydantic reformat case, stated unambiguously. `from ipaddress import (`
  // at line 10 is ONE statement whose extent runs to 14; black split its names
  // across the continuation lines. coverage.py only ever marks line 10.
  //
  // The predecessor test passed input byte-identical to the exploit below (a
  // statement start at 10, changed lines 10..14) while demanding the opposite
  // answer, because "statement starts" alone cannot express the difference
  // between "10..14 are one statement" and "line 10 is a statement and 11..14
  // are blank lines after it". Extents can, and that is the whole fix.
  it('continuation lines of an EXECUTED statement count as exercised', () => {
    const out = attributeChangedLines({
      ranges: ranges({ path: 'pkg/mod.py', lines: [10, 11, 12, 13, 14] }),
      coveredLines: cov('pkg/mod.py:10'),
      statementRuns: stmts({
        'pkg/mod.py': [
          [10, 14, 10],
          [20, 20, 20],
        ],
      }),
    });
    expect(out.changedLinesCovered).toBe(true);
    expect(out.uncovered).toEqual([]);
    expect(out.changedStatements).toEqual({ total: 1, covered: 1 });
  });

  // THE FALSE SAFE THIS REWORK EXISTS TO KILL. Byte-identical changed lines to
  // the case above, but here 11..14 hold no code: the statement at 10 ends on
  // line 10 and what follows is blank. The physical-line mechanism could not
  // tell these two inputs apart and let line 10 vouch for all of them.
  it('lines that merely FOLLOW an executed statement are inert, not exercised', () => {
    const out = attributeChangedLines({
      ranges: ranges({ path: 'pkg/mod.py', lines: [10, 11, 12, 13, 14] }),
      coveredLines: cov('pkg/mod.py:10'),
      statementRuns: stmts({
        'pkg/mod.py': [
          [10, 10, 10],
          [20, 20, 20],
        ],
      }),
    });
    // Line 10 itself still counts; 11..14 contribute nothing either way.
    expect(out.changedLinesCovered).toBe(true);
    expect(out.changedStatements).toEqual({ total: 1, covered: 1 });
  });

  // The reproduced end-to-end regression, at unit scale: one blank line beside a
  // behavior change in a function no test calls. The blank must not vouch.
  it('a changed BLANK line never marks its file exercised', () => {
    const out = attributeChangedLines({
      ranges: ranges({ path: 'mod.py', lines: [9, 12] }),
      coveredLines: cov('mod.py:7'),
      statementRuns: stmts({
        'mod.py': [
          [7, 7, 7],
          [11, 11, 11],
          [12, 12, 12],
        ],
      }),
    });
    expect(out.changedLinesCovered).toBe(false);
    expect(out.uncovered).toEqual([{ file: 'mod.py', line: 12 }]);
    expect(out.changedStatements).toEqual({ total: 1, covered: 0 });
  });

  // Same shape with a comment. A comment inside a function body sits INSIDE the
  // enclosing `def`'s extent, so containment alone would hand it to the `def`
  // line, which runs at import time. The tokenizer settles it: no code token on
  // the line, so the sidecar leaves it out of every run.
  it('a changed COMMENT line never marks its file exercised', () => {
    const out = attributeChangedLines({
      ranges: ranges({ path: 'mod.py', lines: [6, 11] }),
      coveredLines: cov('mod.py:4', 'mod.py:7'),
      statementRuns: stmts({
        'mod.py': [
          [4, 4, 4],
          [7, 7, 7],
          [10, 10, 10],
          [11, 11, 11],
        ],
      }),
    });
    expect(out.changedLinesCovered).toBe(false);
    expect(out.uncovered).toEqual([{ file: 'mod.py', line: 11 }]);
  });

  // A docstring IS a statement in the AST, so a docstring-only change lands on
  // its own `Expr`. That statement may or may not have executed, and either
  // answer is honest; what it must never do is borrow the enclosing `def`'s.
  it('a changed DOCSTRING line lands on its own statement, not the enclosing def', () => {
    const out = attributeChangedLines({
      ranges: ranges({ path: 'mod.py', lines: [5] }),
      coveredLines: cov('mod.py:4'), // the `def` ran; coverage.py does not track function docstrings
      statementRuns: stmts({
        'mod.py': [
          [4, 4, 4],
          [5, 5, 5],
          [7, 7, 7],
        ],
      }),
    });
    expect(out.changedLinesCovered).toBe(false);
    expect(out.uncovered).toEqual([{ file: 'mod.py', line: 5 }]);
  });

  // The dead-branch hole. coverage 7.11 puts a statement inside `if False:` in
  // NONE of executed / missing / excluded, so `executed U missing U excluded` is
  // still not the executable set and a walk-back landed on the `if False:`
  // header, which IS in executed_lines. Containment lands INSIDE the branch.
  it('a change inside `if False:` is not vouched for by the executed header', () => {
    const out = attributeChangedLines({
      ranges: ranges({ path: 'mod.py', lines: [15] }),
      coveredLines: cov('mod.py:14'), // the `if False:` header executed
      statementRuns: stmts({
        'mod.py': [
          [14, 14, 14],
          [15, 15, 15],
        ],
      }),
    });
    expect(out.changedLinesCovered).toBe(false);
    expect(out.uncovered).toEqual([{ file: 'mod.py', line: 15 }]);
  });

  // coverage.py excludes a pragma'd block as a PHYSICAL RANGE (measured on 7.11:
  // excluded=[5..11] for a five-line `return` under a pragma'd `def`), so a set
  // built from those line numbers re-inflates a rewrap to one entry per physical
  // line. Containment collapses it back to one entry, at the statement.
  it('a multi-line rewrap inside an excluded block dedupes to ONE excluded entry', () => {
    const out = attributeChangedLines({
      ranges: ranges({ path: 'gated.py', lines: [8, 9] }),
      coveredLines: cov('gated.py:1', 'gated.py:2', 'gated.py:5'),
      // Ground truth from the sidecar on tests/fixtures/verify-diff-pragma:
      // the pragma'd `def` header owns only line 5; the multi-line `return`
      // under it owns 6..11.
      statementRuns: stmts({
        'gated.py': [
          [1, 1, 1],
          [2, 2, 2],
          [5, 5, 5],
          [6, 11, 6],
        ],
      }),
      excludedLines: excl({ 'gated.py': [5, 6, 7, 8, 9, 10, 11] }),
    });
    expect(out.changedLinesCovered).toBe(false);
    expect(out.uncovered).toEqual([{ file: 'gated.py', line: 6, excluded: true }]);
  });

  // The shape that dominates real code. Line 3 (`if TYPE_CHECKING:`) DOES run at
  // import time; the guarded import at 4 never does. Attribution must land on 4.
  it('a change inside `if TYPE_CHECKING:` lands on the guarded import, never the guard', () => {
    const out = attributeChangedLines({
      ranges: ranges({ path: 'mod.py', lines: [5, 6] }),
      coveredLines: cov('mod.py:1', 'mod.py:3', 'mod.py:10', 'mod.py:11'),
      // Ground truth from the sidecar on tests/fixtures/verify-diff-type-checking.
      statementRuns: stmts({
        'mod.py': [
          [1, 1, 1],
          [3, 3, 3],
          [4, 7, 4],
          [10, 10, 10],
          [11, 11, 11],
        ],
      }),
      excludedLines: excl({ 'mod.py': [3, 4] }),
    });
    expect(out.changedLinesCovered).toBe(false);
    expect(out.uncovered).toEqual([{ file: 'mod.py', line: 4, excluded: true }]);
    expect(out.uncovered.some((u) => u.line === 3)).toBe(false);
  });

  // SAFETY CASE, both directions. `x = [1,\n  3]` with ONLY the continuation
  // line edited: the statement start is untouched and not in the changed set, so
  // dropping the line would leave nothing to attest and could fuse to a false
  // SAFE. Containment keeps the claim anchored to the statement.
  it('a lone changed CONTINUATION line is attested by its executed statement start', () => {
    const out = attributeChangedLines({
      ranges: ranges({ path: 'pkg/mod.py', lines: [2] }),
      coveredLines: cov('pkg/mod.py:1'),
      statementRuns: stmts({ 'pkg/mod.py': [[1, 2, 1]] }),
    });
    expect(out.changedLinesCovered).toBe(true);
    expect(out.uncovered).toEqual([]);
    expect(out.changedStatements).toEqual({ total: 1, covered: 1 });
  });

  it('a lone changed CONTINUATION line of an UNEXECUTED statement is one entry at the start', () => {
    const out = attributeChangedLines({
      ranges: ranges({ path: 'pkg/mod.py', lines: [2] }),
      coveredLines: cov(), // line 1 never ran
      statementRuns: stmts({ 'pkg/mod.py': [[1, 2, 1]] }),
    });
    expect(out.changedLinesCovered).toBe(false);
    expect(out.uncovered).toEqual([{ file: 'pkg/mod.py', line: 1 }]);
    expect(out.changedStatements).toEqual({ total: 1, covered: 0 });
  });

  it('dedupes: one unexecuted 10-line statement yields exactly ONE uncovered entry', () => {
    const out = attributeChangedLines({
      ranges: ranges({ path: 'pkg/mod.py', lines: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14] }),
      coveredLines: cov('pkg/mod.py:20'),
      statementRuns: stmts({
        'pkg/mod.py': [
          [5, 14, 5],
          [20, 20, 20],
        ],
      }),
    });
    expect(out.uncovered).toEqual([{ file: 'pkg/mod.py', line: 5 }]);
    expect(out.changedStatements).toEqual({ total: 1, covered: 0 });
  });

  it('dedupes across two ranges naming the SAME file', () => {
    const out = attributeChangedLines({
      ranges: ranges({ path: 'pkg/mod.py', lines: [5, 6] }, { path: 'pkg/mod.py', lines: [7] }),
      coveredLines: cov(),
      statementRuns: stmts({ 'pkg/mod.py': [[5, 9, 5]] }),
    });
    expect(out.uncovered).toEqual([{ file: 'pkg/mod.py', line: 5 }]);
    expect(out.filesWithUncovered).toBe(1);
  });

  it('does NOT weaken: a genuinely untested statement is still reported uncovered', () => {
    const out = attributeChangedLines({
      ranges: ranges({ path: 'pkg/mod.py', lines: [30] }),
      coveredLines: cov('pkg/mod.py:10'),
      statementRuns: stmts({
        'pkg/mod.py': [
          [10, 10, 10],
          [30, 30, 30],
        ],
      }),
    });
    expect(out.changedLinesCovered).toBe(false);
    expect(out.uncovered).toEqual([{ file: 'pkg/mod.py', line: 30 }]);
  });

  it('mixes: one executed statement in a file is NOT enough (ADR-11)', () => {
    const out = attributeChangedLines({
      ranges: ranges({ path: 'pkg/mod.py', lines: [10, 11, 30] }),
      coveredLines: cov('pkg/mod.py:10'),
      statementRuns: stmts({
        'pkg/mod.py': [
          [10, 11, 10],
          [30, 30, 30],
        ],
      }),
    });
    // This assertion is INVERTED from the v1 rule, deliberately, and the input is
    // unchanged so the record of what changed survives. Under the per-file
    // heuristic this read `true`: one exercised statement cleared the whole file
    // and the verdict said "the changed code is covered" while line 30 had never
    // run. SAFE now requires every coverable changed statement to have executed.
    expect(out.changedLinesCovered).toBe(false);
    expect(out.uncovered).toEqual([{ file: 'pkg/mod.py', line: 30 }]);
    expect(out.changedStatements).toEqual({ total: 2, covered: 1 });
  });

  it('all changed statements executed → covered', () => {
    const out = attributeChangedLines({
      ranges: ranges({ path: 'pkg/mod.py', lines: [10, 11, 30] }),
      coveredLines: cov('pkg/mod.py:10', 'pkg/mod.py:30'),
      statementRuns: stmts({
        'pkg/mod.py': [
          [10, 11, 10],
          [30, 30, 30],
        ],
      }),
    });
    expect(out.changedLinesCovered).toBe(true);
    expect(out.changedStatements).toEqual({ total: 2, covered: 2 });
    expect(out.uncovered).toEqual([]);
  });

  // ADR-18 (supersedes ADR-11's subtraction). coverage.py EXCLUDES `# pragma: no
  // cover`, config `exclude_lines`, and `if TYPE_CHECKING:` blocks. The exclusion
  // is attacker-controllable in the diff under verification (GHSA-9xch-4mch-222g),
  // so an excluded CHANGED statement is not proof — it floors the file to
  // UNPROVEN rather than clearing it.
  describe('an excluded changed statement floors the file (ADR-18)', () => {
    it('floors the file even when every other changed statement is covered', () => {
      const out = attributeChangedLines({
        ranges: ranges({ path: 'pkg/mod.py', lines: [10, 30] }),
        coveredLines: cov('pkg/mod.py:10'),
        statementRuns: stmts({
          'pkg/mod.py': [
            [10, 10, 10],
            [30, 30, 30],
          ],
        }),
        excludedLines: new Map([['pkg/mod.py', new Set([30])]]),
      });
      // The security fix: a diff-controlled exclusion cannot clear the verdict.
      expect(out.changedLinesCovered).toBe(false);
      expect(out.excludedChangedStatements).toBe(1);
      // Still disclosed and tagged.
      expect(out.uncovered).toEqual([{ file: 'pkg/mod.py', line: 30, excluded: true }]);
      expect(out.changedStatements).toEqual({ total: 2, covered: 1 });
    });

    it('a change that is ENTIRELY excluded is not covered', () => {
      // Every changed statement excluded => covered (0) < statements (1) => not
      // proven. Issuing SAFE here would clear a change no test can reach.
      const out = attributeChangedLines({
        ranges: ranges({ path: 'pkg/mod.py', lines: [30] }),
        coveredLines: cov(),
        statementRuns: stmts({ 'pkg/mod.py': [[30, 30, 30]] }),
        excludedLines: new Map([['pkg/mod.py', new Set([30])]]),
      });
      expect(out.changedLinesCovered).toBe(false);
    });

    it('an excluded statement does not excuse an unexecuted coverable one', () => {
      const out = attributeChangedLines({
        ranges: ranges({ path: 'pkg/mod.py', lines: [10, 20, 30] }),
        coveredLines: cov('pkg/mod.py:10'),
        statementRuns: stmts({
          'pkg/mod.py': [
            [10, 10, 10],
            [20, 20, 20],
            [30, 30, 30],
          ],
        }),
        excludedLines: new Map([['pkg/mod.py', new Set([30])]]),
      });
      expect(out.changedLinesCovered).toBe(false);
    });
  });

  it('every changed file must have an exercised statement (per-file, not global)', () => {
    const out = attributeChangedLines({
      ranges: ranges({ path: 'a.py', lines: [10, 11] }, { path: 'b.py', lines: [5] }),
      coveredLines: cov('a.py:10'),
      statementRuns: stmts({ 'a.py': [[10, 11, 10]], 'b.py': [[5, 5, 5]] }),
    });
    expect(out.changedLinesCovered).toBe(false);
    expect(out.uncovered).toEqual([{ file: 'b.py', line: 5 }]);
    expect(out.filesWithUncovered).toBe(1);
  });

  describe('inert lines', () => {
    // A file whose changed lines are ALL inert has nothing to attest. It must not
    // be a free pass: added lines are the only thing a diff exposes, so a
    // DELETED statement beside a moved blank line is invisible here, exactly why
    // removal-only files are conservative too. Same bucket, same treatment.
    it('a file whose changed lines are ALL inert gets its own bucket, never a free pass', () => {
      const out = attributeChangedLines({
        ranges: ranges({ path: 'mod.py', lines: [9] }),
        coveredLines: cov('mod.py:7'),
        statementRuns: stmts({
          'mod.py': [
            [7, 7, 7],
            [11, 11, 11],
          ],
        }),
      });
      expect(out.changedLinesCovered).toBe(false);
      expect(out.uncovered).toEqual([]);
      expect(out.inertOnlyFiles).toEqual(['mod.py']);
      expect(out.changedStatements).toEqual({ total: 0, covered: 0 });
    });

    it('an inert-only file cannot make a DIFFERENT untested file read as exercised', () => {
      const out = attributeChangedLines({
        ranges: ranges({ path: 'a.py', lines: [9] }, { path: 'b.py', lines: [5] }),
        coveredLines: cov('a.py:7'),
        statementRuns: stmts({ 'a.py': [[7, 7, 7]], 'b.py': [[5, 5, 5]] }),
      });
      expect(out.changedLinesCovered).toBe(false);
      expect(out.inertOnlyFiles).toEqual(['a.py']);
      expect(out.uncovered).toEqual([{ file: 'b.py', line: 5 }]);
    });

    // The predecessor walked BACKWARDS with no bound: changed lines 40..42 with a
    // single statement at 10 returned covered=true, i.e. line 10 attested three
    // lines thirty lines below the end of the file's last statement. Containment
    // makes that unrepresentable; this pins it so nobody flips it back.
    it('lines BELOW the last statement are inert, never attested by it', () => {
      const out = attributeChangedLines({
        ranges: ranges({ path: 'mod.py', lines: [40, 41, 42] }),
        coveredLines: cov('mod.py:10'),
        statementRuns: stmts({ 'mod.py': [[10, 10, 10]] }),
      });
      expect(out.changedLinesCovered).toBe(false);
      expect(out.uncovered).toEqual([]);
      expect(out.inertOnlyFiles).toEqual(['mod.py']);
    });

    // The direct analogue of the old "a measured file with an EMPTY executable
    // set never reads as covered": a file the sidecar analyzed successfully but
    // which holds no statements at all (comments only). Every changed line in it
    // is inert, and the file still cannot read as covered.
    it('a file with an EMPTY statement map never reads as covered', () => {
      const out = attributeChangedLines({
        ranges: ranges({ path: 'pkg/mod.py', lines: [3, 4] }),
        coveredLines: cov(),
        statementRuns: stmts({ 'pkg/mod.py': [] }),
      });
      expect(out.changedLinesCovered).toBe(false);
      expect(out.inertOnlyFiles).toEqual(['pkg/mod.py']);
    });

    it('lines ABOVE the first statement are inert too (leading comments)', () => {
      const out = attributeChangedLines({
        ranges: ranges({ path: 'mod.py', lines: [1, 2] }),
        coveredLines: cov('mod.py:10'),
        statementRuns: stmts({ 'mod.py': [[10, 10, 10]] }),
      });
      expect(out.changedLinesCovered).toBe(false);
      expect(out.inertOnlyFiles).toEqual(['mod.py']);
    });
  });

  describe('cannot attribute', () => {
    // A CODE line inside no statement should be unreachable, so the sidecar marks
    // it rather than guessing. It must read as never-exercised and be reported at
    // its own physical line: silently dropping it is the false-SAFE path.
    it('a code line inside no statement is reported at its own line, never exercised', () => {
      const out = attributeChangedLines({
        ranges: ranges({ path: 'mod.py', lines: [3] }),
        coveredLines: cov('mod.py:1'),
        statementRuns: stmts({
          'mod.py': [
            [1, 1, 1],
            [3, 3, UNATTRIBUTABLE_OWNER],
          ],
        }),
      });
      expect(out.changedLinesCovered).toBe(false);
      expect(out.uncovered).toEqual([{ file: 'mod.py', line: 3 }]);
      expect(out.changedStatements).toEqual({ total: 1, covered: 0 });
    });

    // Defence in depth: verify-diff bails the whole assessment to UNKNOWN when
    // the sidecar could not analyze a changed file, so this map should never be
    // missing an entry. If it ever is, err strict rather than inert.
    it('a file absent from the statement map never reads as covered', () => {
      const out = attributeChangedLines({
        ranges: ranges({ path: 'pkg/mod.py', lines: [3] }),
        coveredLines: cov('pkg/mod.py:3'),
        statementRuns: stmts({}),
      });
      expect(out.changedLinesCovered).toBe(false);
      expect(out.uncovered).toEqual([{ file: 'pkg/mod.py', line: 3 }]);
    });
  });

  // Removal-only: no added lines at all. Unchanged: not covered (there is
  // nothing to attest) and contributing NO uncovered entries, so verdict-fuse can
  // still recognise the shape. Distinct from inert-only, which HAS added lines.
  it('a removal-only range contributes no uncovered entries and cannot be covered', () => {
    const out = attributeChangedLines({
      ranges: ranges({ path: 'pkg/mod.py', lines: [] }),
      coveredLines: cov('pkg/mod.py:1'),
      statementRuns: stmts({ 'pkg/mod.py': [[1, 1, 1]] }),
    });
    expect(out.changedLinesCovered).toBe(false);
    expect(out.uncovered).toEqual([]);
    expect(out.inertOnlyFiles).toEqual([]);
  });

  it('mixed removal-only + uncovered keeps both signals', () => {
    const out = attributeChangedLines({
      ranges: ranges({ path: 'a.py', lines: [] }, { path: 'b.py', lines: [3] }),
      coveredLines: cov(),
      statementRuns: stmts({ 'a.py': [[1, 1, 1]], 'b.py': [[3, 3, 3]] }),
    });
    expect(out.changedLinesCovered).toBe(false);
    expect(out.uncovered).toEqual([{ file: 'b.py', line: 3 }]);
  });

  describe('paths', () => {
    it('normalizes `./` so map and coverage lookups hit', () => {
      const out = attributeChangedLines({
        ranges: ranges({ path: './pkg/mod.py', lines: [11] }),
        coveredLines: cov('pkg/mod.py:10'),
        statementRuns: stmts({ 'pkg/mod.py': [[10, 11, 10]] }),
      });
      expect(out.changedLinesCovered).toBe(true);
      expect(out.uncovered).toEqual([]);
    });

    // The other half of the same behavior: normalization is for LOOKUP only, and
    // what gets reported back is the caller's own spelling of the path.
    it('reports the caller path verbatim in uncovered entries', () => {
      const out = attributeChangedLines({
        ranges: ranges({ path: './pkg/mod.py', lines: [11] }),
        coveredLines: cov(),
        statementRuns: stmts({ 'pkg/mod.py': [[10, 11, 10]] }),
      });
      expect(out.uncovered).toEqual([{ file: './pkg/mod.py', line: 10 }]);
    });
  });

  describe('uncovered cap', () => {
    it('truncates with an explicit signal rather than silently dropping', () => {
      const lines = Array.from({ length: UNCOVERED_CAP + 25 }, (_, i) => (i + 1) * 2);
      const out = attributeChangedLines({
        ranges: ranges({ path: 'a.py', lines }),
        coveredLines: cov(),
        statementRuns: stmts({ 'a.py': lines.map((l) => [l, l, l] as [number, number, number]) }),
      });
      expect(out.uncovered).toHaveLength(UNCOVERED_CAP);
      expect(out.uncoveredTruncated).toEqual({ shown: UNCOVERED_CAP, total: UNCOVERED_CAP + 25 });
      expect(out.changedStatements).toEqual({ total: UNCOVERED_CAP + 25, covered: 0 });
    });

    it('leaves the signal absent when nothing was dropped', () => {
      const out = attributeChangedLines({
        ranges: ranges({ path: 'a.py', lines: [1] }),
        coveredLines: cov(),
        statementRuns: stmts({ 'a.py': [[1, 1, 1]] }),
      });
      expect(out.uncoveredTruncated).toBeUndefined();
    });

    it('emits no truncation signal when the total lands EXACTLY on the cap', () => {
      const lines = Array.from({ length: UNCOVERED_CAP }, (_, i) => (i + 1) * 2);
      const out = attributeChangedLines({
        ranges: ranges({ path: 'a.py', lines }),
        coveredLines: cov(),
        statementRuns: stmts({ 'a.py': lines.map((l) => [l, l, l] as [number, number, number]) }),
      });
      expect(out.uncovered).toHaveLength(UNCOVERED_CAP);
      expect(out.uncoveredTruncated).toBeUndefined();
    });

    it('honours an explicit cap override', () => {
      const out = attributeChangedLines({
        ranges: ranges({ path: 'a.py', lines: [1, 3, 5] }),
        coveredLines: cov(),
        statementRuns: stmts({
          'a.py': [
            [1, 1, 1],
            [3, 3, 3],
            [5, 5, 5],
          ],
        }),
        uncoveredCap: 2,
      });
      expect(out.uncovered).toEqual([
        { file: 'a.py', line: 1 },
        { file: 'a.py', line: 3 },
      ]);
      expect(out.uncoveredTruncated).toEqual({ shown: 2, total: 3 });
    });

    // A flat cap in diff order lets ONE pathological file consume every slot, so
    // later files vanish from the report entirely and `{shown,total}` discloses a
    // count without disclosing that whole files are missing. Every file gets a
    // guaranteed share first; leftovers fill the remaining slots afterwards.
    it('guarantees every file a share before any file takes a second helping', () => {
      const many = Array.from({ length: 60 }, (_, i) => i + 1);
      const out = attributeChangedLines({
        ranges: ranges(
          { path: 'hog.py', lines: many },
          { path: 'quiet.py', lines: [7] },
          { path: 'also-quiet.py', lines: [9] },
        ),
        coveredLines: cov(),
        statementRuns: stmts({
          'hog.py': many.map((l) => [l, l, l] as [number, number, number]),
          'quiet.py': [[7, 7, 7]],
          'also-quiet.py': [[9, 9, 9]],
        }),
        uncoveredCap: 10,
      });
      const files = out.uncovered.map((u) => u.file);
      expect(files).toContain('quiet.py');
      expect(files).toContain('also-quiet.py');
      expect(out.uncovered).toHaveLength(10);
      // Reported in diff order, not grouped by the fair-share pass.
      expect(out.uncovered[0]).toEqual({ file: 'hog.py', line: 1 });
      expect(out.uncoveredTruncated).toEqual({ shown: 10, total: 62 });
      // The count that says whole files were NOT dropped.
      expect(out.filesWithUncovered).toBe(3);
    });

    it('caps each file at the per-file share when there are more files than slots', () => {
      const perFile = PER_FILE_UNCOVERED_CAP + 4;
      const paths = Array.from({ length: 40 }, (_, i) => `f${i}.py`);
      const lines = Array.from({ length: perFile }, (_, i) => i + 1);
      const out = attributeChangedLines({
        ranges: paths.map((p) => ({ path: p, lines })),
        coveredLines: cov(),
        statementRuns: new Map(
          paths.map((p) => [p, lines.map((l) => ({ first: l, last: l, owner: l }))]),
        ),
      });
      expect(out.uncovered).toHaveLength(UNCOVERED_CAP);
      const perFileCounts = new Map<string, number>();
      for (const u of out.uncovered)
        perFileCounts.set(u.file, (perFileCounts.get(u.file) ?? 0) + 1);
      expect([...perFileCounts.values()].every((n) => n === PER_FILE_UNCOVERED_CAP)).toBe(true);
      expect(perFileCounts.size).toBe(40);
      expect(out.filesWithUncovered).toBe(40);
      expect(out.uncoveredTruncated).toEqual({ shown: UNCOVERED_CAP, total: 40 * perFile });
    });

    it('counts filesWithUncovered BEFORE any cap', () => {
      const paths = Array.from({ length: 300 }, (_, i) => `f${i}.py`);
      const out = attributeChangedLines({
        ranges: paths.map((p) => ({ path: p, lines: [1] })),
        coveredLines: cov(),
        statementRuns: new Map(paths.map((p) => [p, [{ first: 1, last: 1, owner: 1 }]])),
      });
      expect(out.uncovered).toHaveLength(UNCOVERED_CAP);
      expect(out.filesWithUncovered).toBe(300);
      expect(out.uncoveredTruncated).toEqual({ shown: UNCOVERED_CAP, total: 300 });
    });
  });

  // ADR-14 / #117. A changed conditional whose header executed but one of whose
  // arcs was never taken must NOT read as covered, even though its statement ran.
  describe('branch coverage (ADR-14)', () => {
    it('a changed line reported as a partial branch is NOT proven, though its statement ran', () => {
      const out = attributeChangedLines({
        // Line 3 is the `if`; its statement executed (it is in coveredLines) but
        // coverage.py reports it as a partial branch (one arc untaken).
        ranges: ranges({ path: 'mod.py', lines: [3] }),
        coveredLines: cov('mod.py:3'),
        statementRuns: stmts({ 'mod.py': [[3, 3, 3]] }),
        partialBranchLines: new Set(['mod.py:3']),
      });
      expect(out.changedLinesCovered).toBe(false);
      expect(out.partialBranches).toEqual([{ file: 'mod.py', line: 3 }]);
    });

    it('does NOT flip a changed conditional whose branches were all taken', () => {
      // Same input, but no partial branch: the file stays proven. This is what
      // keeps the rule from over-blocking fully-tested conditionals.
      const out = attributeChangedLines({
        ranges: ranges({ path: 'mod.py', lines: [3] }),
        coveredLines: cov('mod.py:3'),
        statementRuns: stmts({ 'mod.py': [[3, 3, 3]] }),
        partialBranchLines: new Set(), // measured, none partial
      });
      expect(out.changedLinesCovered).toBe(true);
      expect(out.partialBranches).toBeUndefined();
    });

    it('falls back to the statement rule when no branch data is supplied', () => {
      // The fail-safe boundary: omitting partialBranchLines (older coverage.py,
      // a run without --branch) must behave exactly as before ADR-14 — the
      // statement rule alone decides, and nothing crashes. Absent data does not
      // grant SAFE, and is not read as "no partial branches".
      const out = attributeChangedLines({
        ranges: ranges({ path: 'mod.py', lines: [3] }),
        coveredLines: cov('mod.py:3'),
        statementRuns: stmts({ 'mod.py': [[3, 3, 3]] }),
      });
      expect(out.changedLinesCovered).toBe(true);
      expect(out.partialBranches).toBeUndefined();
    });

    it('a partial branch on a covered line in an OTHERWISE-proven multi-file diff floors the whole change', () => {
      // Cross-file: one file fully proven, one with a branch gap. The change is
      // not covered — the branch gap disqualifies it, matching ADR-11's all-files
      // conjunction.
      const out = attributeChangedLines({
        ranges: ranges({ path: 'a.py', lines: [1] }, { path: 'b.py', lines: [5] }),
        coveredLines: cov('a.py:1', 'b.py:5'),
        statementRuns: stmts({ 'a.py': [[1, 1, 1]], 'b.py': [[5, 5, 5]] }),
        partialBranchLines: new Set(['b.py:5']),
      });
      expect(out.changedLinesCovered).toBe(false);
      expect(out.partialBranches).toEqual([{ file: 'b.py', line: 5 }]);
    });

    it('catches a partial branch when only the continuation line of the conditional changed', () => {
      // coverage.py reports the arc at the statement START (owner), not the
      // continuation line the diff touched. Verified on coverage 7.11:
      //   if (a and     # line 3  <- arc source / owner
      //           b):   # line 4  <- the only changed line
      // Only the `${rel}:${owner}` lookup matches, so deleting that clause
      // re-opens a false SAFE for this shape.
      const out = attributeChangedLines({
        ranges: ranges({ path: 'mod.py', lines: [4] }),
        coveredLines: cov('mod.py:3'),
        statementRuns: stmts({ 'mod.py': [[3, 4, 3]] }),
        partialBranchLines: new Set(['mod.py:3']),
      });
      expect(out.changedLinesCovered).toBe(false);
      expect(out.partialBranches).toEqual([{ file: 'mod.py', line: 3 }]);
    });

    it('ignores a negative arc destination and attributes to the positive source', () => {
      // A function-exit false branch emits a negative DEST arc, e.g. [7, -6].
      // Only the source (7) is keyed, so the negative number never forms a key.
      const out = attributeChangedLines({
        ranges: ranges({ path: 'mod.py', lines: [7] }),
        coveredLines: cov('mod.py:7'),
        statementRuns: stmts({ 'mod.py': [[7, 7, 7]] }),
        partialBranchLines: new Set(['mod.py:7']),
      });
      expect(out.changedLinesCovered).toBe(false);
      expect(out.partialBranches).toEqual([{ file: 'mod.py', line: 7 }]);
    });
  });
});
