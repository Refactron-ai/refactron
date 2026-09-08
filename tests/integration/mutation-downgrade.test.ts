// tests/integration/mutation-downgrade.test.ts
//
// Issue #116 / ADR-15. SAFE proves a changed statement executed, not that any
// test asserts on it. --mutate perturbs the changed statement's operators and
// reruns the suite: a surviving mutant (the suite still passes) is a change no
// test would notice, so the verdict cannot be SAFE.
//
// The fixture's test EXECUTES the changed line (so coverage is complete and the
// change is SAFE without --mutate) but asserts nothing the mutation breaks (so
// the mutant survives). That gap is exactly the false SAFE this closes.
import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { verifyDiff } from '../../src/verify/verify-diff.js';

function hasPythonTooling(): boolean {
  try {
    execSync('python3 -c "import coverage, pytest"', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const NO_PYTHON = !hasPythonTooling();
// See tests/unit/verify/mutation.test.ts: a hung mutant orphans on Windows, so
// the inconclusive-path assertion is POSIX-only (ADR-15 known limitation).
const NO_HANG = NO_PYTHON || process.platform === 'win32';

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});

const DIFF = [
  '--- a/calc.py',
  '+++ b/calc.py',
  '@@ -1,2 +1,2 @@',
  ' def add(a, b):',
  '-    return a + b',
  '+    return b + a',
  '',
].join('\n');

/** `weak` asserts only the type of the result, so `+`->`-` still passes and the
 *  mutant survives. `strong` asserts the value, so the mutant is killed. */
async function fixture(strength: 'weak' | 'strong'): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mutate-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'calc.py'), 'def add(a, b):\n    return a + b\n');
  await fs.mkdir(path.join(root, 'tests'));
  const body =
    strength === 'weak'
      ? 'from calc import add\n\n\ndef test_add():\n    assert isinstance(add(2, 3), int)\n'
      : 'from calc import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n';
  await fs.writeFile(path.join(root, 'tests', 'test_add.py'), body);
  return root;
}

describe('a surviving mutant downgrades SAFE under --mutate (#116)', () => {
  it.skipIf(NO_PYTHON)(
    'a change with a weak test is SAFE without --mutate',
    async () => {
      // The control: the change is covered and passes, so the base engine calls
      // it SAFE. That is the false SAFE mutation exists to catch.
      const root = await fixture('weak');
      const report = await verifyDiff({
        repoRoot: root,
        trusted: true,
        unifiedDiff: DIFF,
        testCmd: 'python3 -m pytest -q',
      });
      expect(report.verdict).toBe('SAFE');
    },
    240_000,
  );

  it.skipIf(NO_PYTHON)(
    'the same change floors to UNPROVEN under --mutate',
    async () => {
      const root = await fixture('weak');
      const report = await verifyDiff({
        repoRoot: root,
        trusted: true,
        unifiedDiff: DIFF,
        testCmd: 'python3 -m pytest -q',
        mutate: true,
      });
      expect(report.verdict).toBe('UNPROVEN');
      expect(report.reason.toLowerCase()).toContain('mutant');
      expect(report.mutation?.survivors.length ?? 0).toBeGreaterThan(0);
      expect(report.mutation?.ran).toBe(true);
    },
    240_000,
  );

  it.skipIf(NO_PYTHON)(
    'a well-tested change still reaches SAFE under --mutate',
    async () => {
      // The negative case: a strong assertion kills the mutant, so --mutate must
      // not over-block. Without this, the mode could make SAFE unreachable.
      const root = await fixture('strong');
      const report = await verifyDiff({
        repoRoot: root,
        trusted: true,
        unifiedDiff: DIFF,
        testCmd: 'python3 -m pytest -q',
        mutate: true,
      });
      expect(report.verdict).toBe('SAFE');
    },
    240_000,
  );

  it.skipIf(NO_HANG)(
    'an inconclusive mutant (one that hangs) is skipped, not counted as a survivor',
    async () => {
      // Mutating `-` to `+` in the loop makes it never terminate, so the mutant
      // run times out. A timeout is inconclusive: it must NOT downgrade, or a
      // slow suite would produce false UNPROVENs. The change is otherwise SAFE
      // and must stay so. A short timeout bounds the test.
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mutate-hang-'));
      roots.push(root);
      await fs.writeFile(
        path.join(root, 'calc.py'),
        'def countdown(n):\n    while n > 0:\n        n = n - 1\n    return n\n',
      );
      await fs.mkdir(path.join(root, 'tests'));
      // Only line 3 is changed, so its `-` is the only mutant; `-`->`+` makes
      // the loop never terminate and the mutant run times out.
      await fs.writeFile(
        path.join(root, 'tests', 'test_c.py'),
        'from calc import countdown\n\n\ndef test_c():\n    assert countdown(3) == 0\n',
      );
      const diff = [
        '--- a/calc.py',
        '+++ b/calc.py',
        '@@ -1,4 +1,4 @@',
        ' def countdown(n):',
        '     while n > 0:',
        '-        n = n - 1',
        '+        n = n - 1  # touched',
        '     return n',
        '',
      ].join('\n');
      const report = await verifyDiff({
        repoRoot: root,
        trusted: true,
        unifiedDiff: diff,
        testCmd: 'python3 -m pytest -q',
        mutate: true,
        timeoutMs: 8_000,
      });
      // No confirmed survivor, so no downgrade: the change is SAFE.
      expect(report.verdict).toBe('SAFE');
      // Mutation ran but the only mutant was inconclusive: no survivors, and the
      // report discloses that it ran rather than silently omitting it.
      expect(report.mutation?.survivors).toEqual([]);
      expect(report.mutation?.inconclusive ?? 0).toBeGreaterThan(0);
    },
    240_000,
  );
});

// Issue #149. --mutate only perturbed OPERATORS, so a changed line whose behaviour
// lives in a CONSTANT (a number, string, True/False/None, or a bare `return
// <literal>`) generated zero mutants and stayed SAFE even under --mutate. A real
// value change executed but unasserted is exactly the false-green --mutate exists
// to close.
describe('a surviving constant mutant downgrades SAFE under --mutate (#149)', () => {
  const CONST_DIFF = [
    '--- a/calc.py',
    '+++ b/calc.py',
    '@@ -1,2 +1,2 @@',
    ' def status():',
    '-    return 2',
    '+    return 3',
    '',
  ].join('\n');

  /** `weak` asserts only the TYPE, so the constant mutant survives. `strong`
   *  asserts the VALUE, so it is killed — but a value assertion cannot survive a
   *  2->3 baseline, so the strong case uses a behaviour-preserving diff instead. */
  async function constFixture(strength: 'weak' | 'strong'): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'const-'));
    roots.push(root);
    await fs.writeFile(path.join(root, 'calc.py'), 'def status():\n    return 2\n');
    await fs.mkdir(path.join(root, 'tests'));
    const body =
      strength === 'weak'
        ? 'from calc import status\n\n\ndef test_status():\n    assert isinstance(status(), int)\n'
        : 'from calc import status\n\n\ndef test_status():\n    assert status() == 2\n';
    await fs.writeFile(path.join(root, 'tests', 'test_status.py'), body);
    return root;
  }

  it.skipIf(NO_PYTHON)(
    'a constant change with a type-only test is SAFE without --mutate',
    async () => {
      // The control, and the reproduced gap: the change is covered and the suite
      // passes, so the base engine calls it SAFE though nothing asserted the value.
      const root = await constFixture('weak');
      const report = await verifyDiff({
        repoRoot: root,
        trusted: true,
        unifiedDiff: CONST_DIFF,
        testCmd: 'python3 -m pytest -q',
      });
      expect(report.verdict).toBe('SAFE');
    },
    240_000,
  );

  it.skipIf(NO_PYTHON)(
    'the same change floors to UNPROVEN under --mutate, naming the constant mutant',
    async () => {
      const root = await constFixture('weak');
      const report = await verifyDiff({
        repoRoot: root,
        trusted: true,
        unifiedDiff: CONST_DIFF,
        testCmd: 'python3 -m pytest -q',
        mutate: true,
      });
      expect(report.verdict).toBe('UNPROVEN');
      expect(report.reason.toLowerCase()).toContain('mutant');
      const survivors = report.mutation?.survivors ?? [];
      expect(survivors.length).toBeGreaterThan(0);
      // The mutant is the constant `3` on the changed line, not an operator.
      expect(survivors.some((s) => s.file === 'calc.py' && s.line === 2)).toBe(true);
      expect(survivors.some((s) => s.operator === '3')).toBe(true);
    },
    240_000,
  );

  it.skipIf(NO_PYTHON)(
    'a value-asserted constant is killed and still reaches SAFE under --mutate',
    async () => {
      // No over-block: a behaviour-preserving edit to the constant's line (a
      // comment) keeps the baseline green while still marking the line changed, so
      // its `2` is mutated; the value assertion kills the mutant. Without this,
      // constant mutation could make SAFE unreachable for any asserted constant.
      const root = await constFixture('strong');
      const diff = [
        '--- a/calc.py',
        '+++ b/calc.py',
        '@@ -1,2 +1,2 @@',
        ' def status():',
        '-    return 2',
        '+    return 2  # touched',
        '',
      ].join('\n');
      const report = await verifyDiff({
        repoRoot: root,
        trusted: true,
        unifiedDiff: diff,
        testCmd: 'python3 -m pytest -q',
        mutate: true,
      });
      expect(report.verdict).toBe('SAFE');
      // The real pin (not just "SAFE"): a constant mutant was generated AND
      // killed. On main this case is also SAFE, but because NO constant mutant
      // exists there — asserting only the verdict would pass identically on both
      // trees and prove nothing. `MutationResult` itemizes only survivors, so
      // tested>0 && killed>0 is the strongest available "generated and died" pin.
      expect(report.mutation?.tested ?? 0).toBeGreaterThan(0);
      expect(report.mutation?.killed ?? 0).toBeGreaterThan(0);
    },
    240_000,
  );
});
