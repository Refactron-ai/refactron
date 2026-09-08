// tests/integration/branch-coverage-safe.test.ts
//
// Issue #117 / ADR-14. The statement-level SAFE rule (ADR-11) counts a changed
// `if` as covered the moment its header executes, so a change to a conditional
// whose one branch no test entered earns SAFE with untested behaviour.
//
// The fixture isolates the branch rule from the statement rule: EVERY statement
// executes (so ADR-11 is satisfied and the change would be SAFE), but one arc of
// a changed conditional is never taken (so ADR-14 must floor it to UNPROVEN).
//
//     def f(n):
//         x = 0
//         if n >= 0:      <- the changed line; statement covered
//             x = 1
//         return x        <- arc (if -> return, skipping x=1) never taken
//
// A test that only calls f(5) executes lines 2..5 — statement coverage is
// COMPLETE — but never takes the false branch. That is a partial branch on the
// changed line, and it is exactly the false SAFE this closes.
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
// `it.skipIf`, never an early return: an early return reports PASSED and would
// hide the false SAFE coming back.
const NO_PYTHON = !hasPythonTooling();

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});

// Widens the condition (`> 0` -> `>= 0`), a real behaviour change on the
// boundary. The changed line is the conditional itself.
const DIFF = [
  '--- a/calc.py',
  '+++ b/calc.py',
  '@@ -1,5 +1,5 @@',
  ' def f(n):',
  '     x = 0',
  '-    if n > 0:',
  '+    if n >= 0:',
  '         x = 1',
  '     return x',
  '',
].join('\n');

/** A repo whose test exercises ONLY the given branch of `f`. `both` takes the
 *  false arc too, which is the negative case that must still reach SAFE. */
async function fixture(cover: 'true-only' | 'both'): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'branch-cov-'));
  roots.push(root);
  await fs.writeFile(
    path.join(root, 'calc.py'),
    'def f(n):\n    x = 0\n    if n > 0:\n        x = 1\n    return x\n',
  );
  await fs.mkdir(path.join(root, 'tests'));
  const body =
    cover === 'true-only'
      ? 'from calc import f\n\n\ndef test_pos():\n    assert f(5) == 1\n'
      : // Both arcs: f(5) takes the true branch, f(-1) takes the false branch.
        'from calc import f\n\n\ndef test_both():\n    assert f(5) == 1\n    assert f(-1) == 0\n';
  await fs.writeFile(path.join(root, 'tests', 'test_f.py'), body);
  return root;
}

describe('a changed conditional with an untaken branch cannot earn SAFE (#117)', () => {
  it.skipIf(NO_PYTHON)(
    'floors to UNPROVEN when one branch of the changed if is never taken',
    async () => {
      // AC3, the red-first case. On main this returns SAFE: every changed
      // statement executed, so the statement rule is satisfied. ADR-14 must
      // catch that the false branch was never entered.
      const root = await fixture('true-only');
      const report = await verifyDiff({
        repoRoot: root,
        trusted: true,
        unifiedDiff: DIFF,
        testCmd: 'python3 -m pytest -q',
      });
      expect(report.verdict).not.toBe('SAFE');
      expect(report.verdict).toBe('UNPROVEN');
      // The reason must name the branch, not read as a generic coverage miss:
      // the whole point is that statement coverage WAS complete.
      expect(report.reason.toLowerCase()).toContain('branch');
    },
    240_000,
  );

  it.skipIf(NO_PYTHON)(
    'still reaches SAFE when every branch of the changed if is exercised',
    async () => {
      // AC4, the negative case. This is what stops the rule from over-blocking:
      // a fully-tested conditional must still earn SAFE, or branch gating would
      // make SAFE unreachable for ordinary code.
      const root = await fixture('both');
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
});
