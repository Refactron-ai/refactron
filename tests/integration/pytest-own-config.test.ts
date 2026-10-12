// The run in the copy uses exactly the pytest config and conftest.py files
// pytest itself would pick for the repository: no config replaced, none added.
import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { verifyDiff } from '../../src/verify/verify-diff.js';

function pytestMajor(): number | null {
  try {
    const out = execSync('python3 -c "import coverage, pytest; print(pytest.__version__)"', {
      encoding: 'utf8',
    });
    return Number(out.trim().split('.')[0]);
  } catch {
    return null;
  }
}
const MAJOR = pytestMajor();
const WIN = process.platform === 'win32';
const NO_PYTHON = MAJOR === null || WIN;
const NO_PYTEST9 = NO_PYTHON || (MAJOR ?? 0) < 9;

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

const MOD = 'def add(a, b):\n    """\n    >>> add(2, 3)\n    5\n    """\n    return a + b\n';
const DIFF = [
  '--- a/mod.py',
  '+++ b/mod.py',
  '@@ -3,4 +3,4 @@',
  '     >>> add(2, 3)',
  '     5',
  '     """',
  '-    return a + b',
  '+    return a - b',
  '',
].join('\n');

async function verdictFor(pyproject: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'own-config-'));
  dirs.push(root);
  await fs.writeFile(path.join(root, 'pyproject.toml'), pyproject);
  await fs.writeFile(path.join(root, 'mod.py'), MOD);
  await fs.writeFile(
    path.join(root, 'test_mod.py'),
    'from mod import add\n\n\ndef test_smoke():\n    add(1, 2)\n',
  );
  return verifyDiff({
    repoRoot: root,
    trusted: true,
    unifiedDiff: DIFF,
    testCmd: 'python3 -m pytest -q',
  });
}

describe('the repository’s own pytest config applies in the copy', () => {
  it.skipIf(NO_PYTHON)(
    '[tool.pytest.ini_options] table',
    async () => {
      const r = await verdictFor('[tool.pytest.ini_options]\naddopts = "--doctest-modules"\n');
      expect(r.verdict).toBe('UNSAFE');
      expect(r.reason).toContain('mod.add');
    },
    240_000,
  );

  it.skipIf(NO_PYTHON)(
    'dotted keys under [tool]',
    async () => {
      const r = await verdictFor('[tool]\npytest.ini_options.addopts = "--doctest-modules"\n');
      expect(r.verdict).toBe('UNSAFE');
      expect(r.reason).toContain('mod.add');
    },
    240_000,
  );

  it.skipIf(NO_PYTEST9)(
    'pytest 9 [tool.pytest] table',
    async () => {
      const r = await verdictFor('[tool.pytest]\naddopts = ["--doctest-modules"]\n');
      expect(r.verdict).toBe('UNSAFE');
      expect(r.reason).toContain('mod.add');
    },
    240_000,
  );
});

describe('conftest.py loading matches pytest’s own cutoff', () => {
  // The config lives in tests/, so pytest stops loading conftest.py at tests/
  // and the root conftest.py (which drops test_bad) never applies.
  it.skipIf(NO_PYTHON)(
    'a root conftest.py outside the cutoff does not hide a failing test',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'own-cutoff-'));
      dirs.push(root);
      await fs.mkdir(path.join(root, 'tests'));
      await fs.writeFile(path.join(root, 'app.py'), 'def f():\n    return 1\n');
      await fs.writeFile(path.join(root, 'tests', 'pytest.ini'), '[pytest]\naddopts = -q\n');
      await fs.writeFile(
        path.join(root, 'tests', 'test_app.py'),
        'from app import f\n\n\ndef test_good():\n    assert f() in (1, 2)\n\n\n' +
          'def test_bad():\n    assert f() == 1\n',
      );
      await fs.writeFile(
        path.join(root, 'conftest.py'),
        'def pytest_collection_modifyitems(config, items):\n' +
          '    items[:] = [i for i in items if "test_bad" not in i.nodeid]\n',
      );
      const r = await verifyDiff({
        repoRoot: root,
        trusted: true,
        unifiedDiff: [
          '--- a/app.py',
          '+++ b/app.py',
          '@@ -1,2 +1,2 @@',
          ' def f():',
          '-    return 1',
          '+    return 2',
          '',
        ].join('\n'),
        testCmd: 'python3 -m pytest -c tests/pytest.ini',
      });
      expect(r.verdict).toBe('UNSAFE');
      expect(r.reason).toContain('test_bad');
    },
    240_000,
  );
});
