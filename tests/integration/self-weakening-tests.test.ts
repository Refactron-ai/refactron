// tests/integration/self-weakening-tests.test.ts
//
// Issue #163. Refactron verifies a diff against the POST-diff test suite. A diff
// that relaxes the very test that would catch it — removing an assertion, deleting
// a test, adding a skip — makes the weakened suite pass, and on the trusted path
// that reads SAFE. A change that guts its own tests must NOT earn SAFE.
//
// These run with `trusted: true`, because the trust gate (ADR-19) already floors
// an UNTRUSTED diff to UNPROVEN regardless. The exposure this closes is the
// TRUSTED path, so trusted:true is what puts the weakening detector under test
// rather than the blanket withhold.
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

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});

// calc.double is asserted by test_double. The pre-diff intent: double(5) == 10.
async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weaken-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'calc.py'), 'def double(x):\n    return x * 2\n');
  await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(
    path.join(root, 'tests', 'test_calc.py'),
    'from calc import double\n\n\ndef test_double():\n    assert double(5) == 10\n',
  );
  return root;
}

describe('a diff that weakens its own covering test cannot earn SAFE (#163)', () => {
  it.skipIf(NO_PYTHON)(
    'changing behavior AND removing the covering assertion is UNPROVEN, not SAFE',
    async () => {
      const root = await fixture();
      // The change alters behavior (x*2 -> x*3) AND guts the test that would catch
      // it (the assertion is removed; the test now merely calls double). The
      // changed line still executes (covered) and the suite passes vacuously.
      const report = await verifyDiff({
        repoRoot: root,
        trusted: true,
        edits: [
          { path: 'calc.py', newContent: 'def double(x):\n    return x * 3\n' },
          {
            path: 'tests/test_calc.py',
            newContent: 'from calc import double\n\n\ndef test_double():\n    double(5)\n',
          },
        ],
        testCmd: 'python3 -m pytest -q',
      });
      // Red on main (trusted): covered + green + trusted => SAFE on the gutted test.
      expect(report.verdict).not.toBe('SAFE');
    },
    180_000,
  );

  it.skipIf(NO_PYTHON)(
    'a behavior-preserving change that STRENGTHENS its test still reaches SAFE',
    async () => {
      const root = await fixture();
      // x*2 -> 2*x is behavior-preserving; the test gains an assertion (net-additive),
      // which is strengthening, not weakening. Must stay SAFE-eligible.
      const report = await verifyDiff({
        repoRoot: root,
        trusted: true,
        edits: [
          { path: 'calc.py', newContent: 'def double(x):\n    return 2 * x\n' },
          {
            path: 'tests/test_calc.py',
            newContent:
              'from calc import double\n\n\ndef test_double():\n    assert double(5) == 10\n    assert double(0) == 0\n',
          },
        ],
        testCmd: 'python3 -m pytest -q',
      });
      expect(report.verdict).toBe('SAFE');
    },
    180_000,
  );
});
