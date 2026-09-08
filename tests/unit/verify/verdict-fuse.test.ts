import { describe, it, expect } from 'vitest';
import {
  fuseVerdict,
  MISSING_TESTS_CAP,
  type CoverageAssessment,
} from '../../../src/verify/verdict-fuse.js';
import type { VerificationResult } from '../../../src/contracts.js';
import type { TestScopeAssessment } from '../../../src/verify/test-scope.js';
import type { MutationResult } from '../../../src/verify/mutation.js';
import type { WeakenedTest } from '../../../src/verify/test-weakening.js';
import type { StabilityResult } from '../../../src/verify/stability.js';

const ok = { passed: true, durationMs: 1 };
function result(passed: boolean, testsReason?: string): VerificationResult {
  return {
    passed,
    gates: {
      syntax: ok,
      imports: ok,
      tests: passed
        ? ok
        : { passed: false, durationMs: 1, blockingReason: testsReason ?? 'tests failed' },
    },
    writableChanges: [],
  };
}
const covered: CoverageAssessment = {
  tool: 'coverage.py',
  changedLinesCovered: true,
  uncovered: [],
};
const uncovered: CoverageAssessment = {
  tool: 'coverage.py',
  changedLinesCovered: false,
  uncovered: [{ file: 'a.py', line: 5 }],
};
const unknown: CoverageAssessment = { tool: 'none', changedLinesCovered: 'unknown', uncovered: [] };

// fuseVerdict's 4th argument is REQUIRED on purpose: a forgotten optional scope
// would be a silent false SAFE. This wrapper supplies the whole-suite default so
// the pre-existing cases below read as before, and passing it explicitly is
// itself the AC-7 evidence that a `full` scope changes nothing.
const FULL_SCOPE: TestScopeAssessment = { scope: 'full', source: 'detected', signals: [] };
// `trusted` defaults to true here so the pre-existing fusion-logic cases below —
// which test the coverage/scope/mutation/stability rules, not the trust gate —
// keep their SAFE semantics. The trust gate (ADR-19) has its own describe block,
// which passes `trusted: false` explicitly. It is the LAST param so the existing
// positional mutation/stability calls are undisturbed.
function fuse(
  result: VerificationResult,
  changedFiles: string[],
  cov: CoverageAssessment,
  scope: TestScopeAssessment = FULL_SCOPE,
  mutation?: MutationResult,
  stability?: StabilityResult,
  trusted: boolean = true,
  testWeakening: WeakenedTest[] = [],
) {
  return fuseVerdict(result, changedFiles, cov, scope, trusted, testWeakening, mutation, stability);
}

describe('fuseVerdict', () => {
  it('a failing gate → UNSAFE, surfacing the blocking reason', () => {
    const r = fuse(result(false, 'test_x broke'), ['a.py'], unknown);
    expect(r.verdict).toBe('UNSAFE');
    expect(r.reason).toContain('test_x broke');
  });
  it('tests pass + changed lines covered → SAFE', () => {
    expect(fuse(result(true), ['a.py'], covered).verdict).toBe('SAFE');
  });

  // The trust gate (ADR-19, GHSA Finding 1). In-process coverage/pass-fail is
  // forgeable by the diff's own suite, so a would-be-SAFE is withheld unless the
  // author is trusted.
  describe('trust gate', () => {
    const untrusted = false;
    it('untrusted would-be-SAFE floors to UNPROVEN, not SAFE', () => {
      const r = fuse(result(true), ['a.py'], covered, FULL_SCOPE, undefined, undefined, untrusted);
      expect(r.verdict).toBe('UNPROVEN');
      expect(r.reason).toContain('SAFE is withheld');
    });
    it('the same evidence with a trusted author is SAFE', () => {
      const r = fuse(result(true), ['a.py'], covered, FULL_SCOPE, undefined, undefined, true);
      expect(r.verdict).toBe('SAFE');
    });
    it('trustMode is stamped on every verdict', () => {
      expect(fuse(result(true), ['a.py'], covered).trustMode).toBe('trusted');
      expect(
        fuse(result(true), ['a.py'], covered, FULL_SCOPE, undefined, undefined, untrusted)
          .trustMode,
      ).toBe('untrusted');
      // A failing gate is UNSAFE regardless of trust: a real problem the attacker
      // would not forge against themselves. The gate only withholds SAFE.
      const unsafe = fuse(
        result(false, 'x'),
        ['a.py'],
        covered,
        FULL_SCOPE,
        undefined,
        undefined,
        untrusted,
      );
      expect(unsafe.verdict).toBe('UNSAFE');
      expect(unsafe.trustMode).toBe('untrusted');
    });
    it('does not disturb a non-SAFE verdict: uncovered stays UNPROVEN with its real reason', () => {
      const r = fuse(
        result(true),
        ['a.py'],
        uncovered,
        FULL_SCOPE,
        undefined,
        undefined,
        untrusted,
      );
      expect(r.verdict).toBe('UNPROVEN');
      // The real coverage-gap reason, NOT the trust-withheld reason.
      expect(r.reason).not.toContain('SAFE is withheld');
      expect(r.missingTests?.[0]?.file).toBe('a.py');
    });
  });

  // Self-weakening test downgrade (#163): a would-be-SAFE whose diff relaxed the
  // tests that judge it is withheld, even for a trusted author.
  describe('self-weakening test downgrade', () => {
    const weakened = [{ file: 'tests/test_x.py', reasons: ['1 assertion(s) removed'] }];
    it('a trusted would-be-SAFE whose diff weakened its tests floors to UNPROVEN', () => {
      const r = fuse(
        result(true),
        ['a.py'],
        covered,
        FULL_SCOPE,
        undefined,
        undefined,
        true,
        weakened,
      );
      expect(r.verdict).toBe('UNPROVEN');
      expect(r.reason).toContain('weakened the tests');
      expect(r.testWeakening?.[0]?.file).toBe('tests/test_x.py');
    });
    it('the same evidence with no weakening stays SAFE', () => {
      const r = fuse(result(true), ['a.py'], covered, FULL_SCOPE, undefined, undefined, true, []);
      expect(r.verdict).toBe('SAFE');
      expect(r.testWeakening).toBeUndefined();
    });
  });

  it('tests pass + changed lines uncovered → UNPROVEN with missingTests', () => {
    const r = fuse(result(true), ['a.py'], uncovered);
    expect(r.verdict).toBe('UNPROVEN');
    expect(r.missingTests?.[0]?.file).toBe('a.py');
  });
  it('tests pass + coverage unknown → UNPROVEN, never SAFE (fail-safe)', () => {
    expect(fuse(result(true), ['a.ts'], unknown).verdict).toBe('UNPROVEN');
  });
  it('no test runner detected → UNPROVEN, not UNSAFE (honest: nothing proven)', () => {
    const r = fuse(
      result(false, 'no test runner detected (pytest, vitest, jest); pass testCmd to override'),
      ['a.py'],
      unknown,
    );
    expect(r.verdict).toBe('UNPROVEN');
  });
  it('pre-existing baseline failure → UNPROVEN, not the diff breaking things', () => {
    const r = fuse(
      result(false, 'baseline tests already fail before refactoring; fix them first.'),
      ['a.py'],
      unknown,
    );
    expect(r.verdict).toBe('UNPROVEN');
  });
  it('tests fail after refactoring for a normal reason → still UNSAFE (remap not over-broad)', () => {
    const r = fuse(result(false, 'tests fail after refactoring: test_x broke'), ['a.py'], unknown);
    expect(r.verdict).toBe('UNSAFE');
  });
});

describe('fuseVerdict flakyTests surface', () => {
  // The tests gate carries flakySuspects on the SAME object stored in
  // gates.tests (a verify-land extension, not a contract change). fuseVerdict
  // must lift it onto the report as flakyTests, without changing the verdict.
  function passingWithFlaky(flaky: string[]): VerificationResult {
    return {
      passed: true,
      gates: { syntax: ok, imports: ok, tests: { ...ok, flakySuspects: flaky } },
      writableChanges: [],
    } as VerificationResult;
  }

  it('covered + flaky → UNPROVEN (SAFE disqualified), flaky reason, suspects surfaced', () => {
    // C1: a flaky heal is never a clean stable green. Even with the changed
    // lines covered — the only path that could otherwise reach SAFE — a test
    // that flipped on retry floors the verdict at UNPROVEN. Zero-false-SAFE.
    const r = fuse(passingWithFlaky(['test_flaky.py::test_flaky']), ['a.py'], covered);
    expect(r.verdict).toBe('UNPROVEN');
    expect(r.reason).toBe(
      'Tests pass, but 1 test(s) flipped on retry (flaky); a stable green could not be established.',
    );
    expect(r.flakyTests).toEqual(['test_flaky.py::test_flaky']);
  });

  it('covered + multiple flaky → count reflected in the flaky reason', () => {
    const r = fuse(passingWithFlaky(['a::x', 'b::y']), ['a.py'], covered);
    expect(r.verdict).toBe('UNPROVEN');
    expect(r.reason).toBe(
      'Tests pass, but 2 test(s) flipped on retry (flaky); a stable green could not be established.',
    );
  });

  it('unknown coverage + flaky → UNPROVEN, keeps the coverage reason, still carries flaky', () => {
    // Coverage already forces UNPROVEN, so the coverage reason wins the tie; the
    // flaky reason only pre-empts a would-be SAFE. Suspects still surface.
    const r = fuse(passingWithFlaky(['test_flaky.py::test_flaky']), ['a.ts'], unknown);
    expect(r.verdict).toBe('UNPROVEN');
    expect(r.reason).toMatch(/coverage of the changed code could not be determined/);
    expect(r.reason).not.toMatch(/flipped on retry/);
    expect(r.flakyTests).toEqual(['test_flaky.py::test_flaky']);
  });

  it('uncovered + flaky → UNPROVEN, keeps the coverage reason + missingTests, carries flaky', () => {
    const r = fuse(passingWithFlaky(['test_flaky.py::test_flaky']), ['a.py'], uncovered);
    expect(r.verdict).toBe('UNPROVEN');
    expect(r.reason).toMatch(/not exercised/);
    expect(r.reason).not.toMatch(/flipped on retry/);
    expect(r.missingTests?.[0]?.file).toBe('a.py');
    expect(r.flakyTests).toEqual(['test_flaky.py::test_flaky']);
  });

  it('omits flakyTests when the tests gate reports none', () => {
    const r = fuse(result(true), ['a.py'], covered);
    expect(r.flakyTests).toBeUndefined();
  });
});

describe('fuseVerdict — testFilesChanged note', () => {
  // A diff that weakens tests can otherwise ride a green verdict. We surface the
  // changed test files as a note (not a verdict change) so a reviewer sees it.
  it('flags changed files matching test conventions across languages', () => {
    const changed = [
      'src/attr/_make.py',
      'tests/test_make.py',
      'foo.spec.ts',
      'pkg/bar_test.py',
      'conftest.py',
      'ui/widget.test.ts',
    ];
    const r = fuse(result(true), changed, covered);
    expect(r.testFilesChanged).toEqual([
      'tests/test_make.py',
      'foo.spec.ts',
      'pkg/bar_test.py',
      'conftest.py',
      'ui/widget.test.ts',
    ]);
  });

  it('is empty when no changed file looks like a test', () => {
    const r = fuse(result(true), ['src/attr/_make.py', 'src/attr/_config.py'], covered);
    expect(r.testFilesChanged).toEqual([]);
  });

  it('removal-only change → UNPROVEN with a removal-specific reason, no missingTests', () => {
    // A diff that only deletes lines has no added lines for coverage to attest.
    // The old output was a bare "not exercised by any test" with an empty
    // uncovered list, which reads as a coverage miss rather than what it is.
    const removalOnly: CoverageAssessment = {
      tool: 'coverage.py',
      changedLinesCovered: false,
      uncovered: [],
      removalOnlyFiles: ['src/click/globals.py'],
    };
    const r = fuse(result(true), ['src/click/globals.py'], removalOnly);
    expect(r.verdict).toBe('UNPROVEN');
    expect(r.reason).toMatch(/only removes code/);
    expect(r.reason).not.toMatch(/not exercised/);
    expect(r.missingTests).toBeUndefined();
    expect(r.coverage.removalOnlyFiles).toEqual(['src/click/globals.py']);
  });

  it('mixed removal-only + uncovered additions keeps the coverage reason', () => {
    const mixed: CoverageAssessment = {
      tool: 'coverage.py',
      changedLinesCovered: false,
      uncovered: [{ file: 'b.py', line: 3 }],
      removalOnlyFiles: ['a.py'],
    };
    const r = fuse(result(true), ['a.py', 'b.py'], mixed);
    expect(r.verdict).toBe('UNPROVEN');
    expect(r.reason).toMatch(/not exercised/);
    expect(r.missingTests).toEqual([{ file: 'b.py', hint: 'add a test exercising b.py:3' }]);
  });

  // The removal-only reason used to fire on "some removal-only file exists AND
  // the uncovered list is empty". Both halves are now much easier to satisfy, so
  // a MIXED diff (one removal-only file plus a file whose additions are fully
  // covered) printed "the change only removes code", which is simply false.
  it('does NOT claim removal-only when another changed file has real additions', () => {
    const mixed: CoverageAssessment = {
      tool: 'coverage.py',
      changedLinesCovered: false,
      uncovered: [],
      removalOnlyFiles: ['a.py'],
      // b.py contributed an inert-free, exercised statement, so it is in neither
      // bucket; the verdict is UNPROVEN for some other reason entirely.
    };
    const r = fuse(result(true), ['a.py', 'b.py'], mixed);
    expect(r.reason).not.toMatch(/only removes code/);
    expect(r.reason).toMatch(/not exercised/);
  });

  // The zero-check must read the PRE-CAP total. `uncovered` is capped, so
  // asking `uncovered.length === 0` asks "did any survive the cap?" when the
  // question is "were there any at all?".
  it('reads the pre-cap uncovered total, not the capped array length', () => {
    const capped: CoverageAssessment = {
      tool: 'coverage.py',
      changedLinesCovered: false,
      uncovered: [],
      uncoveredTruncated: { shown: 0, total: 12 },
      removalOnlyFiles: ['a.py'],
    };
    const r = fuse(result(true), ['a.py'], capped);
    expect(r.reason).not.toMatch(/only removes code/);
  });

  it('inert-only change → UNPROVEN naming comments and blank lines, not a coverage miss', () => {
    const inert: CoverageAssessment = {
      tool: 'coverage.py',
      changedLinesCovered: false,
      uncovered: [],
      inertOnlyFiles: ['a.py'],
    };
    const r = fuse(result(true), ['a.py'], inert);
    expect(r.verdict).toBe('UNPROVEN');
    expect(r.reason).toMatch(/comments and blank lines/);
    expect(r.reason).not.toMatch(/not exercised/);
    expect(r.missingTests).toBeUndefined();
  });

  it('removal-only AND inert-only together get a reason naming both', () => {
    const both: CoverageAssessment = {
      tool: 'coverage.py',
      changedLinesCovered: false,
      uncovered: [],
      removalOnlyFiles: ['a.py'],
      inertOnlyFiles: ['b.py'],
    };
    const r = fuse(result(true), ['a.py', 'b.py'], both);
    expect(r.reason).toMatch(/only removes code and touches comments and blank lines/);
  });

  // A statement coverage.py EXCLUDED cannot be reached by any test, so "add a
  // test exercising gated.py:6" is an uncompletable instruction that makes the
  // tool look broken.
  it('an excluded statement gets a review hint, never an add-a-test hint', () => {
    const excluded: CoverageAssessment = {
      tool: 'coverage.py',
      changedLinesCovered: false,
      uncovered: [
        { file: 'gated.py', line: 6, excluded: true },
        { file: 'plain.py', line: 9 },
      ],
    };
    const r = fuse(result(true), ['gated.py', 'plain.py'], excluded);
    expect(r.missingTests?.[0]?.hint).toContain('excluded from coverage');
    expect(r.missingTests?.[0]?.hint).not.toContain('add a test');
    expect(r.missingTests?.[1]?.hint).toBe('add a test exercising plain.py:9');
  });

  // The report is serialized verbatim by the MCP tool and by `--json`, so its
  // shape is a public contract the moment it ships.
  it('stamps reportVersion on every verdict', () => {
    expect(fuse(result(true), ['a.py'], covered).reportVersion).toBe(1);
    expect(fuse(result(true), ['a.py'], uncovered).reportVersion).toBe(1);
    expect(fuse(result(false, 'boom'), ['a.py'], unknown).reportVersion).toBe(1);
  });

  // Disclosure is not a verdict input. A SAFE change can still hold statements
  // no test ran, because SAFE clears on one exercised statement per changed file.
  it('carries uncovered and changedStatements through a SAFE verdict', () => {
    const partial: CoverageAssessment = {
      tool: 'coverage.py',
      changedLinesCovered: true,
      uncovered: [{ file: 'a.py', line: 30 }],
      changedStatements: { total: 2, covered: 1 },
    };
    const r = fuse(result(true), ['a.py'], partial);
    expect(r.verdict).toBe('SAFE');
    expect(r.coverage.uncovered).toEqual([{ file: 'a.py', line: 30 }]);
    expect(r.coverage.changedStatements).toEqual({ total: 2, covered: 1 });
    // Hints belong to the UNPROVEN path; SAFE discloses without instructing.
    expect(r.missingTests).toBeUndefined();
  });

  describe('missingTests cap', () => {
    // A 396-hunk reformat produced 3666 hints and an 883 KB JSON report. Nobody
    // reads 3666 hints, and no agent should have to stream them. Cap the list,
    // but say so in the data: a silently short list is a lie about the count.
    function uncoveredAt(n: number): CoverageAssessment {
      return {
        tool: 'coverage.py',
        changedLinesCovered: false,
        uncovered: Array.from({ length: n }, (_, i) => ({ file: 'a.py', line: i + 1 })),
      };
    }

    it('caps missingTests and reports the truncation explicitly', () => {
      const r = fuse(result(true), ['a.py'], uncoveredAt(MISSING_TESTS_CAP + 7));
      expect(r.missingTests).toHaveLength(MISSING_TESTS_CAP);
      expect(r.missingTestsTruncated).toEqual({
        shown: MISSING_TESTS_CAP,
        total: MISSING_TESTS_CAP + 7,
      });
    });

    it('omits the truncation signal when nothing was dropped', () => {
      const r = fuse(result(true), ['a.py'], uncoveredAt(3));
      expect(r.missingTests).toHaveLength(3);
      expect(r.missingTestsTruncated).toBeUndefined();
    });

    // When `coverage.uncovered` was ITSELF capped upstream, the hint total must
    // report the real number of uncovered statements, not the capped array
    // length: otherwise the truncation notice under-counts the shortfall.
    it('reports the pre-truncation total when uncovered was already capped', () => {
      const cov: CoverageAssessment = {
        ...uncoveredAt(MISSING_TESTS_CAP + 7),
        uncoveredTruncated: { shown: MISSING_TESTS_CAP + 7, total: 4231 },
      };
      const r = fuse(result(true), ['a.py'], cov);
      expect(r.missingTests).toHaveLength(MISSING_TESTS_CAP);
      expect(r.missingTestsTruncated).toEqual({ shown: MISSING_TESTS_CAP, total: 4231 });
    });
  });

  it('flags tsx, js, and cjs/mjs test variants too', () => {
    const changed = ['ui/panel.test.tsx', 'lib/util.spec.js', 'lib/util.test.mjs', 'ui/panel.tsx'];
    const r = fuse(result(true), changed, covered);
    expect(r.testFilesChanged).toEqual([
      'ui/panel.test.tsx',
      'lib/util.spec.js',
      'lib/util.test.mjs',
    ]);
  });
});

// Issue #110 / ADR-12. A caller-supplied `testCmd` that names a subset of the
// suite scoped the whole verification run. Reproduced: the same diff returns
// UNSAFE under `python3 -m pytest -q` and SAFE under
// `python3 -m pytest -q tests/test_scale.py`. A narrowed scope must therefore
// disqualify SAFE, exactly as a flaky heal does.
describe('fuseVerdict test scope', () => {
  const full: TestScopeAssessment = { scope: 'full', source: 'detected', signals: [] };
  const narrowed: TestScopeAssessment = {
    scope: 'narrowed',
    source: 'override',
    signals: ['selects specific paths: tests/test_scale.py'],
  };
  const unknownScope: TestScopeAssessment = { scope: 'unknown', source: 'override', signals: [] };

  it('narrowed scope + fully covered → UNPROVEN, never SAFE', () => {
    const r = fuse(result(true), ['a.py'], covered, narrowed);
    expect(r.verdict).toBe('UNPROVEN');
  });

  it('the narrowed reason names the signal, not a generic coverage miss', () => {
    const r = fuse(result(true), ['a.py'], covered, narrowed);
    // "the changed code is not exercised by any test" would be false here: it
    // WAS exercised, by a subset the caller chose.
    expect(r.reason).not.toContain('not exercised by any test');
    expect(r.reason).toContain('tests/test_scale.py');
    // Pins the EXPLANATION, not just the echoed signal. Without this, rewriting
    // the reason to bare signals still passes.
    expect(r.reason).toContain('the test command narrowed the suite');
  });

  it('full scope + fully covered → still SAFE', () => {
    expect(fuse(result(true), ['a.py'], covered, full).verdict).toBe('SAFE');
  });

  it('unknown scope does not floor: it would make SAFE unreachable for `make test`', () => {
    expect(fuse(result(true), ['a.py'], covered, unknownScope).verdict).toBe('SAFE');
  });

  it('a narrowed scope cannot rescue a failing gate from UNSAFE', () => {
    // Flooring must only ever LOWER a verdict. UNSAFE stays UNSAFE, and keeps
    // its own blocking reason rather than being retold as a scoping problem.
    const r = fuse(result(false, 'test_x broke'), ['a.py'], covered, narrowed);
    expect(r.verdict).toBe('UNSAFE');
    expect(r.reason).toContain('test_x broke');
  });

  it('when coverage already forces UNPROVEN, the coverage reason stands', () => {
    const r = fuse(result(true), ['a.py'], uncovered, narrowed);
    expect(r.verdict).toBe('UNPROVEN');
    expect(r.reason).toContain('not exercised by any test');
    // The hints survive: a narrowed scope must not swallow the missing-test list.
    expect(r.missingTests?.[0]?.file).toBe('a.py');
  });

  it('the scope is disclosed on the report in every branch', () => {
    expect(fuse(result(true), ['a.py'], covered, full).testScope).toEqual(full);
    expect(fuse(result(true), ['a.py'], covered, narrowed).testScope).toEqual(narrowed);
    expect(fuse(result(false), ['a.py'], covered, narrowed).testScope).toEqual(narrowed);
    expect(fuse(result(true), ['a.py'], uncovered, narrowed).testScope).toEqual(narrowed);
    // `unknown` matters most here: it does NOT floor, so a SAFE produced under
    // it is only auditable if the scope survives onto the report.
    expect(fuse(result(true), ['a.py'], covered, unknownScope).testScope).toEqual(unknownScope);
  });

  // AC-7. The claim is that a non-narrowed scope changes NOTHING, and it has to
  // hold across every reason branch, not just the SAFE one. `unknown` is in here
  // because it does not floor: if it ever silently did, this table catches it.
  describe('AC-7: a non-narrowed scope leaves verdict and reason byte-identical', () => {
    const unknownScope: TestScopeAssessment = {
      scope: 'unknown',
      source: 'override',
      signals: ['make is not a recognised test runner, so the scope is unknown'],
    };
    const removalOnly: CoverageAssessment = {
      tool: 'coverage.py',
      changedLinesCovered: false,
      uncovered: [],
      removalOnlyFiles: ['a.py'],
    };
    const BRANCHES: Array<[string, VerificationResult, CoverageAssessment]> = [
      ['SAFE', result(true), covered],
      ['UNSAFE', result(false, 'tests fail after refactoring: test_x broke'), unknown],
      ['UNPROVEN/uncovered', result(true), uncovered],
      ['UNPROVEN/unknown-coverage', result(true), unknown],
      ['UNPROVEN/removal-only', result(true), removalOnly],
    ];

    for (const [label, res, cov] of BRANCHES) {
      it(`${label} is identical under full and unknown scope`, () => {
        const withFull = fuse(res, ['a.py'], cov, FULL_SCOPE);
        const withUnknown = fuse(res, ['a.py'], cov, unknownScope);
        expect(withUnknown.verdict).toBe(withFull.verdict);
        expect(withUnknown.reason).toBe(withFull.reason);
      });
    }

    it('SAFE remains reachable under an unknown scope, by ADR-12 decision', () => {
      expect(fuse(result(true), ['a.py'], covered, unknownScope).verdict).toBe('SAFE');
    });
  });

  // A run where no suite executed must not be recorded as `full`: the report is
  // stored as fleet history, where "full" reads as evidence a whole suite ran.
  it('a no-runner UNPROVEN downgrades the recorded scope to unknown', () => {
    const r = fuse(
      result(false, 'no test runner detected (pytest, vitest, jest); pass testCmd to override'),
      ['a.py'],
      unknown,
      FULL_SCOPE,
    );
    expect(r.verdict).toBe('UNPROVEN');
    expect(r.testScope?.scope).toBe('unknown');
  });

  // ADR-14 / #117. A changed conditional with an untaken branch floors the
  // verdict, and the reason must name the branch rather than read as a generic
  // coverage miss — statement coverage WAS complete, so "N of N exercised" would
  // mislead.
  describe('branch coverage (ADR-14)', () => {
    const branchGap: CoverageAssessment = {
      tool: 'coverage.py',
      changedLinesCovered: false,
      uncovered: [],
      changedStatements: { total: 1, covered: 1 }, // statement coverage complete
      partialBranches: [{ file: 'calc.py', line: 3 }],
    };

    it('floors to UNPROVEN and names the branch, not a statement ratio', () => {
      const r = fuse(result(true), ['calc.py'], branchGap);
      expect(r.verdict).toBe('UNPROVEN');
      expect(r.reason.toLowerCase()).toContain('branch');
      expect(r.reason).toContain('calc.py:3');
      // Must NOT fall through to the misleading "1 of 1 changed statements" line.
      expect(r.reason).not.toMatch(/1 of 1/);
    });

    it('does not fabricate a branch reason when there are no partial branches', () => {
      const r = fuse(result(true), ['a.py'], uncovered);
      expect(r.verdict).toBe('UNPROVEN');
      expect(r.reason.toLowerCase()).not.toContain('branch');
    });

    it('names the plural form for multiple branch gaps', () => {
      const many: CoverageAssessment = {
        tool: 'coverage.py',
        changedLinesCovered: false,
        uncovered: [],
        changedStatements: { total: 2, covered: 2 },
        partialBranches: [
          { file: 'a.py', line: 3 },
          { file: 'b.py', line: 9 },
        ],
      };
      const r = fuse(result(true), ['a.py', 'b.py'], many);
      expect(r.verdict).toBe('UNPROVEN');
      expect(r.reason).toContain('2 changed conditionals');
    });

    it('the SAFE gate itself blocks on a branch gap, not only via changedLinesCovered', () => {
      // Defense in depth: an inconsistent assessment (statement rule says covered,
      // but a branch gap is present) must still not reach SAFE. Guards against a
      // future producer that sets partialBranches without flooring allFilesProven.
      const inconsistent: CoverageAssessment = {
        tool: 'coverage.py',
        changedLinesCovered: true,
        uncovered: [],
        partialBranches: [{ file: 'calc.py', line: 3 }],
      };
      expect(fuse(result(true), ['calc.py'], inconsistent).verdict).not.toBe('SAFE');
    });
  });

  // ADR-15 / #116. A surviving mutant means coverage was complete (mutation runs
  // only then), so the verdict floors to UNPROVEN with a mutation reason.
  describe('mutation (ADR-15)', () => {
    // Mutation is now a sibling assessment, passed as fuseVerdict's 5th arg.
    const complete: CoverageAssessment = {
      tool: 'coverage.py',
      changedLinesCovered: true,
      uncovered: [],
      changedStatements: { total: 1, covered: 1 },
    };
    const withSurvivors = (
      survivors: Array<{ file: string; line: number; operator: string; mutatedTo: string }>,
    ): MutationResult => ({
      ran: true,
      tested: survivors.length,
      killed: 0,
      inconclusive: 0,
      survivors,
    });

    it('floors to UNPROVEN and names the surviving mutant', () => {
      const m = withSurvivors([{ file: 'calc.py', line: 2, operator: '+', mutatedTo: '-' }]);
      const r = fuse(result(true), ['calc.py'], complete, FULL_SCOPE, m);
      expect(r.verdict).toBe('UNPROVEN');
      expect(r.reason.toLowerCase()).toContain('mutant');
      expect(r.reason).toContain('calc.py:2');
      expect(r.reason).not.toMatch(/1 of 1/);
    });

    it('the SAFE gate blocks on a survivor even with coverage complete', () => {
      // Defense in depth: the survivor is asserted at the gate, not only trusted
      // to have floored changedLinesCovered.
      const m = withSurvivors([{ file: 'calc.py', line: 2, operator: '+', mutatedTo: '-' }]);
      expect(fuse(result(true), ['calc.py'], complete, FULL_SCOPE, m).verdict).not.toBe('SAFE');
    });

    it('names the plural form for multiple survivors', () => {
      const m = withSurvivors([
        { file: 'a.py', line: 2, operator: '+', mutatedTo: '-' },
        { file: 'b.py', line: 9, operator: '<=', mutatedTo: '<' },
      ]);
      const r = fuse(result(true), ['a.py', 'b.py'], complete, FULL_SCOPE, m);
      expect(r.reason).toContain('2 mutants');
    });

    it('a clean mutation run (no survivors) does not block a covered change', () => {
      // The negative direction: mutation ran and killed everything, so it must
      // not over-block — the change still reaches SAFE.
      const clean: MutationResult = {
        ran: true,
        tested: 3,
        killed: 3,
        inconclusive: 0,
        survivors: [],
      };
      const r = fuse(result(true), ['a.py'], complete, FULL_SCOPE, clean);
      expect(r.verdict).toBe('SAFE');
      expect(r.reason.toLowerCase()).not.toContain('mutant');
    });

    it('never strengthens: a clean mutation result cannot lift a thin-coverage UNPROVEN', () => {
      // Not a tautology: this fails if a future change let the presence of a
      // clean mutation result bypass the coverage floor. Mutation only ever adds
      // a blocking conjunct; it can never clear one.
      const clean: MutationResult = {
        ran: true,
        tested: 0,
        killed: 0,
        inconclusive: 0,
        survivors: [],
      };
      expect(fuse(result(true), ['a.py'], uncovered, FULL_SCOPE, clean).verdict).toBe('UNPROVEN');
    });

    it('reads survivors only when coverage is complete (reason guard)', () => {
      // If a producer ever attached survivors under incomplete coverage, the
      // verdict must stay UNPROVEN AND the reason must not claim a survived
      // mutant while coverage was never complete.
      const m = withSurvivors([{ file: 'a.py', line: 2, operator: '+', mutatedTo: '-' }]);
      const r = fuse(result(true), ['a.py'], uncovered, FULL_SCOPE, m);
      expect(r.verdict).toBe('UNPROVEN');
      expect(r.reason.toLowerCase()).not.toContain('mutant');
    });
  });

  // #146. The opt-in --flaky-check reruns a would-be-SAFE suite K times under
  // varied conditions (PYTHONHASHSEED). A test whose outcome VARIES across the
  // reruns was never a stable green, so SAFE is disqualified. Passed as
  // fuseVerdict's 6th arg, a sibling of `mutation`. Downgrade-only in both
  // directions, exactly like mutation.
  describe('stability (#146)', () => {
    const complete: CoverageAssessment = {
      tool: 'coverage.py',
      changedLinesCovered: true,
      uncovered: [],
      changedStatements: { total: 1, covered: 1 },
    };
    const withVaried = (varied: string[]): StabilityResult => ({
      ran: true,
      runs: 3,
      varied,
      inconclusive: 0,
    });

    it('floors a covered change to UNPROVEN and names the flaky test', () => {
      const s = withVaried(['tests/test_x.py::test_flaky']);
      const r = fuse(result(true), ['calc.py'], complete, FULL_SCOPE, undefined, s);
      expect(r.verdict).toBe('UNPROVEN');
      expect(r.reason.toLowerCase()).toContain('flaky');
      expect(r.reason).toContain('test_flaky');
    });

    it('the SAFE gate blocks on variance even with coverage complete', () => {
      // Defense in depth: variance is asserted at the SAFE conjunction, not only
      // trusted to have floored some other signal.
      const s = withVaried(['run 2 (seed 1)']);
      expect(fuse(result(true), ['calc.py'], complete, FULL_SCOPE, undefined, s).verdict).not.toBe(
        'SAFE',
      );
    });

    it('names the plural form for multiple flaky tests', () => {
      const s = withVaried(['tests/a.py::t1', 'tests/b.py::t2']);
      const r = fuse(result(true), ['a.py', 'b.py'], complete, FULL_SCOPE, undefined, s);
      expect(r.reason).toContain('2 test');
    });

    it('a clean stability run (no variance) does not block a covered change', () => {
      // The negative direction: all reruns agreed, so it must not over-block —
      // the change still reaches SAFE.
      const clean: StabilityResult = { ran: true, runs: 3, varied: [], inconclusive: 0 };
      const r = fuse(result(true), ['a.py'], complete, FULL_SCOPE, undefined, clean);
      expect(r.verdict).toBe('SAFE');
      expect(r.reason.toLowerCase()).not.toContain('flaky');
    });

    it('inconclusive reruns (all timed out) do not floor, but the SAFE discloses the sweep', () => {
      // A rerun that times out is inconclusive, never variance. A slow suite must
      // not manufacture a false UNPROVEN. But the SAFE must still CARRY the
      // stability block, so a reader sees the sweep was all-inconclusive rather
      // than a clean pass (the honesty rule; platform-independent here, unlike the
      // NO_HANG-gated integration case).
      const inconclusive: StabilityResult = { ran: true, runs: 0, varied: [], inconclusive: 3 };
      const r = fuse(result(true), ['a.py'], complete, FULL_SCOPE, undefined, inconclusive);
      expect(r.verdict).toBe('SAFE');
      expect(r.stability).toEqual(inconclusive);
    });

    it('a fail→heal flake outranks stability variance in the reason (C1 over C3)', () => {
      // If both fire, the fail→heal flake means no stable full green was ever
      // observed even once, which is a deeper problem than a green that varied on
      // rerun. The reason must say "flipped on retry", not "varied across reruns".
      const healed: VerificationResult = {
        ...result(true),
        gates: {
          syntax: ok,
          imports: ok,
          tests: { passed: true, durationMs: 1, flakySuspects: ['tests/x.py::t_heal'] },
        },
      };
      const s = withVaried(['tests/x.py::t_rerun']);
      const r = fuse(healed, ['calc.py'], complete, FULL_SCOPE, undefined, s);
      expect(r.verdict).toBe('UNPROVEN');
      expect(r.reason).toContain('flipped on retry');
      expect(r.reason).not.toContain('across reruns');
    });

    it('never strengthens: a clean stability result cannot lift a thin-coverage UNPROVEN', () => {
      // Not a tautology: fails if a future change let a clean stability result
      // bypass the coverage floor. Stability only ever adds a blocking conjunct.
      const clean: StabilityResult = { ran: true, runs: 3, varied: [], inconclusive: 0 };
      expect(fuse(result(true), ['a.py'], uncovered, FULL_SCOPE, undefined, clean).verdict).toBe(
        'UNPROVEN',
      );
    });

    it('stability variance outranks a surviving mutant in the reason', () => {
      // If both fire, a flaky suite makes the mutation result itself unreliable,
      // so the stability reason is the more fundamental one to surface.
      const m: MutationResult = {
        ran: true,
        tested: 1,
        killed: 0,
        inconclusive: 0,
        survivors: [{ file: 'calc.py', line: 2, operator: '+', mutatedTo: '-' }],
      };
      const s = withVaried(['tests/test_x.py::test_flaky']);
      const r = fuse(result(true), ['calc.py'], complete, FULL_SCOPE, m, s);
      expect(r.verdict).toBe('UNPROVEN');
      expect(r.reason.toLowerCase()).toContain('flaky');
      expect(r.reason.toLowerCase()).not.toContain('mutant');
    });
  });
});

// Issue #110 / ADR-12. A caller-supplied `testCmd` that names a subset of the
// suite scoped the whole verification run. Coverage was then attributed against
// that subset, and SAFE was issued on evidence the caller chose. Reproduced:
// the same diff returns UNSAFE under `python3 -m pytest -q` and SAFE under
// `python3 -m pytest -q tests/test_scale.py`.
