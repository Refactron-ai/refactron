// tests/integration/pytest-config-narrowing.test.ts
//
// Issue #137. A pytest config file that narrowed the suite produced a false
// `SAFE` end to end, and the unit tests in tests/unit/verify/test-scope.test.ts
// cannot show that: they prove the classifier's answer, not the verdict the
// engine builds from it. This is the shape the defect actually had.
//
// The fixture is built so every gate is satisfied HONESTLY:
//   - `test_a` executes the changed statement, so coverage is complete
//   - `test_b` is the test that would catch the break, and the config excludes it
//   - the command carries no filter, so the classifier used to answer `full`
// Tests pass, coverage is full, and the change is broken.
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
// hide the false SAFE returning.
const NO_PYTHON = !hasPythonTooling();

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
  '+    return a - b',
  '',
].join('\n');

async function fixture(configFile: string | null, configBody: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-narrow-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'calc.py'), 'def add(a, b):\n    return a + b\n');
  await fs.mkdir(path.join(root, 'tests'));
  // Executes the changed line, asserts nothing that the change breaks.
  await fs.writeFile(
    path.join(root, 'tests', 'test_a.py'),
    'from calc import add\n\n\ndef test_a():\n    assert isinstance(add(1, 2), int)\n',
  );
  // The test that catches it. Excluded by the config under test.
  await fs.writeFile(
    path.join(root, 'tests', 'test_b.py'),
    'from calc import add\n\n\ndef test_b():\n    assert add(1, 2) == 3\n',
  );
  if (configFile !== null) await fs.writeFile(path.join(root, configFile), configBody);
  return root;
}

describe('a pytest config that narrows the suite cannot earn SAFE (#137)', () => {
  // Every location pytest itself accepts. Each one produced SAFE before the fix.
  const CONFIGS: ReadonlyArray<readonly [string, string]> = [
    ['pytest.ini', '[pytest]\naddopts = -k test_a\n'],
    ['tox.ini', '[pytest]\naddopts = -k test_a\n'],
    ['setup.cfg', '[tool:pytest]\naddopts = -k test_a\n'],
    ['pyproject.toml', '[tool.pytest.ini_options]\naddopts = "-k test_a"\n'],
  ];

  for (const [file, body] of CONFIGS) {
    it.skipIf(NO_PYTHON)(
      `refuses SAFE when ${file} narrows the run`,
      async () => {
        const root = await fixture(file, body);
        const report = await verifyDiff({
          repoRoot: root,
          trusted: true,
          unifiedDiff: DIFF,
          testCmd: 'python3 -m pytest -q',
        });
        expect(report.verdict).not.toBe('SAFE');
        expect(report.testScope.scope).toBe('narrowed');
        // The signal must name the file. "-k selects a subset" alone sends the
        // reader hunting through a command line that contains no -k.
        expect(report.testScope.signals.join(' ')).toContain(file);
      },
      240_000,
    );
  }

  it.skipIf(NO_PYTHON)(
    'still returns UNSAFE with no config, which is what makes the rows above a REGRESSION',
    async () => {
      // The control. Without it, "not SAFE" above is consistent with the engine
      // simply being unable to verify this fixture at all.
      const root = await fixture(null, '');
      const report = await verifyDiff({
        repoRoot: root,
        trusted: true,
        unifiedDiff: DIFF,
        testCmd: 'python3 -m pytest -q',
      });
      expect(report.verdict).toBe('UNSAFE');
      expect(report.testScope.scope).toBe('full');
    },
    240_000,
  );

  it.skipIf(NO_PYTHON)(
    'does not floor a project whose config narrows nothing',
    async () => {
      // The failure mode of the FIX. Flooring every configured project would
      // make SAFE unreachable for most real repositories, which is worse than
      // the defect being closed.
      const root = await fixture('pytest.ini', '[pytest]\naddopts = -q --strict-markers\n');
      const report = await verifyDiff({
        repoRoot: root,
        trusted: true,
        unifiedDiff: DIFF,
        testCmd: 'python3 -m pytest -q',
      });
      expect(report.testScope.scope).toBe('full');
      expect(report.verdict).toBe('UNSAFE');
    },
    240_000,
  );
});
