// tests/integration/flaky-check.test.ts
//
// Issue #146. A test that passes on the single changed-tree run because of
// randomness, ordering, or timing — not because behaviour is preserved — counts
// toward SAFE. The opt-in --flaky-check reruns a would-be-SAFE suite K times
// under a varied PYTHONHASHSEED; a test whose outcome varies across the reruns
// was never a stable green, so the verdict floors to UNPROVEN.
//
// TEST-HONESTY NOTE. A genuine `random.random()` coin-flip fixture would make the
// test of the detector itself flaky (a 1-in-K chance of catching it). The fixture
// here is instead keyed to the exact variance the check injects: a test whose
// outcome depends on PYTHONHASHSEED. That is the cleanest DETERMINISTIC instance
// of the class the feature detects — green under the gate's default seed, red
// under the injected non-default seeds — so the red-first proof is repeatable.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
// The inconclusive case spins to force a timeout; that python orphans on Windows
// (Node does not tree-kill the grandchild), so that case is POSIX-only, like the
// mutation hang test. A busy loop, not time.sleep: on Node 18 execa's timeout
// reliably kills a CPU-spinning child but was flaky killing a sleeping one.
const NO_HANG = NO_PYTHON || process.platform === 'win32';

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});

// The fixtures key their flakiness to PYTHONHASHSEED, and the gate + coverage
// runs inherit process.env (only the stability reruns force the seed). If the CI
// runner exports PYTHONHASHSEED (pytest-randomly, a hardened image, a dev seeking
// reproducibility), the gate's baseline would run under that seed and the fixture
// green would depend on it. Neutralize it here so the baseline is deterministic;
// restore it so no other suite is affected.
let priorSeed: string | undefined;
beforeEach(() => {
  priorSeed = process.env.PYTHONHASHSEED;
  delete process.env.PYTHONHASHSEED;
});
afterEach(() => {
  if (priorSeed === undefined) delete process.env.PYTHONHASHSEED;
  else process.env.PYTHONHASHSEED = priorSeed;
});

// `return x * 2` -> `return 2 * x`. Behaviour-preserving on purpose: every fixture
// below must be green on BOTH the original tree (the gate's baseline) and the
// changed tree, so the diff cannot alter the value the tests observe. The changed
// line still executes when scale is called, so coverage is complete and the
// change is SAFE without a deep check. (This mirrors the mutation-downgrade
// fixture's commutative diff, for the same baseline reason.)
const DIFF = [
  '--- a/calc.py',
  '+++ b/calc.py',
  '@@ -1,2 +1,2 @@',
  ' def scale(x):',
  '-    return x * 2',
  '+    return 2 * x',
  '',
].join('\n');

/**
 * `flaky`   — covers the change but its assertion depends on PYTHONHASHSEED, so
 *             it passes under the gate (unset/0) and fails under a non-zero seed.
 * `stable`  — covers the change with a value assertion (green on both trees since
 *             the diff is behaviour-preserving); green under every seed.
 * `slow`    — covers the change; spins (and so times out) under a non-zero seed,
 *             modelling a rerun that is inconclusive rather than red.
 */
async function fixture(kind: 'flaky' | 'stable' | 'slow'): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flaky-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'calc.py'), 'def scale(x):\n    return x * 2\n');
  await fs.mkdir(path.join(root, 'tests'));
  const body =
    kind === 'flaky'
      ? 'import os\nfrom calc import scale\n\n\ndef test_scale():\n    scale(5)\n    assert os.environ.get("PYTHONHASHSEED") in (None, "0")\n'
      : kind === 'stable'
        ? 'from calc import scale\n\n\ndef test_scale():\n    assert scale(5) == 10\n'
        : 'import os\nfrom calc import scale\n\n\ndef test_scale():\n    scale(5)\n    if os.environ.get("PYTHONHASHSEED") not in (None, "0"):\n        while True:\n            pass\n    assert True\n';
  await fs.writeFile(path.join(root, 'tests', 'test_scale.py'), body);
  return root;
}

describe('a flaky test downgrades SAFE under --flaky-check (#146)', () => {
  it.skipIf(NO_PYTHON)(
    'a coin-flip test is SAFE without --flaky-check',
    async () => {
      // The control: the change is covered and the suite passes on the single
      // run, so the base engine calls it SAFE. That is the coin-flip SAFE this
      // feature exists to catch.
      const root = await fixture('flaky');
      const report = await verifyDiff({
        repoRoot: root,
        trusted: true,
        unifiedDiff: DIFF,
        testCmd: 'python3 -m pytest -q',
      });
      expect(report.verdict).toBe('SAFE');
      expect(report.stability).toBeUndefined();
    },
    240_000,
  );

  it.skipIf(NO_PYTHON)(
    'the same change floors to UNPROVEN under --flaky-check',
    async () => {
      const root = await fixture('flaky');
      const report = await verifyDiff({
        repoRoot: root,
        trusted: true,
        unifiedDiff: DIFF,
        testCmd: 'python3 -m pytest -q',
        flakyCheck: true,
      });
      expect(report.verdict).toBe('UNPROVEN');
      expect(report.reason.toLowerCase()).toContain('flaky');
      expect(report.stability?.varied.length ?? 0).toBeGreaterThan(0);
      expect(report.stability?.ran).toBe(true);
    },
    240_000,
  );

  it.skipIf(NO_PYTHON)(
    'a deterministic covering test still reaches SAFE under --flaky-check',
    async () => {
      // The negative case: a value assertion is green under every seed, so
      // --flaky-check must not over-block. Without this, the mode could make
      // SAFE unreachable for any suite.
      const root = await fixture('stable');
      const report = await verifyDiff({
        repoRoot: root,
        trusted: true,
        unifiedDiff: DIFF,
        testCmd: 'python3 -m pytest -q',
        flakyCheck: true,
      });
      expect(report.verdict).toBe('SAFE');
      expect(report.stability?.ran).toBe(true);
      expect(report.stability?.varied).toEqual([]);
    },
    240_000,
  );

  it.skipIf(NO_HANG)(
    'an inconclusive rerun (one that times out) is skipped, not counted as variance',
    async () => {
      // A rerun that times out is inconclusive: it must NOT downgrade, or a slow
      // suite would produce false UNPROVENs. Under a non-zero seed the fixture
      // spins and the rerun times out; the seed-0 rerun still passes, so there
      // is no confirmed variance and the change stays SAFE. The timeout is short
      // (the non-spinning runs finish in well under it) to bound the two
      // spin-to-timeout reruns and keep the test's wall time down.
      const root = await fixture('slow');
      const report = await verifyDiff({
        repoRoot: root,
        trusted: true,
        unifiedDiff: DIFF,
        testCmd: 'python3 -m pytest -q',
        flakyCheck: true,
        timeoutMs: 4_000,
      });
      expect(report.verdict).toBe('SAFE');
      expect(report.stability?.varied).toEqual([]);
      expect(report.stability?.inconclusive ?? 0).toBeGreaterThan(0);
    },
    240_000,
  );
});
