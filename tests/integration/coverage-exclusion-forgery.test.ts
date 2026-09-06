// tests/integration/coverage-exclusion-forgery.test.ts
//
// Security (GHSA-9xch-4mch-222g / "A2"). An attacker who authors the diff can
// annotate a behaviour-bearing CHANGED statement with `# pragma: no cover` (or a
// `.coveragerc` / pyproject `[tool.coverage] exclude_lines`) so coverage.py
// EXCLUDES it. Before the fix, `coverage-attribution.ts` subtracted excluded
// changed statements from the SAFE requirement, so a file mixing one covered
// changed statement with an excluded malicious one earned SAFE over a live
// backdoor — a false SAFE, the one unforgivable defect.
//
// In the verify-an-untrusted-PR deployment the coverage config and every pragma
// are attacker-controlled, so an excluded CHANGED statement is not proof of
// anything: it floors the verdict at UNPROVEN. This test pins that invariant.
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

async function repo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'a2-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'charge.py'), 'def fee(amount):\n    return amount + 1\n');
  await fs.mkdir(path.join(root, 'tests'));
  // The test exercises fee(100), so the covered changed statement passes; it never
  // reaches the pragma'd branch.
  await fs.writeFile(
    path.join(root, 'tests', 'test_charge.py'),
    'from charge import fee\n\n\ndef test_fee():\n    assert fee(100) == 101\n',
  );
  return root;
}

describe('an attacker coverage-exclusion cannot earn SAFE (GHSA A2)', () => {
  it.skipIf(NO_PYTHON)(
    'a `# pragma: no cover` on a changed backdoor floors the verdict at UNPROVEN',
    async () => {
      const root = await repo();
      const diff = [
        '--- a/charge.py',
        '+++ b/charge.py',
        '@@ -1,2 +1,5 @@',
        ' def fee(amount):',
        '-    return amount + 1',
        '+    result = amount + 1',
        '+    if amount == 1337:  # pragma: no cover',
        '+        return -999999.0',
        '+    return result',
        '',
      ].join('\n');
      const report = await verifyDiff({
        repoRoot: root,
        unifiedDiff: diff,
        testCmd: 'python3 -m pytest -q',
      });
      // The security invariant: a changed statement the diff excluded from coverage
      // is unverified, so the verdict cannot be SAFE. (Red on main: returns SAFE.)
      expect(report.verdict).not.toBe('SAFE');
      expect(report.verdict).toBe('UNPROVEN');
    },
    240_000,
  );

  it.skipIf(NO_PYTHON)(
    'a fully-covered change with no excluded changed statements still reaches SAFE',
    async () => {
      // The negative direction: the fix must not floor an honest, fully-covered
      // change that excludes nothing. Without this, closing A2 could make SAFE
      // unreachable for ordinary diffs.
      const root = await repo();
      const diff = [
        '--- a/charge.py',
        '+++ b/charge.py',
        '@@ -1,2 +1,3 @@',
        ' def fee(amount):',
        '-    return amount + 1',
        '+    result = amount + 1',
        '+    return result',
        '',
      ].join('\n');
      const report = await verifyDiff({
        repoRoot: root,
        unifiedDiff: diff,
        testCmd: 'python3 -m pytest -q',
      });
      expect(report.verdict).toBe('SAFE');
    },
    240_000,
  );
});
