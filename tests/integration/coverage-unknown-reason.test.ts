import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { verifyDiff } from '../../src/verify/verify-diff.js';

// Found by scripts/flip-rate on the SECOND real commit it ever verified
// (more-itertools 18c57c72, which touches .py, .pyi, .rst and tests/ together).
// The engine bailed to `changedLinesCovered: 'unknown'` and reported NO
// `unknownReason`, so the report read:
//
//   verdict:  UNPROVEN
//   coverage: { tool: 'none', changedLinesCovered: 'unknown' }
//   reason:   "Tests pass, but coverage of the changed code could not be determined."
//
// That is the exact shape verify-diff.ts:124 warns about in a comment on the
// sibling branch four lines further down: a silent UNPROVEN that looks identical
// whether the coverage wrapper declined the command, the sidecar crashed, or the
// diff simply contained a `.rst` file. Two of those are bugs and one is normal
// operation, and the reader cannot tell which they have. On real-world commits
// this is not an edge case, it is the MODAL path: a mixed-language commit is
// what most commits are.
//
// `verify-diff.ts:110` is the offending return. It is the only `unknownCoverage()`
// call site in the file that passes no reason.

function pythonHasCoverage(): boolean {
  try {
    execSync('python3 -c "import coverage, pytest"', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// `it.skipIf`, never `if (...) return;`. An early return reports PASSED, and a
// CI image without coverage.py would then show a green tick for a test that
// never executed a line of the code it claims to pin.
const NO_COVERAGE = !pythonHasCoverage();

const TEST_CMD = 'python3 -m pytest -q';
const created: string[] = [];

afterEach(async () => {
  for (const dir of created.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

// Written at runtime with explicit `\n`, so unlike tests/fixtures/** this
// content cannot arrive CRLF from a Windows checkout and there is nothing for
// .gitattributes to pin. Every edit below is built by CONSTRUCTION rather than
// by string replacement, which removes the failure this repo has a scar from
// (a replace that matched nothing, an "edit" equal to its base, and a verdict
// that degraded to UNPROVEN while the test still passed). The `expect(...).not
// .toBe(base)` guards make that explicit rather than merely true.
async function miniProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vd-mixed-'));
  created.push(root);
  await fs.writeFile(
    path.join(root, 'pyproject.toml'),
    '[tool.pytest.ini_options]\ntestpaths = ["."]\npythonpath = ["."]\n',
  );
  await fs.writeFile(path.join(root, 'lib.py'), 'def add(a, b):\n    return a + b\n');
  await fs.writeFile(path.join(root, 'lib.pyi'), 'def add(a: int, b: int) -> int: ...\n');
  await fs.writeFile(path.join(root, 'README.md'), '# mini\n\nA project.\n');
  await fs.writeFile(
    path.join(root, 'test_lib.py'),
    'from lib import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n',
  );
  return root;
}

describe.skipIf(NO_COVERAGE)('coverage `unknown` always carries a reason', () => {
  // The fix must not be "always report unknown". Pin the untouched path FIRST,
  // in the same file, so a patch that buys a reason string by making coverage
  // unmeasurable everywhere fails here instead of shipping.
  it('a Python-only edit still measures coverage and still earns SAFE', async () => {
    const root = await miniProject();
    const base = await fs.readFile(path.join(root, 'lib.py'), 'utf8');
    const edited = 'def add(a, b):\n    total = a + b\n    return total\n';
    expect(edited).not.toBe(base);

    const report = await verifyDiff({
      repoRoot: root,
      trusted: true,
      edits: [{ path: 'lib.py', newContent: edited }],
      testCmd: TEST_CMD,
    });

    expect(report.verdict).toBe('SAFE');
    expect(report.coverage.tool).toBe('coverage.py');
    expect(report.coverage.changedLinesCovered).toBe(true);
    expect(report.coverage.unknownReason).toBeUndefined();
  }, 180_000);

  it('a mixed .py + non-Python edit reports WHY coverage is unknown', async () => {
    const root = await miniProject();
    const pyBase = await fs.readFile(path.join(root, 'lib.py'), 'utf8');
    const mdBase = await fs.readFile(path.join(root, 'README.md'), 'utf8');
    const pyEdit = 'def add(a, b):\n    total = a + b\n    return total\n';
    const mdEdit = '# mini\n\nA project, documented.\n';
    expect(pyEdit).not.toBe(pyBase);
    expect(mdEdit).not.toBe(mdBase);

    const report = await verifyDiff({
      repoRoot: root,
      trusted: true,
      edits: [
        { path: 'lib.py', newContent: pyEdit },
        { path: 'README.md', newContent: mdEdit },
      ],
      testCmd: TEST_CMD,
    });

    // The verdict itself is NOT the regression. UNPROVEN was already correct and
    // is still correct: a non-Python file's behaviour is genuinely unattested.
    // Asserting only on the verdict string is how this shipped in the first
    // place, so assert the coverage fields that distinguish the six different
    // UNPROVENs from each other.
    expect(report.verdict).toBe('UNPROVEN');
    expect(report.coverage.tool).toBe('none');
    expect(report.coverage.changedLinesCovered).toBe('unknown');
    expect(report.coverage.unknownReason).toBeTypeOf('string');
    expect(report.coverage.unknownReason ?? '').not.toBe('');
    // Name the file that caused the bail. "Coverage is Python-only" alone sends
    // a reader hunting through a 40-file diff for the offender.
    expect(report.coverage.unknownReason).toContain('README.md');
  }, 180_000);

  // `.pyi` is the case that made this the MODAL path rather than a curiosity:
  // a typed library cannot change a signature without touching the stub, so
  // every such commit bailed with no reason. It is also the case most likely to
  // be "fixed" by adding `.pyi` to the Python filter, which would be wrong —
  // coverage.py never executes a stub, so it must still bail, just audibly.
  it('a .py + .pyi edit bails with a reason naming the stub', async () => {
    const root = await miniProject();
    const pyiBase = await fs.readFile(path.join(root, 'lib.pyi'), 'utf8');
    const pyiEdit = 'def add(a: float, b: float) -> float: ...\n';
    expect(pyiEdit).not.toBe(pyiBase);

    const report = await verifyDiff({
      repoRoot: root,
      trusted: true,
      edits: [
        { path: 'lib.py', newContent: 'def add(a, b):\n    total = a + b\n    return total\n' },
        { path: 'lib.pyi', newContent: pyiEdit },
      ],
      testCmd: TEST_CMD,
    });

    expect(report.verdict).toBe('UNPROVEN');
    expect(report.coverage.changedLinesCovered).toBe('unknown');
    expect(report.coverage.unknownReason ?? '').not.toBe('');
    expect(report.coverage.unknownReason).toContain('lib.pyi');
  }, 180_000);

  it('an all-non-Python edit reports WHY coverage is unknown', async () => {
    const root = await miniProject();
    const report = await verifyDiff({
      repoRoot: root,
      trusted: true,
      edits: [{ path: 'README.md', newContent: '# mini\n\nRewritten.\n' }],
      testCmd: TEST_CMD,
    });

    expect(report.verdict).toBe('UNPROVEN');
    expect(report.coverage.tool).toBe('none');
    expect(report.coverage.changedLinesCovered).toBe('unknown');
    expect(report.coverage.unknownReason ?? '').not.toBe('');
    expect(report.coverage.unknownReason).toContain('README.md');
  }, 180_000);
});
