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

// Issue #174. Valid pytest config that the old line reader misread as "no
// narrowing". pytest itself reads each of these as `-k test_a`, so test_b, the
// only test that catches the change, never runs. Each row was SAFE on main.
describe('config pytest reads as narrowing cannot earn SAFE, whatever its shape (#174)', () => {
  const MISREAD: ReadonlyArray<readonly [string, string, string]> = [
    [
      'a multi-line TOML addopts string',
      'pyproject.toml',
      '[tool.pytest.ini_options]\naddopts = """\n-k test_a\n"""\n',
    ],
    [
      'a comment after the TOML section header',
      'pyproject.toml',
      '[tool.pytest.ini_options]  # cfg\naddopts = "-k test_a"\n',
    ],
    ['.pytest.ini', '.pytest.ini', '[pytest]\naddopts = -k test_a\n'],
    [
      'an ini continuation after a --x=y line',
      'pytest.ini',
      '[pytest]\naddopts =\n    --tb=short\n    -k test_a\n',
    ],
    ['a blank line inside an ini value', 'pytest.ini', '[pytest]\naddopts = -q\n\n    -k test_a\n'],
    [
      'a comment line inside an ini value',
      'pytest.ini',
      '[pytest]\naddopts = -q\n# keep CI fast\n    -k test_a\n',
    ],
    [
      'an ini continuation line starting with [',
      'pytest.ini',
      '[pytest]\nnorecursedirs =\n    [._]*\n    build\naddopts = -k test_a\n',
    ],
    ['CR-only line endings', 'tox.ini', '[tox]\renvlist = py\r[pytest]\raddopts = -k test_a\r'],
    [
      'a form-feed line separator',
      'setup.cfg',
      '[metadata]\nname = x\x0c[tool:pytest]\naddopts = -k test_a\n',
    ],
    [
      'a \\x85 line separator',
      'setup.cfg',
      '[metadata]\nname = x\x85[tool:pytest]\naddopts = -k test_a\n',
    ],
    [
      'a quoted top-level "tool" inline table',
      'pyproject.toml',
      '"tool" = { pytest = { ini_options = { addopts = "-k test_a" } } }\n',
    ],
    [
      'a quoted "tool" key in the table header',
      'pyproject.toml',
      '["tool".pytest.ini_options]\naddopts = "-k test_a"\n',
    ],
  ];

  for (const [label, file, body] of MISREAD) {
    it.skipIf(NO_PYTHON)(
      `refuses SAFE for ${label}`,
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
        expect(report.testScope.signals.join(' ')).toContain(file);
      },
      240_000,
    );
  }

  it.skipIf(NO_PYTHON)(
    'reads the config named by -c in the command',
    async () => {
      const root = await fixture('ci.ini', '[pytest]\naddopts = -k test_a\n');
      const report = await verifyDiff({
        repoRoot: root,
        trusted: true,
        unifiedDiff: DIFF,
        testCmd: 'python3 -m pytest -q -c ci.ini',
      });
      expect(report.verdict).not.toBe('SAFE');
      expect(report.testScope.scope).toBe('narrowed');
      expect(report.testScope.signals.join(' ')).toContain('ci.ini');
    },
    240_000,
  );
});

// The failure mode of the fix: config that narrows nothing must not floor. The
// change is harmless, test_b still runs and passes, so SAFE is the right answer.
describe('config that narrows nothing keeps its SAFE (#174)', () => {
  const HARMLESS = [
    '--- a/calc.py',
    '+++ b/calc.py',
    '@@ -1,2 +1,2 @@',
    ' def add(a, b):',
    '-    return a + b',
    '+    return b + a',
    '',
  ].join('\n');

  const BENIGN: ReadonlyArray<readonly [string, string, string]> = [
    [
      'a Poetry dependency line naming pytest',
      'pyproject.toml',
      '[tool.poetry]\nname = "calc"\nversion = "0.1.0"\n\n[tool.poetry.group.dev.dependencies]\npytest = "^8.0"\n\n[tool.pytest.ini_options]\nminversion = "7.0"\n',
    ],
    [
      'a ruff banned-api entry for pytest.warns',
      'pyproject.toml',
      '[tool.ruff.lint.flake8-tidy-imports.banned-api]\n"pytest.warns".msg = "use our helper"\n\n[tool.pytest.ini_options]\naddopts = "-ra"\n',
    ],
    [
      'a [tool.pytest_env] neighbour table',
      'pyproject.toml',
      '[tool.pytest.ini_options]\naddopts = "-ra"\n\n[tool.pytest_env]\nFOO = "bar"\n',
    ],
    [
      'a commented-out addopts',
      'pytest.ini',
      '[pytest]\n# addopts = -k test_a\nminversion = 7.0\n',
    ],
    [
      'a black-style addopts array with --x=y items',
      'pyproject.toml',
      '[tool.pytest.ini_options]\naddopts = [\n    "--tb=short",\n    "--strict-markers",\n]\n',
    ],
  ];

  for (const [label, file, body] of BENIGN) {
    it.skipIf(NO_PYTHON)(
      `keeps SAFE with ${label}`,
      async () => {
        const root = await fixture(file, body);
        const report = await verifyDiff({
          repoRoot: root,
          trusted: true,
          unifiedDiff: HARMLESS,
          testCmd: 'python3 -m pytest -q',
        });
        expect(report.testScope.scope).toBe('full');
        expect(report.verdict).toBe('SAFE');
      },
      240_000,
    );
  }
});

function hasPytest9(): boolean {
  try {
    const v = execSync('python3 -c "import pytest; print(pytest.__version__)"', {
      encoding: 'utf8',
    });
    return parseInt(v, 10) >= 9;
  } catch {
    return false;
  }
}

// Review of #174. The scope must be judged on the config the tests gate actually
// runs with: the shadow tree, after the diff, from an absolute root.
describe('the config judged is the config the suite runs with (#174 review)', () => {
  const verify = (repoRoot: string, testCmd = 'python3 -m pytest -q', diff = DIFF) =>
    verifyDiff({ repoRoot, trusted: true, unifiedDiff: diff, testCmd });
  const NARROWING_PYPROJECT = '[tool.pytest.ini_options]\naddopts = "-k test_a"\n';

  it.skipIf(NO_PYTHON)(
    'reads the config when repoRoot is relative',
    async () => {
      const root = await fixture('pytest.ini', '[pytest]\naddopts = -k test_a\n');
      const cwd = process.cwd();
      process.chdir(root);
      try {
        const report = await verify('.');
        expect(report.verdict).not.toBe('SAFE');
        expect(report.testScope.scope).toBe('narrowed');
      } finally {
        process.chdir(cwd);
      }
    },
    240_000,
  );

  it.skipIf(NO_PYTHON)(
    'ignores a pytest.ini symlinked from outside the repository, as the suite does',
    async () => {
      const root = await fixture('pyproject.toml', NARROWING_PYPROJECT);
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-outside-'));
      roots.push(outside);
      await fs.writeFile(path.join(outside, 'pytest.ini'), '[pytest]\naddopts = -q\n');
      await fs.symlink(path.join(outside, 'pytest.ini'), path.join(root, 'pytest.ini'));
      const report = await verify(root);
      expect(report.verdict).not.toBe('SAFE');
      expect(report.testScope.scope).toBe('narrowed');
    },
    240_000,
  );

  it.skipIf(NO_PYTHON)(
    'ignores a pytest.ini symlinked into build/, which the suite never sees',
    async () => {
      const root = await fixture('pyproject.toml', NARROWING_PYPROJECT);
      await fs.mkdir(path.join(root, 'build'));
      await fs.writeFile(path.join(root, 'build', 'pytest.ini'), '[pytest]\naddopts = -q\n');
      await fs.symlink('build/pytest.ini', path.join(root, 'pytest.ini'));
      const report = await verify(root);
      expect(report.verdict).not.toBe('SAFE');
      expect(report.testScope.scope).toBe('narrowed');
    },
    240_000,
  );

  it.skipIf(NO_PYTHON)(
    'reads the config as the diff leaves it',
    async () => {
      const root = await fixture('pytest.ini', '[pytest]\naddopts = -q\n');
      const addsFilter = [
        DIFF,
        '--- a/pytest.ini',
        '+++ b/pytest.ini',
        '@@ -1,2 +1,2 @@',
        ' [pytest]',
        '-addopts = -q',
        '+addopts = -k test_a',
        '',
      ].join('\n');
      const report = await verify(root, 'python3 -m pytest -q', addsFilter);
      expect(report.verdict).not.toBe('SAFE');
      expect(report.testScope.scope).toBe('narrowed');
      expect(report.testScope.signals.join(' ')).toContain('pytest.ini');
    },
    240_000,
  );

  it.skipIf(NO_PYTHON)(
    'judges config for the py.test spelling too',
    async () => {
      const root = await fixture('pytest.ini', '[pytest]\naddopts = -k test_a\n');
      const report = await verify(root, 'PYTHONPATH=. py.test -q');
      expect(report.verdict).not.toBe('SAFE');
      expect(report.testScope.scope).toBe('narrowed');
    },
    240_000,
  );

  it.skipIf(NO_PYTHON)(
    'refuses a config argument the shell would expand',
    async () => {
      const root = await fixture('ci.ini', '[pytest]\naddopts = -k test_a\n');
      process.env.REFACTRON_TEST_CFG = 'ci.ini';
      try {
        const report = await verify(root, 'python3 -m pytest -q -c $REFACTRON_TEST_CFG');
        expect(report.verdict).not.toBe('SAFE');
        expect(report.testScope.scope).toBe('narrowed');
        expect(report.testScope.signals.join(' ')).toMatch(/could not be read/);
      } finally {
        delete process.env.REFACTRON_TEST_CFG;
      }
    },
    240_000,
  );

  it.skipIf(NO_PYTHON)(
    'judges PYTEST_ADDOPTS as the suite receives it, after secret redaction',
    async () => {
      // The gate drops a value shaped like a token, so the suite runs whole and
      // catches the break; reading the raw value would claim a narrowed run.
      const root = await fixture(null, '');
      process.env.PYTEST_ADDOPTS = 'ghp_FAKE0123456789abcdef -k test_a';
      try {
        const report = await verify(root);
        expect(report.verdict).toBe('UNSAFE');
        expect(report.testScope.scope).toBe('full');
      } finally {
        delete process.env.PYTEST_ADDOPTS;
      }
    },
    240_000,
  );

  it.skipIf(NO_PYTHON || hasPytest9())(
    'fails closed end to end when the config cannot be read (a pytest 9 file, pytest 8)',
    async () => {
      // pytest 8 ignores pytest.toml and runs the whole suite; with a harmless
      // change that would be SAFE. We cannot know which pytest the project
      // expects, so the read is refused and the verdict caps.
      const root = await fixture('pytest.toml', '[pytest]\naddopts = ["-k", "test_a"]\n');
      const harmless = DIFF.replace('+    return a - b', '+    return b + a');
      const report = await verify(root, 'python3 -m pytest -q', harmless);
      expect(report.testScope.scope).toBe('narrowed');
      expect(report.testScope.signals.join(' ')).toMatch(/pytest\.toml could not be read/);
      expect(report.verdict).toBe('UNPROVEN');
    },
    240_000,
  );
});

// Moves to `full` that are correct, each proven with the control shape: the
// breaking change is caught (UNSAFE) because pytest really runs test_b.
describe('config that pytest reads as whole-suite reads full (#174 review)', () => {
  const CASES: ReadonlyArray<readonly [string, Record<string, string>]> = [
    [
      'an empty testpaths list',
      { 'pyproject.toml': '[tool.pytest.ini_options]\ntestpaths = []\n' },
    ],
    [
      'a narrowing setup.cfg that pytest.ini outranks',
      {
        'pytest.ini': '[pytest]\naddopts = -q\n',
        'setup.cfg': '[tool:pytest]\naddopts = -k test_a\n',
      },
    ],
  ];
  for (const [label, files] of CASES) {
    it.skipIf(NO_PYTHON)(
      `${label}: test_b runs, so the break is caught`,
      async () => {
        const root = await fixture(null, '');
        for (const [name, body] of Object.entries(files)) {
          await fs.writeFile(path.join(root, name), body);
        }
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
  }
});
