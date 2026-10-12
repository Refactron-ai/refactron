// The check for runner files above the copy runs before every suite spawn, so a
// file that appears in the base partway through a verification is caught at the
// next spawn rather than applying to it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { verifyDiff } from '../../src/verify/verify-diff.js';
import { runMutation } from '../../src/verify/mutation.js';
import { verificationBase } from '../../src/verify/private-base.js';

function hasPythonTooling(): boolean {
  try {
    execSync('python3 -c "import coverage, pytest"', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const NO_PYTHON = !hasPythonTooling() || process.platform === 'win32';

const ENV_KEYS = ['REFACTRON_VERIFY_BASE', 'TMPDIR', 'HOME'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let scratch: string;
beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(await verificationBase(), 'per-spawn-'));
});
afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await fs.rm(scratch, { recursive: true, force: true });
});

// The suite writes a pytest.ini into the directory above wherever it runs, once.
const WRITES_ABOVE =
  'import os\n\n\n' +
  'def test_writes_above():\n' +
  '    p = os.path.join(os.path.dirname(os.getcwd()), "pytest.ini")\n' +
  '    if not os.path.exists(p):\n' +
  '        open(p, "w").write(\'[pytest]\\naddopts = -k "not test_add_correct"\\n\')\n';

describe('runner files appearing above the copy mid-run', () => {
  it.skipIf(NO_PYTHON)(
    'a file written above the copy by the baseline run refuses the next run',
    async () => {
      const repo = path.join(scratch, 'repo');
      const base = path.join(scratch, 'base');
      await fs.mkdir(repo);
      await fs.mkdir(base, { mode: 0o700 });
      await fs.writeFile(path.join(repo, 'calc.py'), 'def add(a, b):\n    return a + b\n');
      await fs.writeFile(
        path.join(repo, 'test_calc.py'),
        'from calc import add\n\n\ndef test_add_correct():\n    assert add(2, 3) == 5\n',
      );
      await fs.writeFile(path.join(repo, 'test_above.py'), WRITES_ABOVE);
      process.env.REFACTRON_VERIFY_BASE = base;
      process.env.TMPDIR = base;

      const r = await verifyDiff({
        repoRoot: repo,
        trusted: true,
        unifiedDiff: [
          '--- a/calc.py',
          '+++ b/calc.py',
          '@@ -1,2 +1,2 @@',
          ' def add(a, b):',
          '-    return a + b',
          '+    return a - b',
          '',
        ].join('\n'),
        testCmd: 'python3 -m pytest -q',
      });
      expect(r.verdict).toBe('UNPROVEN');
      expect(r.reason).toMatch(
        /^a pytest\.ini above the verification copy could change the test run/,
      );
      expect(r.coverage.tool).toBe('none');
      expect(r.coverage.changedLinesCovered).toBe('unknown');
      expect(r.testScope.scope).toBe('unknown');
    },
    180_000,
  );

  it.skipIf(NO_PYTHON)(
    'a mutant run after such a file appears is inconclusive, never killed',
    async () => {
      const copy = path.join(scratch, 'tree');
      await fs.mkdir(copy);
      await fs.writeFile(path.join(copy, 'calc.py'), 'def f(n):\n    return n + n\n');
      await fs.writeFile(
        path.join(copy, 'test_calc.py'),
        'import calc\n\n\ndef test_f():\n    assert calc.f(2) == 4\n',
      );
      await fs.writeFile(path.join(copy, 'test_above.py'), WRITES_ABOVE);
      const r = await runMutation({
        shadowRoot: copy,
        ranges: [{ path: 'calc.py', lines: [2] }],
        testCmd: 'python3 -m pytest -q',
        timeoutMs: 60_000,
      });
      expect(r.ran).toBe(true);
      expect(r.tested).toBeGreaterThan(0);
      expect(r.killed).toBe(0);
      expect(r.survivors).toEqual([]);
      expect(r.inconclusive).toBe(r.tested);
    },
    180_000,
  );

  it.skipIf(NO_PYTHON)(
    'a mutation baseline refused by the check is skipped, not thrown',
    async () => {
      const copy = path.join(scratch, 'tree');
      await fs.mkdir(copy);
      await fs.writeFile(path.join(scratch, 'conftest.py'), '');
      await fs.writeFile(path.join(copy, 'calc.py'), 'def f(n):\n    return n + n\n');
      await fs.writeFile(
        path.join(copy, 'test_calc.py'),
        'import calc\n\n\ndef test_f():\n    assert calc.f(2) == 4\n',
      );
      const r = await runMutation({
        shadowRoot: copy,
        ranges: [{ path: 'calc.py', lines: [2] }],
        testCmd: 'python3 -m pytest -q',
      });
      expect(r.ran).toBe(false);
      expect(r.killed).toBe(0);
      expect(r.skippedReason).toMatch(/^a conftest\.py above the verification copy/);
    },
    60_000,
  );
});

describe('the refusal names where the file was found', () => {
  it.skipIf(NO_PYTHON)(
    'shows the directory, with the home directory as ~',
    async () => {
      const repo = path.join(scratch, 'repo');
      await fs.mkdir(repo);
      await fs.writeFile(path.join(repo, 'calc.py'), 'def add(a, b):\n    return a + b\n');
      await fs.writeFile(path.join(repo, 'test_calc.py'), 'def test_x():\n    pass\n');
      const base = path.join(scratch, 'base');
      await fs.mkdir(base, { mode: 0o700 });
      await fs.writeFile(path.join(base, 'setup.py'), '');
      process.env.REFACTRON_VERIFY_BASE = base;
      const home = await fs.realpath(scratch);
      process.env.HOME = home;

      const r = await verifyDiff({
        repoRoot: repo,
        trusted: true,
        unifiedDiff: [
          '--- a/calc.py',
          '+++ b/calc.py',
          '@@ -1,2 +1,2 @@',
          ' def add(a, b):',
          '-    return a + b',
          '+    return b + a',
          '',
        ].join('\n'),
        testCmd: 'python3 -m pytest -q',
      });
      expect(r.verdict).toBe('UNPROVEN');
      expect(r.reason).toMatch(
        /^a setup\.py above the verification copy could change the test run/,
      );
      expect(r.reason).toContain('(found in ~/base)');
      expect(r.reason).not.toContain(home);
    },
    120_000,
  );
});
