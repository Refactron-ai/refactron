import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDiff } from '../../src/verify/verify-diff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, '../fixtures/verify-diff-mini');
const TEST_CMD = 'python3 -m pytest -q';

function pythonHasCoverage(): boolean {
  try {
    execSync('python3 -c "import coverage, pytest"', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// `it.skipIf`, never `if (...) return;`. An early return reports PASSED, so on a
// CI image without coverage.py the entire false-SAFE safety net would go green
// while proving nothing. A skip is visible in the runner summary.
const NO_COVERAGE = !pythonHasCoverage();

// Fixture bytes are pinned to LF by .gitattributes, but a clone made before that
// (or a stray core.autocrlf) would hand these tests CRLF, and every edit here is
// built by replacing an LF-delimited snippet. A silent no-match makes the "edit"
// identical to the base, which reads as UNPROVEN rather than a failed assertion,
// so normalize on read and let the tests fail loudly if a snippet is wrong.
async function readFixture(file: string): Promise<string> {
  return (await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n');
}

// A pytest project with one deterministically flaky test plus a source file the
// diff edits harmlessly. The flake is CROSS-TREE: its marker lives in the system
// temp dir (persists across shadow trees), so the gate's fresh-shadow retry
// heals it — the signature of a real timing flake, not tree-state leakage. It is
// ARMED only when it sees the CHANGED lib.py (the "# reordered" token), so the
// unmodified baseline tree runs it green and never consumes the marker. The
// marker is salted per run (env-injected) and removed in a finally, so reruns of
// our own suite stay deterministic. Exercises verifyDiff end to end.
async function flakyFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vd-flaky-'));
  await fs.writeFile(
    path.join(root, 'pyproject.toml'),
    '[tool.pytest.ini_options]\ntestpaths = ["."]\npythonpath = ["."]\n',
  );
  await fs.writeFile(path.join(root, 'lib.py'), 'def add(a, b):\n    return a + b\n');
  await fs.writeFile(
    path.join(root, 'test_flaky.py'),
    [
      'import os',
      'import tempfile',
      '',
      'def test_flaky():',
      '    with open(os.path.join(os.getcwd(), "lib.py")) as f:',
      '        src = f.read()',
      '    if "# reordered" not in src:',
      '        return  # baseline (unmodified) tree: unarmed, always green',
      '    marker = os.path.join(tempfile.gettempdir(), os.environ["REFACTRON_FLAKE_SALT"])',
      '    if not os.path.exists(marker):',
      '        open(marker, "w").close()',
      '        raise AssertionError("flaky: first run of the changed tree fails")',
      '    assert True',
      '',
    ].join('\n'),
  );
  return root;
}

// A FLAT layout: the package sits at the repo root, so cwd can supply it. That
// is what makes the spawn-shape divergence reachable, and it is why the src
// layout below cannot host this case. `sh -c "pytest"` runs a console script,
// whose sys.path[0] is the bin dir, so an out-of-tree PYTHONPATH wins; but
// `coverage run -m pytest` puts CWD first, ahead of PYTHONPATH, so the shadow
// wins. Gate green on one tree, coverage green on another, fused to SAFE.
async function flatLayoutFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vd-flat-'));
  await fs.mkdir(path.join(root, 'rfpkg'), { recursive: true });
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'pyproject.toml'),
    '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
  );
  await fs.writeFile(path.join(root, 'rfpkg', '__init__.py'), 'def add(a, b):\n    return a + b\n');
  await fs.writeFile(
    path.join(root, 'tests', 'test_rfpkg.py'),
    'from rfpkg import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n',
  );
  return root;
}

// `sh -c` strips backslashes in an assignment value, so a Windows absolute path
// would reach the tests gate mangled, both trees would fail to import, and the
// gate would report "baseline tests already fail" -- passing the UNPROVEN
// assertions below for a reason unrelated to anything under test.
function posix(p: string): string {
  return p.replace(/\\/g, '/');
}

// A src-layout project: `pkg` lives under src/, and pytest is given no
// `pythonpath`, so nothing is importable unless PYTHONPATH says where to look.
// That is what makes it a real test of the env prefix rather than a decorative
// one: with `PYTHONPATH=src` the SHADOW copy is imported, and with an absolute
// PYTHONPATH into the ORIGINAL tree the shadow copy is never imported at all.
// Do not "simplify" this back to verify-diff-mini: that fixture's conftest does
// `sys.path.insert(0, dirname(__file__))`, which re-inserts the local directory
// and imports the shadow copy anyway, so the bypass case cannot exist there.
async function srcLayoutFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vd-srclayout-'));
  await fs.mkdir(path.join(root, 'src', 'pkg'), { recursive: true });
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'pyproject.toml'),
    '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
  );
  await fs.writeFile(
    path.join(root, 'src', 'pkg', '__init__.py'),
    'def add(a, b):\n    return a + b\n\n\ndef unused_helper(a, b):\n    return a - b\n',
  );
  await fs.writeFile(
    path.join(root, 'tests', 'test_pkg.py'),
    'from pkg import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n',
  );
  return root;
}

const REORDERED_PKG =
  'def add(a, b):\n    return b + a\n\n\ndef unused_helper(a, b):\n    return a - b\n';

// Issue #110. Two tests over one function: test_scale EXECUTES the changed line
// without pinning its value, test_report pins it and therefore catches the
// change. Narrowing the command to test_scale selects the weak test and drops
// the one that fails, so coverage reports the changed statement as exercised
// while the regression sails through. The full suite must reach the opposite
// verdict on the identical diff; that contrast is the whole point of the
// fixture, so do not "simplify" it to a single test file.
async function narrowingFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vd-narrow-'));
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.writeFile(path.join(root, 'pyproject.toml'), '[project]\nname = "narrow"\n');
  // A rootdir conftest.py is what puts the project root on sys.path.
  await fs.writeFile(path.join(root, 'conftest.py'), '');
  await fs.writeFile(
    path.join(root, 'calc.py'),
    'def scale(x):\n    return x * 2\n\n\ndef report(x):\n    return "value=" + str(scale(x))\n',
  );
  await fs.writeFile(
    path.join(root, 'tests', 'test_scale.py'),
    'from calc import scale\n\n\ndef test_scale_returns_int():\n    assert isinstance(scale(2), int)\n',
  );
  await fs.writeFile(
    path.join(root, 'tests', 'test_report.py'),
    'from calc import report\n\n\ndef test_report_formats():\n    assert report(2) == "value=4"\n',
  );
  return root;
}

const SCALED_CALC =
  'def scale(x):\n    return x * 3\n\n\ndef report(x):\n    return "value=" + str(scale(x))\n';

// Issue #109 / ADR-11. `helper` is called by the suite; `report` is called by
// nothing. Under the v1 per-file rule the single exercised statement in
// `helper` cleared the WHOLE FILE, so a diff rewriting every line of `report`
// read SAFE with "the changed code is covered" while ten statements had never
// run. This is the classic false SAFE the rule change closes.
const PARTIAL_BASE = `def helper(x):
    return x + 1


def report(a, b):
    total = a + b
    doubled = total * 2
    tripled = doubled + total
    label = "sum"
    prefix = label.upper()
    suffix = str(tripled)
    joined = prefix + suffix
    trimmed = joined.strip()
    final = trimmed.lower()
    return final
`;

// `helper` is rewritten but SEMANTICS-PRESERVING (`x + 1` -> `1 + x`), so its
// test still passes and the tests gate stays green. That is what isolates the
// coverage rule: the only reason this diff is not SAFE is the ten statements in
// `report` that no test executes. Break helper's behaviour instead and the
// verdict is UNSAFE for an unrelated reason, proving nothing.
const PARTIAL_CHANGED = `def helper(x):
    return 1 + x


def report(a, b):
    total = a - b
    doubled = total * 3
    tripled = doubled + total + 1
    label = "difference"
    prefix = label.lower()
    suffix = str(tripled) + "!"
    joined = suffix + prefix
    trimmed = joined.rstrip()
    final = trimmed.upper()
    return final
`;

describe('SAFE requires every coverable changed statement (issue #109)', () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
  });

  async function partialFixture(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vd-partial-'));
    roots.push(root);
    await fs.mkdir(path.join(root, 'tests'), { recursive: true });
    await fs.writeFile(path.join(root, 'pyproject.toml'), '[project]\nname = "partial"\n');
    await fs.writeFile(path.join(root, 'conftest.py'), '');
    await fs.writeFile(path.join(root, 'calc.py'), PARTIAL_BASE);
    await fs.writeFile(
      path.join(root, 'tests', 'test_helper.py'),
      'from calc import helper\n\n\ndef test_helper():\n    assert helper(1) == 2\n',
    );
    return root;
  }

  it.skipIf(NO_COVERAGE)(
    'one exercised statement no longer clears a file of ten unexercised ones',
    async () => {
      const root = await partialFixture();
      const report = await verifyDiff({
        repoRoot: root,
        trusted: true,
        edits: [{ path: 'calc.py', newContent: PARTIAL_CHANGED }],
        testCmd: TEST_CMD,
      });
      // Before ADR-11 this was SAFE, reason "Tests pass and the changed code is
      // covered.", with the shortfall visible only in coverage.uncovered.
      expect(report.verdict).toBe('UNPROVEN');
      expect(report.coverage.tool).toBe('coverage.py');
      const stats = report.coverage.changedStatements;
      expect(stats).toBeDefined();
      expect(stats!.covered).toBeLessThan(stats!.total);
      // The reason must name the ratio: "not exercised by any test" would be
      // false here, because helper's statement did run.
      expect(report.reason).toContain('changed statements were exercised');
      expect(report.reason).not.toContain('not exercised by any test');
    },
    120_000,
  );

  it.skipIf(NO_COVERAGE)(
    'a fully exercised change is still SAFE',
    async () => {
      // The tightening must not swallow the legitimate case: change ONLY the
      // function the suite actually calls.
      const root = await partialFixture();
      const report = await verifyDiff({
        repoRoot: root,
        trusted: true,
        edits: [
          { path: 'calc.py', newContent: PARTIAL_BASE.replace('return x + 1', 'return x + 1 + 0') },
        ],
        testCmd: TEST_CMD,
      });
      expect(report.verdict).toBe('SAFE');
      expect(report.coverage.changedStatements).toEqual({ total: 1, covered: 1 });
    },
    120_000,
  );
});

// Issue #115. Same shape as #110 under a runner the classifier did not
// recognise. Reproduced on main before the fix: `python3 -m unittest
// tests.test_scale` returned SAFE with coverage 1/1 on a diff that
// `python3 -m unittest discover -s tests` called UNSAFE.
describe('an unparsed runner with arguments cannot earn SAFE (issue #115)', () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
  });

  async function unittestFixture(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vd-unittest-'));
    roots.push(root);
    await fs.mkdir(path.join(root, 'tests'), { recursive: true });
    await fs.writeFile(path.join(root, 'pyproject.toml'), '[project]\nname = "ut"\n');
    await fs.writeFile(path.join(root, 'conftest.py'), '');
    await fs.writeFile(path.join(root, 'tests', '__init__.py'), '');
    await fs.writeFile(
      path.join(root, 'calc.py'),
      'def scale(x):\n    return x * 2\n\n\ndef report(x):\n    return "value=" + str(scale(x))\n',
    );
    // Executes the changed line without pinning its value.
    await fs.writeFile(
      path.join(root, 'tests', 'test_scale.py'),
      'import unittest\nfrom calc import scale\n\n\nclass T(unittest.TestCase):\n    def test_scale(self):\n        self.assertIsInstance(scale(2), int)\n',
    );
    // Pins it, so it catches the change.
    await fs.writeFile(
      path.join(root, 'tests', 'test_report.py'),
      'import unittest\nfrom calc import report\n\n\nclass T(unittest.TestCase):\n    def test_report(self):\n        self.assertEqual(report(2), "value=4")\n',
    );
    return root;
  }

  const SCALED =
    'def scale(x):\n    return x * 3\n\n\ndef report(x):\n    return "value=" + str(scale(x))\n';

  async function run(testCmd: string) {
    const root = await unittestFixture();
    return verifyDiff({
      repoRoot: root,
      trusted: true,
      edits: [{ path: 'calc.py', newContent: SCALED }],
      testCmd,
    });
  }

  it.skipIf(NO_COVERAGE)(
    'the whole unittest suite catches the change: UNSAFE',
    async () => {
      const report = await run('python3 -m unittest discover -s tests');
      expect(report.verdict).toBe('UNSAFE');
      expect(report.testScope?.scope).toBe('full');
      // UNSAFE because the SUITE caught it, not because the command was rejected.
      expect(report.gates.tests.passed).toBe(false);
    },
    120_000,
  );

  it.skipIf(NO_COVERAGE)(
    'the same diff under a single unittest module is UNPROVEN, not SAFE',
    async () => {
      const report = await run('python3 -m unittest tests.test_scale');
      expect(report.verdict).toBe('UNPROVEN');
      expect(report.verdict).not.toBe('SAFE');
      expect(report.testScope?.scope).toBe('narrowed');
      expect(report.reason).toContain('narrowed the suite');
      // Pin the MECHANISM, so this cannot later pass for the wrong reason. The
      // tests gate PASSED and coverage measured every changed statement, so the
      // scope floor is the only thing standing between this and SAFE - which is
      // also why the ADR-11 statement rule does not cover this case.
      expect(report.gates.tests.passed).toBe(true);
      expect(report.coverage.tool).toBe('coverage.py');
      expect(report.coverage.changedStatements).toEqual({ total: 1, covered: 1 });
    },
    120_000,
  );
});

describe('a narrowed testCmd cannot earn SAFE (issue #110)', () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
  });

  async function run(testCmd: string) {
    const root = await narrowingFixture();
    roots.push(root);
    return verifyDiff({
      repoRoot: root,
      trusted: true,
      edits: [{ path: 'calc.py', newContent: SCALED_CALC }],
      testCmd,
    });
  }

  it.skipIf(NO_COVERAGE)(
    'the full suite catches the change: UNSAFE',
    async () => {
      const report = await run('python3 -m pytest -q');
      expect(report.verdict).toBe('UNSAFE');
      expect(report.testScope).toEqual({ scope: 'full', source: 'override', signals: [] });
    },
    120_000,
  );

  it.skipIf(NO_COVERAGE)(
    'the same diff under a narrowed command is UNPROVEN, not SAFE',
    async () => {
      const report = await run('python3 -m pytest -q tests/test_scale.py');
      // Before this fix the identical call returned SAFE with
      // "Tests pass and the changed code is covered." on a change that breaks
      // tests/test_report.py.
      expect(report.verdict).toBe('UNPROVEN');
      expect(report.verdict).not.toBe('SAFE');
      expect(report.testScope?.scope).toBe('narrowed');
      expect(report.reason).toContain('narrowed the suite');
    },
    120_000,
  );

  // Found in review. `--collect-only` is the maximal narrowing: it selects zero
  // tests, exits 0 so the tests gate passes on exit code alone, and still
  // IMPORTS every test module, so coverage.py marks module-level changed lines
  // as executed. Before the fix this returned SAFE with coverage 1/1 on a diff
  // the full suite calls UNSAFE. The fixture uses a module-level constant
  // because that is what collection alone can execute.
  it.skipIf(NO_COVERAGE)(
    'a collect-only run selects zero tests and cannot be SAFE',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vd-collect-'));
      roots.push(root);
      await fs.mkdir(path.join(root, 'tests'), { recursive: true });
      await fs.writeFile(path.join(root, 'pyproject.toml'), '[project]\nname = "co"\n');
      await fs.writeFile(path.join(root, 'conftest.py'), '');
      await fs.writeFile(
        path.join(root, 'calc.py'),
        'LIMIT = 4\n\n\ndef limit():\n    return LIMIT\n',
      );
      await fs.writeFile(
        path.join(root, 'tests', 'test_limit.py'),
        'from calc import limit\n\n\ndef test_limit():\n    assert limit() == 4\n',
      );
      const report = await verifyDiff({
        repoRoot: root,
        trusted: true,
        edits: [{ path: 'calc.py', newContent: 'LIMIT = 6\n\n\ndef limit():\n    return LIMIT\n' }],
        testCmd: 'python3 -m pytest -q --collect-only',
      });
      expect(report.verdict).not.toBe('SAFE');
      expect(report.testScope?.scope).toBe('narrowed');
    },
    120_000,
  );

  // CHARACTERIZATION, not regression: this one passes on main too, by design.
  // It is here to pin the fact that makes #110 and #109 independent, so a later
  // reader cannot conclude that the statement-coverage rule subsumes this fix.
  it.skipIf(NO_COVERAGE)(
    'the narrowed run still measured full statement coverage, so #109 would not have caught it',
    async () => {
      const report = await run('python3 -m pytest -q tests/test_scale.py');
      // Every changed statement DID execute under the narrowed command, so a
      // stricter statement-coverage rule leaves this false SAFE untouched.
      expect(report.coverage.tool).toBe('coverage.py');
      expect(report.coverage.changedStatements).toEqual({ total: 1, covered: 1 });
    },
    120_000,
  );
});

describe('verifyDiff with a NAME=VALUE prefix on testCmd (issue #95)', () => {
  // Restored in afterEach, NOT in a finally inside the test body. vitest marks a
  // timed-out test failed and moves on WITHOUT waiting for the awaited call to
  // settle, so an in-body finally never runs and the value leaks into every
  // later test in this file. Measured: the next test observed the leaked path.
  const ORIGINAL_PYTHONPATH = process.env.PYTHONPATH;
  afterEach(() => {
    if (ORIGINAL_PYTHONPATH === undefined) delete process.env.PYTHONPATH;
    else process.env.PYTHONPATH = ORIGINAL_PYTHONPATH;
  });

  it.skipIf(NO_COVERAGE)(
    'PYTHONPATH= prefix still measures coverage and can reach SAFE',
    async () => {
      // Before the fix this reported coverage.tool "none" and UNPROVEN: the
      // assignment was classified as a module name, `coverage run` imported
      // nothing, and no data file was written. The tests gate passed either
      // way, so the failure was invisible.
      const root = await srcLayoutFixture();
      const report = await verifyDiff({
        repoRoot: root,
        trusted: true,
        edits: [{ path: 'src/pkg/__init__.py', newContent: REORDERED_PKG }],
        testCmd: 'PYTHONPATH=src python3 -m pytest -q',
      });
      // Assert the MEASUREMENT, not just the verdict string. A test that only
      // checks for SAFE would also pass if SAFE were reached without coverage.
      expect(report.coverage.tool).toBe('coverage.py');
      expect(report.coverage.changedStatements?.covered ?? 0).toBeGreaterThan(0);
      expect(report.verdict).toBe('SAFE');
    },
    180_000,
  );

  it.skipIf(NO_COVERAGE)(
    'a PYTHONPATH pointing OUTSIDE the shadow tree reads unknown, never uncovered',
    async () => {
      // Hoisting env vars is exactly the mechanism that can aim a suite at code
      // the shadow tree does not contain: here the tests import the ORIGINAL
      // package, pass against unmodified code, and never load the changed copy.
      //
      // The name says "reads unknown, never uncovered" rather than "must not
      // read SAFE" because SAFE is over-determined here: a file missing from
      // measuredFiles has no covered lines, so the per-file AND in
      // coverage-attribution already forces UNPROVEN with the guard removed.
      // The property only the shadow-bypass guard delivers is the REASON, and
      // that is what the assertions below pin.
      const root = await srcLayoutFixture();
      const edits = [{ path: 'src/pkg/__init__.py', newContent: REORDERED_PKG }];

      // Run BOTH forms against the same fixture and the same edit, so the only
      // variable is where PYTHONPATH points. Asserting the pair is what keeps
      // this test honest: a lone UNPROVEN assertion would also pass if the
      // coverage wrapper had simply broken again, which is the bug this branch
      // fixes. Pinning the sibling to SAFE proves measurement works for this
      // command shape, so the degradation is about the TARGET, not the wrapper.
      //
      // It deliberately does not assert WHICH mechanism degraded the verdict.
      // Two cover this independently: the shadow-bypass guard (the changed file
      // is absent from measuredFiles), and ordinary attribution (its statements
      // show no coverage). Verified by disabling the guard, after which this
      // still reads UNPROVEN. `coverage.tool` cannot separate them either,
      // since a failed measurement and a fired guard both return
      // unknownCoverage() and report "none". The property under test is the one
      // that matters and the one both paths deliver: never SAFE.
      const intoShadow = await verifyDiff({
        repoRoot: root,
        trusted: true,
        edits,
        testCmd: 'PYTHONPATH=src python3 -m pytest -q',
      });
      const intoOriginal = await verifyDiff({
        repoRoot: root,
        trusted: true,
        edits,
        testCmd: `PYTHONPATH=${posix(path.join(root, 'src'))} python3 -m pytest -q`,
      });

      // Control: measurement demonstrably works for this command shape.
      expect(intoShadow.coverage.tool).toBe('coverage.py');
      expect(intoShadow.verdict).toBe('SAFE');

      // The suite RAN and was GREEN against the original code. Without this the
      // case is satisfiable by a red baseline, which degrades to UNPROVEN for a
      // reason that has nothing to do with shadow bypass.
      expect(intoOriginal.gates.tests.passed).toBe(true);
      // The guard's actual contract. It is NOT load-bearing for the verdict:
      // a file missing from measuredFiles has no covered lines, so the per-file
      // AND in coverage-attribution already forces UNPROVEN. What only the guard
      // delivers is discarding the measurement as UNKNOWN...
      expect(intoOriginal.coverage.tool).toBe('none');
      expect(intoOriginal.coverage.changedLinesCovered).toBe('unknown');
      // This case is module form on both sides, so it degrades through the
      // guard on every platform. That makes it the right place to pin the
      // remedy wording: a user who lands here must be told what to change.
      expect(String(intoOriginal.coverage.unknownReason)).toContain('PYTHONPATH');
      // ...instead of telling the user their suite failed to exercise code it
      // was never given the chance to load. That sentence would be a confident
      // lie, and it is what this assertion pins.
      expect(String(intoOriginal.reason)).not.toContain('not exercised by any test');
      // Over-determined, but cheap to keep.
      expect(intoOriginal.verdict).toBe('UNPROVEN');
    },
    180_000,
  );

  it.skipIf(NO_COVERAGE)(
    'a change that BREAKS the suite can never read SAFE, whatever the prefix',
    async () => {
      // The false SAFE this branch introduced and now forbids. On a flat layout
      // the gate's console-script spawn imports the ORIGINAL package via
      // PYTHONPATH and passes, while `coverage run -m pytest` imports the
      // SHADOW package via cwd and measures it as covered. Fusing those two
      // true statements about two different trees produced:
      //
      //   SAFE | coverage.py | "Tests pass and the changed code is covered."
      //
      // for an edit that makes add(2, 3) return -1. Verified against the
      // pre-decline build; the module-form control below proves the edit really
      // does break the suite.
      const root = await flatLayoutFixture();
      const edits = [
        { path: 'rfpkg/__init__.py', newContent: 'def add(a, b):\n    return a - b\n' },
      ];

      const viaConsoleScript = await verifyDiff({
        repoRoot: root,
        trusted: true,
        edits,
        testCmd: `PYTHONPATH=${posix(root)} pytest -q`,
      });
      const viaModuleForm = await verifyDiff({
        repoRoot: root,
        trusted: true,
        edits,
        testCmd: 'python3 -m pytest -q',
      });

      // The edit genuinely breaks the suite.
      expect(viaModuleForm.verdict).toBe('UNSAFE');
      // So no command shape may call it SAFE.
      expect(viaConsoleScript.verdict).not.toBe('SAFE');
      // It degrades through the shadow-bypass guard, not through a decline.
      // Once #98 gave the coverage run the gate's spawn shape, both runs import
      // the same copy, so this command is measurable again: coverage measures
      // the tree the gate actually ran, the shadow file is absent from
      // measuredFiles, and the guard discards the measurement as unknown. The
      // decline below it survives only for spawns we cannot make equivalent.
      expect(viaConsoleScript.coverage.tool).toBe('none');
      expect(viaConsoleScript.gates.tests.passed).toBe(true);
      expect(String(viaConsoleScript.reason)).not.toContain('not exercised by any test');
      // Disclosure is not optional. An earlier revision of this test dropped
      // the reason assertion when the degradation moved from a decline to the
      // guard, which quietly accepted less explanation than the previous
      // release gave. The floor must always say why and what to do about it.
      expect(viaConsoleScript.coverage.unknownReason ?? '').not.toBe('');
    },
    180_000,
  );

  it.skipIf(NO_COVERAGE)(
    'a console-script testCmd cannot read SAFE when the gate imports another copy',
    async () => {
      // Issue #98. The out-of-band twin of the case above: nothing is written
      // into testCmd, so there is no prefix to inspect and decline. The
      // environment supplies a competing copy of the package to BOTH spawns,
      // and only the spawn SHAPE decides which one wins:
      //
      //   gate      sh -c "pytest -q"           console script, sys.path[0] is
      //                                         the bin dir, so the env copy wins
      //   coverage  coverage run -m pytest -q   `-m` puts CWD first, so the
      //                                         shadow copy wins
      //
      // The gate then passes against unmodified code while coverage measures the
      // changed code as covered, and the shadow-bypass guard cannot help: the
      // changed file IS in measuredFiles, because coverage really did measure it.
      //
      // This is the shape of an ordinary `pip install -e .` project, where the
      // editable install resolves imports to the ORIGINAL tree. PYTHONPATH is
      // used here only because it reproduces the same resolution order without
      // needing a venv and a real install in the test suite.
      const root = await flatLayoutFixture();
      const edits = [
        { path: 'rfpkg/__init__.py', newContent: 'def add(a, b):\n    return a - b\n' },
      ];

      process.env.PYTHONPATH = root;
      {
        const report = await verifyDiff({
          repoRoot: root,
          trusted: true,
          edits,
          testCmd: 'pytest -q',
        });
        const control = await verifyDiff({
          repoRoot: root,
          trusted: true,
          edits,
          testCmd: 'python3 -m pytest -q',
        });

        // The edit genuinely breaks the suite, so the whole case has teeth.
        expect(control.verdict).toBe('UNSAFE');

        // The gate RAN and was GREEN against the copy the environment supplied.
        // Without this the case is satisfiable by a red baseline: deleting the
        // PYTHONPATH line above makes the package unimportable, the baseline
        // fails, and UNPROVEN arrives for a reason unrelated to the bug.
        expect(report.gates.tests.passed).toBe(true);
        // An exact verdict, not `not.toBe('SAFE')`, so a spurious UNSAFE cannot
        // satisfy it either.
        expect(report.verdict).toBe('UNPROVEN');
        // Degraded through the shadow-bypass guard, carrying a reason that
        // names the remedy rather than leaving the user with "could not be
        // determined" and nowhere to go.
        expect(report.coverage.tool).toBe('none');
        // Assert DISCLOSURE, not a specific sentence. Which mechanism degraded
        // is platform-dependent: on POSIX the entry point resolves and the
        // shadow-bypass guard fires, on Windows it cannot resolve and the
        // wrapper declines. Both must explain themselves; only one of them can
        // name the PYTHONPATH remedy, and that wording is pinned by the
        // src-layout test above, which uses module form and so behaves
        // identically everywhere.
        expect(report.coverage.unknownReason ?? '').not.toBe('');
      }
    },
    180_000,
  );
});

describe('verifyDiff (python three-way, real coverage)', () => {
  it.skipIf(NO_COVERAGE)(
    'semantics-preserving edit to COVERED code → SAFE',
    async () => {
      const report = await verifyDiff({
        repoRoot: FIXTURE,
        trusted: true,
        edits: [
          {
            path: 'calc.py',
            newContent:
              'def add(a, b):\n    return b + a\n\n\ndef unused_helper(a, b):\n    return a - b\n',
          },
        ],
        testCmd: TEST_CMD,
      });
      expect(report.verdict).toBe('SAFE');
    },
    180_000,
  );

  it.skipIf(NO_COVERAGE)(
    'behavior-breaking edit to COVERED code → UNSAFE',
    async () => {
      const report = await verifyDiff({
        repoRoot: FIXTURE,
        trusted: true,
        edits: [
          {
            path: 'calc.py',
            newContent:
              'def add(a, b):\n    return a - b\n\n\ndef unused_helper(a, b):\n    return a - b\n',
          },
        ],
        testCmd: TEST_CMD,
      });
      expect(report.verdict).toBe('UNSAFE');
    },
    180_000,
  );

  it.skipIf(NO_COVERAGE)(
    'mixed-language diff (covered .py + unassessable .ts) → UNPROVEN, never SAFE',
    async () => {
      const report = await verifyDiff({
        repoRoot: FIXTURE,
        trusted: true,
        edits: [
          {
            path: 'calc.py',
            newContent:
              'def add(a, b):\n    return b + a\n\n\ndef unused_helper(a, b):\n    return a - b\n',
          },
          { path: 'note.ts', newContent: 'export const note = 1;\n' },
        ],
        testCmd: TEST_CMD,
      });
      // The .py change alone would be SAFE, but the .ts change is unassessable by
      // the Python-only coverage tool, so the whole change must not read as SAFE.
      expect(report.verdict).toBe('UNPROVEN');
    },
    180_000,
  );

  it.skipIf(NO_COVERAGE)(
    'edit to UNCOVERED code, tests still pass → UNPROVEN',
    async () => {
      const report = await verifyDiff({
        repoRoot: FIXTURE,
        trusted: true,
        edits: [
          {
            path: 'calc.py',
            newContent:
              'def add(a, b):\n    return a + b\n\n\ndef unused_helper(a, b):\n    return a + b\n',
          },
        ],
        testCmd: TEST_CMD,
      });
      expect(report.verdict).toBe('UNPROVEN');
      expect(report.coverage.uncovered.length).toBeGreaterThanOrEqual(1);
    },
    180_000,
  );

  // Statement-level attribution. coverage.py attributes execution to a
  // statement's FIRST line, so a reformat that splits statements across lines
  // makes every continuation line look uncovered. Proven on pydantic: a black
  // reformat of `pydantic/_internal` reported 3666 "uncovered" entries, among
  // them lines 24-30 of _generate_schema.py: the names inside a
  // `from ipaddress import (...)` whose statement start (line 23) provably ran.
  describe('multi-line statements', () => {
    const MULTILINE = path.resolve(__dirname, '../fixtures/verify-diff-multiline');

    // shapes.py lines 1-4 are one `from math import (...)` statement. Swapping
    // the two imported names touches ONLY lines 2-3: the statement start is
    // unchanged, so it is not even in the changed set. This is the safety shape
    // (`x = [1,\n  3]` with only the continuation edited), so the change must be
    // attested by the enclosing statement, never dropped as unattributable.
    it.skipIf(NO_COVERAGE)(
      'changed CONTINUATION lines of an executed statement → SAFE',
      async () => {
        const report = await verifyDiff({
          repoRoot: MULTILINE,
          trusted: true,
          edits: [
            {
              path: 'shapes.py',
              newContent: (await readFixture(path.join(MULTILINE, 'shapes.py'))).replace(
                '    ceil,\n    floor,\n',
                '    floor,\n    ceil,\n',
              ),
            },
          ],
          testCmd: TEST_CMD,
        });
        expect(report.verdict).toBe('SAFE');
        expect(report.coverage.uncovered).toEqual([]);
      },
      180_000,
    );

    // The other half: unused_join's `return "-".join(` at line 16 never runs.
    // Editing three of its continuation lines (18, 19, 20) must report ONE
    // uncovered entry at line 16, the statement a human can write a test for,
    // not three entries at lines coverage.py never tracks.
    it.skipIf(NO_COVERAGE)(
      'changed lines under an UNEXECUTED statement → one deduped entry at the start',
      async () => {
        const report = await verifyDiff({
          repoRoot: MULTILINE,
          trusted: true,
          edits: [
            {
              path: 'shapes.py',
              newContent: (await readFixture(path.join(MULTILINE, 'shapes.py'))).replace(
                '            a,\n            b,\n            c,\n',
                '            a.strip(),\n            b.strip(),\n            c.strip(),\n',
              ),
            },
          ],
          testCmd: TEST_CMD,
        });
        expect(report.verdict).toBe('UNPROVEN');
        expect(report.coverage.uncovered).toEqual([{ file: 'shapes.py', line: 16 }]);
        expect(report.missingTests).toEqual([
          { file: 'shapes.py', hint: 'add a test exercising shapes.py:16' },
        ]);
      },
      180_000,
    );
  });

  // Statement-level attribution must not open a hole where coverage.py EXCLUDES
  // lines. `# pragma: no cover` (and `if TYPE_CHECKING:` under the usual
  // exclude_lines config) drops a statement from executed_lines AND
  // missing_lines. Measured on coverage 7.11, gated.py reports
  // executed=[1,2,5] missing=[] excluded=[5,6,7,8,9,10,11]: the exclusion is the
  // whole PHYSICAL BLOCK, not statement starts, so a set built from those lists
  // cannot tell the `return "-".join(` at 6 from its continuation lines 7-11.
  // AST containment can: lines 8-9 are inside the return statement that starts
  // at 6, which coverage never marked executed. One entry, at a line a human can
  // read, and never the `def dead(...)` at 5 (that one DID run at import time).
  it.skipIf(NO_COVERAGE)(
    'a change inside a `# pragma: no cover` body maps to the excluded statement, once',
    async () => {
      const PRAGMA = path.resolve(__dirname, '../fixtures/verify-diff-pragma');
      const report = await verifyDiff({
        repoRoot: PRAGMA,
        trusted: true,
        edits: [
          {
            path: 'gated.py',
            newContent: (await readFixture(path.join(PRAGMA, 'gated.py'))).replace(
              '            a,\n            b,\n',
              '            a.strip(),\n            b.strip(),\n',
            ),
          },
        ],
        testCmd: TEST_CMD,
      });
      expect(report.verdict).toBe('UNPROVEN');
      // Exact, not `length >= 1` + `every(line >= 6)`: those pass on the
      // physical-line mechanism too (it reports 8 and 9), so they proved nothing.
      expect(report.coverage.uncovered).toEqual([{ file: 'gated.py', line: 6, excluded: true }]);
      // A deliberately excluded statement cannot be reached by any test, so the
      // hint must not tell the user to write one.
      expect(report.missingTests?.[0]?.hint).toContain('excluded from coverage');
      expect(report.missingTests?.[0]?.hint).not.toContain('add a test');
    },
    180_000,
  );

  // `if TYPE_CHECKING:` is the shape that dominates real code (pydantic) and the
  // one the module comments cite, yet it had no test at all. Measured on
  // coverage 7.11: executed=[1,3,10,11] excluded=[3,4]. Line 3 (`if
  // TYPE_CHECKING:`) DOES execute at import time; line 4 (the guarded import)
  // never does. A change to the import's continuation lines must land on 4.
  it.skipIf(NO_COVERAGE)(
    'a change inside `if TYPE_CHECKING:` maps to the guarded import, never the executed guard',
    async () => {
      const TC = path.resolve(__dirname, '../fixtures/verify-diff-type-checking');
      const report = await verifyDiff({
        repoRoot: TC,
        trusted: true,
        edits: [
          {
            path: 'mod.py',
            newContent: (await readFixture(path.join(TC, 'mod.py'))).replace(
              '        Context,\n        Decimal,\n',
              '        Decimal,\n        Context,\n',
            ),
          },
        ],
        testCmd: TEST_CMD,
      });
      expect(report.verdict).toBe('UNPROVEN');
      expect(report.coverage.uncovered).toEqual([{ file: 'mod.py', line: 4, excluded: true }]);
      expect(report.coverage.uncovered.some((u) => u.line === 3)).toBe(false);
    },
    180_000,
  );

  // THE FALSE SAFE THIS BRANCH INTRODUCED. `enclosing(L) = max{stmt start <= L}`
  // cannot tell a continuation line of a statement from a blank/comment line
  // that merely FOLLOWS it, so an executed neighbour vouched for code in a
  // different, unexecuted block. Every case below pairs an untested behavior
  // change with one semantically inert edit; on the physical-line mechanism the
  // inert edit alone flipped the whole file to "exercised" and the verdict to
  // SAFE, with the disproof deleted from the report. Formatters insert and
  // remove blank lines constantly, so this is the exact motivating workload.
  describe('semantically inert lines never vouch for unexecuted code', () => {
    const INERT = path.resolve(__dirname, '../fixtures/verify-diff-inert');
    const BREAK_UNTESTED = [
      'def never_called(a, b):\n    return a + b',
      'def never_called(a, b):\n    return a * b',
    ] as const;

    async function inertSource(): Promise<string> {
      return readFixture(path.join(INERT, 'mod.py'));
    }

    async function runInert(newContent: string) {
      return verifyDiff({
        repoRoot: INERT,
        trusted: true,
        edits: [{ path: 'mod.py', newContent }],
        testCmd: TEST_CMD,
      });
    }

    // The reproduced regression: ONE added blank line between two functions,
    // plus `a + b` -> `a * b` inside a function no test calls.
    it.skipIf(NO_COVERAGE)(
      'a changed BLANK line does not make an untested change read as covered',
      async () => {
        const report = await runInert(
          (await inertSource())
            .replace(
              '    return a + b\n\n\ndef never_called',
              '    return a + b\n\n\n\ndef never_called',
            )
            .replace(...BREAK_UNTESTED),
        );
        expect(report.verdict).toBe('UNPROVEN');
        expect(report.coverage.uncovered).toEqual([{ file: 'mod.py', line: 12 }]);
      },
      180_000,
    );

    it.skipIf(NO_COVERAGE)(
      'a changed COMMENT line does not make an untested change read as covered',
      async () => {
        const report = await runInert(
          (await inertSource())
            .replace('# a comment in a tested body', '# a comment in a tested body, reworded')
            .replace(...BREAK_UNTESTED),
        );
        expect(report.verdict).toBe('UNPROVEN');
        expect(report.coverage.uncovered).toEqual([{ file: 'mod.py', line: 11 }]);
      },
      180_000,
    );

    // A function docstring is a real `Expr` statement in the AST, so the change
    // lands on its own line. coverage.py does not track function docstrings at
    // all (measured: line 5 appears in none of executed/missing/excluded), so
    // that statement reads as unexecuted, which is the honest answer.
    it.skipIf(NO_COVERAGE)(
      'a changed DOCSTRING line does not make an untested change read as covered',
      async () => {
        const report = await runInert(
          (await inertSource())
            .replace('"""Add two numbers."""', '"""Add two integers."""')
            .replace(...BREAK_UNTESTED),
        );
        expect(report.verdict).toBe('UNPROVEN');
        expect(report.coverage.uncovered).toEqual([
          { file: 'mod.py', line: 5 },
          { file: 'mod.py', line: 11 },
        ]);
      },
      180_000,
    );

    // The compiler folds `if False:` away, so coverage 7.11 reports its body in
    // NONE of executed/missing/excluded (measured: mod.py executed=[1,4,7,10,14]
    // missing=[11], line 15 in no list). `executed U missing U excluded` is
    // therefore still not the executable set, and a walk-back landed on the
    // `if False:` header at 14, which DOES execute. AST containment lands inside.
    it.skipIf(NO_COVERAGE)(
      'a change inside `if False:` is not vouched for by the executed guard above it',
      async () => {
        const report = await runInert(
          (await inertSource()).replace('    dead = 1', '    dead = 2'),
        );
        expect(report.verdict).toBe('UNPROVEN');
        expect(report.coverage.uncovered).toEqual([{ file: 'mod.py', line: 15 }]);
      },
      180_000,
    );

    // Nothing but a blank line moved. Inert lines can neither change behavior
    // nor be proven by a test, so there is nothing to attest, but the diff also
    // cannot prove the file is unchanged (a deletion is invisible in the added
    // lines), so this gets the removal-only treatment, not a free SAFE.
    it.skipIf(NO_COVERAGE)(
      'a file whose changed lines are ALL inert has nothing to attest, not a free pass',
      async () => {
        const report = await runInert(
          (await inertSource()).replace(
            '    return a + b\n\n\ndef never_called',
            '    return a + b\n\n\n\ndef never_called',
          ),
        );
        expect(report.verdict).toBe('UNPROVEN');
        expect(report.coverage.uncovered).toEqual([]);
        expect(report.coverage.inertOnlyFiles).toEqual(['mod.py']);
        expect(report.reason).toContain('comments');
      },
      180_000,
    );

    // VERDICT CHANGED BY ADR-11 (issue #109), deliberately. This fixture pairs a
    // covered edit with a behaviour break inside a function no test calls, and
    // it used to assert SAFE: the per-file rule let the one exercised statement
    // clear the file. That is the false SAFE the statement rule closes, so the
    // expectation is inverted rather than the test deleted. Everything it was
    // originally written to prove — that the report still DISCLOSES what it did
    // not run — is asserted unchanged below.
    it.skipIf(NO_COVERAGE)(
      'a partially exercised change is UNPROVEN and discloses the ratio',
      async () => {
        const report = await runInert(
          (await inertSource())
            .replace(
              '    return a + b\n\n\ndef never_called',
              '    return b + a\n\n\ndef never_called',
            )
            .replace(...BREAK_UNTESTED),
        );
        expect(report.verdict).toBe('UNPROVEN');
        expect(report.coverage.uncovered).toEqual([{ file: 'mod.py', line: 11 }]);
        expect(report.coverage.changedStatements).toEqual({ total: 2, covered: 1 });
        expect(report.reason).toContain('1 of 2 changed statements were exercised');
        expect(report.reportVersion).toBe(1);
      },
      180_000,
    );
  });

  it.skipIf(NO_COVERAGE)(
    'a flaky test that heals on retry does NOT produce a false UNSAFE; flakyTests carries it',
    async () => {
      const root = await flakyFixture();
      const salt = `refactron-vd-flake-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      process.env.REFACTRON_FLAKE_SALT = salt;
      try {
        const report = await verifyDiff({
          repoRoot: root,
          trusted: true,
          edits: [
            { path: 'lib.py', newContent: 'def add(a, b):\n    return a + b  # reordered\n' },
          ],
          testCmd: TEST_CMD,
        });
        // The only after-run failure is the flake, which vanishes on the fresh
        // shadow retry: the diff must not be blamed (no false UNSAFE), and the id
        // surfaces. Coverage of the reordered line stays unproven, so UNPROVEN.
        expect(report.verdict).not.toBe('UNSAFE');
        expect(report.flakyTests).toContain('test_flaky.py::test_flaky');
      } finally {
        await fs.rm(path.join(os.tmpdir(), salt), { force: true });
        delete process.env.REFACTRON_FLAKE_SALT;
      }
    },
    180_000,
  );
});
