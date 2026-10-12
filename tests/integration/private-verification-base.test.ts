// Where verification copies are created, end to end. A copy is only created
// under a directory owned by this user with no group- or world-writable
// directory above it. TMPDIR here points at a world-writable directory holding a
// pytest.ini and a conftest.py; the copy must go elsewhere and neither file may
// apply to the run.
//
// This file imports nothing from the base-selection module, so it runs
// unchanged against any version of the engine.
import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { verifyDiff } from '../../src/verify/verify-diff.js';
import type { VerdictReport } from '../../src/verify/verdict-fuse.js';

function hasPythonTooling(): boolean {
  try {
    execSync('python3 -c "import coverage, pytest"', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const WIN = process.platform === 'win32';
const NO_PYTHON = !hasPythonTooling() || WIN;

const ENV_KEYS = ['TMPDIR', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'REFACTRON_VERIFY_BASE'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const dirs: string[] = [];
afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of dirs.splice(0)) {
    await fs.chmod(d, 0o700).catch(() => {});
    await fs.rm(d, { recursive: true, force: true });
  }
});

// test_add_correct catches the change; test_smoke only executes the line, so
// coverage is complete either way.
const DIFF = [
  '--- a/pkg/calc.py',
  '+++ b/pkg/calc.py',
  '@@ -1,2 +1,2 @@',
  ' def add(a, b):',
  '-    return a + b',
  '+    return a - b',
  '',
].join('\n');

async function tracked(p: Promise<string>): Promise<string> {
  const d = await p;
  dirs.push(d);
  return d;
}

async function buildRepo(): Promise<string> {
  const root = await tracked(fs.mkdtemp(path.join(os.tmpdir(), 'repo-')));
  await fs.mkdir(path.join(root, 'pkg'));
  await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(path.join(root, 'pyproject.toml'), '[project]\nname = "x"\n');
  await fs.writeFile(path.join(root, 'pkg', '__init__.py'), '');
  await fs.writeFile(path.join(root, 'pkg', 'calc.py'), 'def add(a, b):\n    return a + b\n');
  await fs.writeFile(
    path.join(root, 'tests', 'conftest.py'),
    'import sys, os\nsys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))\n',
  );
  await fs.writeFile(
    path.join(root, 'tests', 'test_calc.py'),
    'from pkg.calc import add\n\n\n' +
      'def test_smoke():\n    add(1, 2)\n\n\n' +
      'def test_add_correct():\n    assert add(2, 3) == 5\n',
  );
  return root;
}

const verify = (repoRoot: string): Promise<VerdictReport> =>
  verifyDiff({ repoRoot, trusted: true, unifiedDiff: DIFF, testCmd: 'python3 -m pytest -q' });

describe('where verification copies are created', () => {
  it.skipIf(NO_PYTHON)(
    'not under a world-writable TMPDIR: its pytest.ini and conftest.py do not apply',
    async () => {
      // Created before TMPDIR moves, under the runner's own temp directory.
      const ownTmp = os.tmpdir();
      const open = await tracked(fs.mkdtemp(path.join(ownTmp, 'open-tmp-')));
      await fs.chmod(open, 0o777);
      const marker = path.join(open, 'conftest-ran');
      await fs.writeFile(
        path.join(open, 'pytest.ini'),
        '[pytest]\naddopts = -k "not test_add_correct"\n',
      );
      await fs.writeFile(
        path.join(open, 'conftest.py'),
        `open(${JSON.stringify(marker)}, "w").write("x")\n`,
      );
      const xdgCache = await tracked(fs.mkdtemp(path.join(ownTmp, 'xdg-cache-')));
      const repo = await buildRepo();

      process.env.TMPDIR = open;
      process.env.XDG_CACHE_HOME = xdgCache;
      delete process.env.XDG_RUNTIME_DIR;
      delete process.env.REFACTRON_VERIFY_BASE;

      const report = await verify(repo);
      expect(existsSync(marker)).toBe(false);
      expect(report.verdict).toBe('UNSAFE');
      expect(report.reason).toContain('test_add_correct');
    },
    240_000,
  );

  it.skipIf(WIN)(
    'ends UNPROVEN, without crashing, when no private directory can be made',
    async () => {
      const repo = await buildRepo();
      const open = await tracked(fs.mkdtemp(path.join(os.tmpdir(), 'open-')));
      await fs.chmod(open, 0o777);
      process.env.REFACTRON_VERIFY_BASE = open;

      const report = await verify(repo);
      expect(report.verdict).toBe('UNPROVEN');
      expect(report.reason).toMatch(
        /^could not create a private directory for the verification copy/,
      );
      expect(report.coverage.tool).toBe('none');
      expect(report.coverage.changedLinesCovered).toBe('unknown');
      expect(report.testScope.scope).toBe('unknown');
    },
    120_000,
  );
});
