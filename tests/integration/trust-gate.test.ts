// tests/integration/trust-gate.test.ts
//
// The trust gate (ADR-19, GHSA Finding 1). Coverage and pass/fail are measured
// by running the diff's OWN suite in-process, which an untrusted diff can forge.
// So a would-be-SAFE is WITHHELD (→ UNPROVEN) unless the operator declares the
// author trusted. This pins BOTH directions on ONE honest, fully-covered change:
// trusted → SAFE, untrusted (default) → UNPROVEN. The verdict difference is the
// trust flag alone — no forgery, no coverage gap — which is what proves the gate
// is a blanket withhold, not forgery detection.
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

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trust-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'calc.py'), 'def scale(x):\n    return x * 2\n');
  await fs.mkdir(path.join(root, 'tests'));
  // The test genuinely exercises the changed line, so coverage is honest and
  // complete: the ONLY thing standing between this and SAFE is the trust flag.
  await fs.writeFile(
    path.join(root, 'tests', 'test_calc.py'),
    'from calc import scale\n\n\ndef test_scale():\n    assert scale(5) == 10\n',
  );
  return root;
}

// Behavior-preserving, fully-covered change: x * 2 -> 2 * x.
const DIFF = [
  '--- a/calc.py',
  '+++ b/calc.py',
  '@@ -1,2 +1,2 @@',
  ' def scale(x):',
  '-    return x * 2',
  '+    return 2 * x',
  '',
].join('\n');

describe('the trust gate withholds SAFE for an untrusted diff (ADR-19)', () => {
  it.skipIf(NO_PYTHON)(
    'a trusted author gets SAFE on an honest, fully-covered change',
    async () => {
      const root = await fixture();
      const report = await verifyDiff({
        repoRoot: root,
        trusted: true,
        unifiedDiff: DIFF,
        testCmd: 'python3 -m pytest -q',
      });
      expect(report.verdict).toBe('SAFE');
      expect(report.trustMode).toBe('trusted');
    },
    180_000,
  );

  it.skipIf(NO_PYTHON)(
    'the identical change is withheld to UNPROVEN when untrusted (the default)',
    async () => {
      const root = await fixture();
      const report = await verifyDiff({
        repoRoot: root,
        unifiedDiff: DIFF,
        testCmd: 'python3 -m pytest -q',
      });
      expect(report.verdict).toBe('UNPROVEN');
      expect(report.trustMode).toBe('untrusted');
      expect(report.reason).toContain('SAFE is withheld');
      // The evidence is still disclosed: this UNPROVEN is a trust withhold, not a
      // coverage gap, so the covered flag stays true and there are no missingTests.
      expect(report.coverage.changedLinesCovered).toBe(true);
      expect(report.missingTests ?? []).toEqual([]);
    },
    180_000,
  );
});
