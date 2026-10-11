// tests/unit/verify/pytest-config-sidecar.test.ts
//
// The pytest_config.py sidecar (#174) answers "which config does pytest use, and
// what does it say" with pytest's own code. A wrong answer is a false SAFE (a
// narrowing shape read as nothing) or a lost SAFE (a neighbouring table read as
// pytest's). Every failure must come back as `ok: false` with a reason.
//
// REFACTRON_TEST_PYTHON selects the interpreter, so the same rows can be run
// against pytest 6, 7, 8 and 9 installs.
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SIDECAR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/verify/checks/_py/pytest_config.py',
);
const PY = process.env.REFACTRON_TEST_PYTHON ?? 'python3';

function pytestVersion(): [number, number] | null {
  try {
    const out = execFileSync(PY, ['-c', 'import pytest; print(pytest.__version__)'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const [major, minor] = out
      .trim()
      .split('.')
      .map((p) => parseInt(p, 10));
    return [major ?? 0, minor ?? 0];
  } catch {
    return null;
  }
}
const VERSION = pytestVersion();
const NO_PYTEST = VERSION === null;
const PYTEST9 = VERSION !== null && VERSION[0] >= 9;
// `--config-file` and `.pytest.ini` arrived in pytest 7; 6.x reads neither.
const PYTEST7 = VERSION !== null && VERSION[0] >= 7;

interface Result {
  ok: boolean;
  config_file: string | null;
  addopts?: string[] | null;
  testpaths?: string[] | null;
  python_files?: string[] | null;
  error?: string;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pycfg-'));
  dirs.push(root);
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
  return root;
}

function run(
  root: string,
  args: string[] = ['-q'],
  opts: {
    envAddopts?: string;
    pyArgs?: string[];
    launcher?: string[];
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  } = {},
): Result & { exit: number | null } {
  const r = spawnSync(PY, opts.launcher ?? [...(opts.pyArgs ?? []), SIDECAR], {
    input: JSON.stringify({ root, args, env_addopts: opts.envAddopts ?? null }),
    encoding: 'utf8',
    cwd: opts.cwd ?? os.tmpdir(),
    env: opts.env ?? process.env,
  });
  return { ...(JSON.parse(r.stdout) as Result), exit: r.status };
}

describe('pytest_config.py reads what pytest reads (#174)', () => {
  // Every shape pytest reads as `-k fast` and the old line reader read as nothing.
  const NARROWING: ReadonlyArray<readonly [string, string, string]> = [
    [
      'multi-line TOML string',
      'pyproject.toml',
      '[tool.pytest.ini_options]\naddopts = """\n-k fast\n"""\n',
    ],
    [
      'comment after TOML header',
      'pyproject.toml',
      '[tool.pytest.ini_options]  # cfg\naddopts = "-k fast"\n',
    ],
    ['.pytest.ini', '.pytest.ini', '[pytest]\naddopts = -k fast\n'],
    [
      'continuation after --x=y',
      'pytest.ini',
      '[pytest]\naddopts =\n    --tb=short\n    -k fast\n',
    ],
    ['blank line inside a value', 'pytest.ini', '[pytest]\naddopts = -q\n\n    -k fast\n'],
    ['comment line inside a value', 'pytest.ini', '[pytest]\naddopts = -q\n# note\n    -k fast\n'],
    [
      'continuation starting with [',
      'pytest.ini',
      '[pytest]\nnorecursedirs =\n    [._]*\naddopts = -k fast\n',
    ],
    ['CR-only separators', 'tox.ini', '[tox]\renvlist = py\r[pytest]\raddopts = -k fast\r'],
    [
      'form-feed separator',
      'setup.cfg',
      '[metadata]\nname = x\x0c[tool:pytest]\naddopts = -k fast\n',
    ],
    ['\\x85 separator', 'setup.cfg', '[metadata]\nname = x\x85[tool:pytest]\naddopts = -k fast\n'],
    [
      'quoted top-level "tool" table',
      'pyproject.toml',
      '"tool" = { pytest = { ini_options = { addopts = "-k fast" } } }\n',
    ],
    [
      'quoted "tool" in a header',
      'pyproject.toml',
      '["tool".pytest.ini_options]\naddopts = "-k fast"\n',
    ],
    ['ini key with a colon', 'pytest.ini', '[pytest]\naddopts: -k fast\n'],
    ['TOML array', 'pyproject.toml', '[tool.pytest.ini_options]\naddopts = ["-k", "fast"]\n'],
  ];
  for (const [label, file, body] of NARROWING) {
    it.skipIf(NO_PYTEST || (file === '.pytest.ini' && !PYTEST7))(
      `reads addopts through ${label}`,
      () => {
        const r = run(repo({ [file]: body }));
        expect(r.ok).toBe(true);
        expect(r.config_file).toBe(file);
        expect(r.addopts?.slice(-2)).toEqual(['-k', 'fast']);
      },
    );
  }

  // Each of these is whole-suite to pytest; the old reader floored some of them.
  const BENIGN: ReadonlyArray<readonly [string, string, string, string[] | null]> = [
    [
      'a Poetry dependency',
      'pyproject.toml',
      '[tool.poetry.group.dev.dependencies]\npytest = "^8.0"\n',
      null,
    ],
    ['a pixi dependency', 'pyproject.toml', '[tool.pixi.dependencies]\npytest = "*"\n', null],
    [
      'a uv dev dependency',
      'pyproject.toml',
      '[tool.uv]\ndev-dependencies = ["pytest>=8"]\n',
      null,
    ],
    [
      'ruff banned-api',
      'pyproject.toml',
      '[tool.ruff.lint.flake8-tidy-imports.banned-api]\n"pytest.warns".msg = "no"\n',
      null,
    ],
    [
      'PEP 735 dependency-groups',
      'pyproject.toml',
      '[dependency-groups]\n"pytest" = ["pytest>=8"]\n',
      null,
    ],
    [
      '[tool.pytest_env]',
      'pyproject.toml',
      '[tool.pytest.ini_options]\naddopts = "-ra"\n\n[tool.pytest_env]\nFOO = "-k x"\n',
      ['-ra'],
    ],
    [
      '[tool.pytest-watcher]',
      'pyproject.toml',
      '[tool.pytest.ini_options]\naddopts = "-ra"\n\n[tool.pytest-watcher]\nnow = true\n',
      ['-ra'],
    ],
    [
      'commented-out TOML addopts',
      'pyproject.toml',
      '[tool.pytest.ini_options]\n# addopts = "-k x"\nminversion = "6.0"\n',
      null,
    ],
    [
      'commented-out ini addopts',
      'pytest.ini',
      '[pytest]\n# addopts = -k x\nminversion = 6.0\n',
      null,
    ],
    [
      'TOML array of --x=y items',
      'pyproject.toml',
      '[tool.pytest.ini_options]\naddopts = ["--tb=short", "--durations=5"]\n',
      ['--tb=short', '--durations=5'],
    ],
    [
      'black-style array, ] at column 0',
      'pyproject.toml',
      '[tool.pytest.ini_options]\naddopts = [\n    "-ra",\n    "--strict-markers",\n]\n',
      ['-ra', '--strict-markers'],
    ],
    [
      'addopts in a later table',
      'pyproject.toml',
      '[tool.pytest.ini_options]\nminversion = "6.0"\n\n[tool.other]\naddopts = "-k x"\n',
      null,
    ],
  ];
  for (const [label, file, body, addopts] of BENIGN) {
    it.skipIf(NO_PYTEST)(`reads ${label} as pytest does`, () => {
      const r = run(repo({ [file]: body }));
      expect(r.ok).toBe(true);
      expect(r.addopts ?? null).toEqual(addopts);
      expect(r.testpaths).toBeNull();
    });
  }

  it.skipIf(NO_PYTEST)('reports no config file when there is none', () => {
    const r = run(repo({ 'calc.py': '' }));
    expect(r).toMatchObject({ ok: true, config_file: null, addopts: null, testpaths: null });
  });

  it.skipIf(NO_PYTEST)('splits an ini value the way pytest does, with shlex', () => {
    const r = run(repo({ 'pytest.ini': '[pytest]\naddopts = -m "not slow" --tb=short\n' }));
    expect(r.addopts).toEqual(['-m', 'not slow', '--tb=short']);
  });

  it.skipIf(NO_PYTEST)('returns testpaths and python_files', () => {
    const r = run(
      repo({
        'setup.cfg':
          '[tool:pytest]\ntestpaths = tests/unit\n    tests/int\npython_files = check_*.py\n',
      }),
    );
    expect(r.testpaths).toEqual(['tests/unit', 'tests/int']);
    expect(r.python_files).toEqual(['check_*.py']);
  });

  it.skipIf(NO_PYTEST)('takes pytest.ini over pyproject.toml, as pytest does', () => {
    const r = run(
      repo({
        'pytest.ini': '[pytest]\naddopts = -k fast\n',
        'pyproject.toml': '[tool.pytest.ini_options]\naddopts = "-q"\n',
      }),
    );
    expect(r.config_file).toBe('pytest.ini');
    expect(r.addopts).toEqual(['-k', 'fast']);
  });

  it.skipIf(NO_PYTEST)('skips a tox.ini with no [pytest] section and reads setup.cfg', () => {
    const r = run(
      repo({
        'tox.ini': '[tox]\nenvlist = py\n',
        'setup.cfg': '[tool:pytest]\naddopts = -k fast\n',
      }),
    );
    expect(r.config_file).toBe('setup.cfg');
  });

  it.skipIf(NO_PYTEST)('refuses a config pytest would find outside the root', () => {
    const outer = repo({ 'pytest.ini': '[pytest]\naddopts = -k fast\n' });
    fs.mkdirSync(path.join(outer, 'repo'));
    const r = run(path.join(outer, 'repo'));
    expect(r).toMatchObject({ ok: false, config_file: null, error: 'outside-root' });
    expect(JSON.stringify(r)).not.toContain(outer);
  });

  it.skipIf(NO_PYTEST)('refuses it past an in-root file that is not a pytest config', () => {
    const outer = repo({ 'pytest.ini': '[pytest]\naddopts = -k fast\n' });
    fs.mkdirSync(path.join(outer, 'repo'));
    fs.writeFileSync(path.join(outer, 'repo', 'tox.ini'), '[tox]\nenvlist = py\n');
    const r = run(path.join(outer, 'repo'));
    expect(r).toMatchObject({ ok: false, config_file: null, error: 'outside-root' });
  });

  it.skipIf(NO_PYTEST)('does not look outside the root once a config is found inside', () => {
    const outer = repo({ 'pytest.ini': '[pytest]\naddopts = -k fast\n' });
    fs.mkdirSync(path.join(outer, 'repo'));
    fs.writeFileSync(path.join(outer, 'repo', 'pytest.ini'), '[pytest]\naddopts = -q\n');
    const r = run(path.join(outer, 'repo'));
    expect(r).toMatchObject({ ok: true, config_file: 'pytest.ini', addopts: ['-q'] });
  });
});

describe('pytest_config.py honours the command line (#174)', () => {
  const two = () =>
    repo({ 'pytest.ini': '[pytest]\naddopts = -q\n', 'ci.ini': '[pytest]\naddopts = -k fast\n' });

  it.skipIf(NO_PYTEST)('-c names the config file', () => {
    expect(run(two(), ['-q', '-c', 'ci.ini'])).toMatchObject({
      config_file: 'ci.ini',
      addopts: ['-k', 'fast'],
    });
    expect(run(two(), ['-cci.ini'])).toMatchObject({ config_file: 'ci.ini' });
  });

  it.skipIf(!PYTEST7)('--config-file names the config file', () => {
    expect(run(two(), ['--config-file=ci.ini'])).toMatchObject({ config_file: 'ci.ini' });
    expect(run(two(), ['--config-file', 'ci.ini'])).toMatchObject({ config_file: 'ci.ini' });
  });

  it.skipIf(NO_PYTEST)('PYTEST_ADDOPTS reaches config resolution, as pytest prepends it', () => {
    expect(run(two(), ['-q'], { envAddopts: '-c ci.ini' })).toMatchObject({
      config_file: 'ci.ini',
    });
  });

  it.skipIf(NO_PYTEST)('-o overrides the three keys, last one winning', () => {
    const r = run(two(), [
      '-o',
      'testpaths=a b',
      '-o',
      'addopts=-x',
      '-o',
      'addopts=-k z',
      '-opython_files=c_*.py',
    ]);
    expect(r).toMatchObject({
      addopts: ['-k', 'z'],
      testpaths: ['a', 'b'],
      python_files: ['c_*.py'],
    });
  });

  it.skipIf(NO_PYTEST)('--rootdir does not change which file is read', () => {
    const root = two();
    fs.mkdirSync(path.join(root, 'sub'));
    expect(run(root, ['--rootdir=sub'])).toMatchObject({ ok: true, config_file: 'pytest.ini' });
  });

  it.skipIf(NO_PYTEST)('a value flag pytest knows does not become a start directory', () => {
    // `--tb short`: pytest's own parser knows --tb takes a value.
    const root = two();
    fs.mkdirSync(path.join(root, 'short'));
    fs.writeFileSync(path.join(root, 'short', 'pytest.ini'), '[pytest]\naddopts = -k inner\n');
    expect(run(root, ['--tb', 'short'])).toMatchObject({ config_file: 'pytest.ini' });
  });
});

describe('pytest 9 config formats (#174)', () => {
  it.skipIf(!PYTEST9)('pytest 9 reads pytest.toml first', () => {
    // Values agree with pytest.ini, so no older generation would read otherwise.
    const r = run(
      repo({
        'pytest.toml': '[pytest]\naddopts = ["-k", "fast"]\n',
        'pytest.ini': '[pytest]\naddopts = -k fast\n',
      }),
    );
    expect(r).toMatchObject({ ok: true, config_file: 'pytest.toml', addopts: ['-k', 'fast'] });
    // A pytest.ini that disagrees would be read by pytest 8: refused.
    const skew = run(
      repo({
        'pytest.toml': '[pytest]\naddopts = ["-k", "fast"]\n',
        'pytest.ini': '[pytest]\naddopts = -q\n',
      }),
    );
    expect(skew).toMatchObject({ ok: false, error: 'version-dependent' });
  });

  it.skipIf(!PYTEST9)('pytest 9 reads .pytest.toml and a native [tool.pytest] table', () => {
    expect(run(repo({ '.pytest.toml': '[pytest]\ntestpaths = ["t"]\n' }))).toMatchObject({
      testpaths: ['t'],
    });
    expect(
      run(repo({ 'pyproject.toml': '[tool.pytest]\naddopts = ["-k", "fast"]\n' })),
    ).toMatchObject({ config_file: 'pyproject.toml', addopts: ['-k', 'fast'] });
  });

  it.skipIf(!PYTEST9)(
    'pytest 9 rejects a string where native TOML wants a list, and so do we',
    () => {
      const r = run(repo({ 'pytest.toml': '[pytest]\naddopts = "-k fast"\n' }));
      expect(r.ok).toBe(false);
      expect(r.config_file).toBe('pytest.toml');
    },
  );

  // Skipped under pytest 9, which reads these: the rows above cover it there.
  it.skipIf(NO_PYTEST || PYTEST9)('an older pytest fails closed on pytest 9 formats', () => {
    for (const [file, body] of [
      ['pytest.toml', '[pytest]\naddopts = ["-q"]\n'],
      ['.pytest.toml', '[pytest]\naddopts = ["-q"]\n'],
      ['pyproject.toml', '[tool.pytest]\naddopts = ["-q"]\n'],
    ] as const) {
      const r = run(repo({ [file]: body, 'pytest.ini': '[pytest]\naddopts = -q\n' }));
      expect(r.ok).toBe(false);
      expect(r.config_file).toBe(file);
      expect(r.error).toBe('pytest9-format');
    }
  });
});

describe('pytest_config.py fails closed, with a reason (#174)', () => {
  const FAILS: ReadonlyArray<readonly [string, Record<string, string>, string[], string]> = [
    [
      'a TOML syntax error',
      { 'pyproject.toml': '[tool.pytest.ini_options\naddopts = "-k"\n' },
      [],
      'pyproject.toml',
    ],
    ['an ini syntax error', { 'tox.ini': 'garbage\n[pytest]\n' }, [], 'tox.ini'],
    [
      'an unclosed quote in addopts',
      { 'pytest.ini': '[pytest]\naddopts = "-k\n' },
      [],
      'pytest.ini',
    ],
    [
      'a [pytest] section in setup.cfg',
      { 'setup.cfg': '[pytest]\naddopts = -q\n' },
      [],
      'setup.cfg',
    ],
    ['a malformed -o', { 'pytest.ini': '[pytest]\n' }, ['-o', 'novalue'], 'pytest.ini'],
    [
      'a --rootdir that does not exist',
      { 'pytest.ini': '[pytest]\n' },
      ['--rootdir=nope'],
      'pytest.ini',
    ],
  ];
  for (const [label, files, args, file] of FAILS) {
    it.skipIf(NO_PYTEST)(`${label}`, () => {
      const r = run(repo(files), args);
      expect(r.exit).toBe(0);
      expect(r.ok).toBe(false);
      expect(r.config_file).toBe(file);
      expect(['config-syntax', 'bad-value', 'bad-option']).toContain(r.error);
    });
  }

  it.skipIf(NO_PYTEST)('a -c that climbs out of the repository', () => {
    const r = run(repo({ 'pytest.ini': '[pytest]\n' }), ['-c', '../elsewhere.ini']);
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toBe('bad-option');
  });

  it.skipIf(NO_PYTEST)('a request that is not JSON exits 2 with a reason', () => {
    const r = spawnSync(PY, [SIDECAR], { input: 'not json', encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false });
  });

  it.skipIf(NO_PYTEST)('no pytest and no iniconfig importable', () => {
    // -I -S: no site-packages at all.
    const r = run(repo({ 'pytest.ini': '[pytest]\naddopts = -q\n' }), ['-q'], {
      pyArgs: ['-I', '-S'],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('pytest-not-importable');
  });
});

describe('the fallback reader, when pytest cannot be asked (#174)', () => {
  // No site-packages, only iniconfig: pytest's own code is unavailable. Inserted
  // by a launcher, since the sidecar drops PYTHONPATH entries on purpose.
  function onlyIniconfig(): string[] {
    const site = execFileSync(
      PY,
      ['-c', 'import iniconfig, os; print(os.path.dirname(os.path.dirname(iniconfig.__file__)))'],
      { encoding: 'utf8' },
    ).trim();
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'pycfg-ini-'));
    dirs.push(isolated);
    fs.symlinkSync(path.join(site, 'iniconfig'), path.join(isolated, 'iniconfig'));
    const program =
      `import runpy, sys; sys.path.insert(0, ${JSON.stringify(isolated)}); ` +
      `runpy.run_path(${JSON.stringify(SIDECAR)}, run_name="__main__")`;
    return ['-S', '-c', program];
  }

  it.skipIf(NO_PYTEST)('answers when every pytest generation agrees', () => {
    const r = run(repo({ 'pytest.ini': '[pytest]\naddopts = -k fast\n' }), ['-q'], {
      launcher: onlyIniconfig(),
    });
    expect(r).toMatchObject({ ok: true, config_file: 'pytest.ini', addopts: ['-k', 'fast'] });
  });

  it.skipIf(NO_PYTEST)('refuses a config found outside the root', () => {
    const outer = repo({ 'pytest.ini': '[pytest]\naddopts = -k fast\n' });
    fs.mkdirSync(path.join(outer, 'repo'));
    const r = run(path.join(outer, 'repo'), ['-q'], { launcher: onlyIniconfig() });
    expect(r).toMatchObject({ ok: false, config_file: null, error: 'outside-root' });
  });

  it.skipIf(NO_PYTEST)('refuses when the answer depends on the pytest version', () => {
    const r = run(
      repo({
        '.pytest.ini': '[pytest]\naddopts = -q\n',
        'pyproject.toml': '[tool.pytest.ini_options]\naddopts = "-k fast"\n',
      }),
      ['-q'],
      { launcher: onlyIniconfig() },
    );
    expect(r.ok).toBe(false);
    // Below Python 3.11 the isolated path has no TOML parser: refused either way.
    expect(['version-dependent', 'pytest-not-importable']).toContain(r.error);
  });
});

describe('pytest_config.py runs no project code (#174)', () => {
  it.skipIf(NO_PYTEST)('never imports conftest.py or a module shadowing its own', () => {
    const marker = (name: string) =>
      `import pathlib; pathlib.Path(__file__).with_name('${name}.ran').write_text('x')\n`;
    const root = repo({
      'pytest.ini': '[pytest]\naddopts = -q\n',
      'conftest.py': marker('conftest'),
      'iniconfig.py': marker('iniconfig'),
      'tomllib.py': marker('tomllib'),
      'tomli.py': marker('tomli'),
    });
    // Worst case: spawned from inside the repository with `.` on PYTHONPATH.
    const r = run(root, ['-q'], { cwd: root, env: { ...process.env, PYTHONPATH: '.' } });
    expect(r.ok).toBe(true);
    expect(fs.readdirSync(root).filter((f) => f.endsWith('.ran'))).toEqual([]);
  });
});

// Review of #174. The interpreter running the tests is found on a best-effort
// basis, so an answer that would differ under another pytest generation is
// refused rather than trusted.
describe('pytest_config.py refuses an answer that depends on the pytest version', () => {
  it.skipIf(NO_PYTEST)('pytest.toml against a narrowing pyproject.toml', () => {
    const r = run(
      repo({
        'pytest.toml': '[pytest]\naddopts = ["-q"]\n',
        'pyproject.toml': '[tool.pytest.ini_options]\naddopts = "-k fast"\n',
      }),
    );
    expect(r).toMatchObject({ ok: false });
    expect(['version-dependent', 'pytest9-format']).toContain(r.error);
  });

  it.skipIf(NO_PYTEST)(
    '.pytest.ini, which pytest 6 skips, against a narrowing pyproject.toml',
    () => {
      const r = run(
        repo({
          '.pytest.ini': '[pytest]\naddopts = -q\n',
          'pyproject.toml': '[tool.pytest.ini_options]\naddopts = "-k fast"\n',
        }),
      );
      expect(r).toMatchObject({ ok: false, error: 'version-dependent' });
    },
  );

  it.skipIf(NO_PYTEST)('a native [tool.pytest] table over a narrowing setup.cfg', () => {
    const r = run(
      repo({
        'pyproject.toml': '[tool.pytest]\naddopts = ["-q"]\n',
        'setup.cfg': '[tool:pytest]\naddopts = -k fast\n',
      }),
    );
    expect(r.ok).toBe(false);
    expect(['version-dependent', 'pytest9-format']).toContain(r.error);
  });

  it.skipIf(NO_PYTEST)('accepts a generation that reads nothing: it cannot narrow', () => {
    // pytest 6 does not read .pytest.ini, so it would run with no config at all.
    const r = run(repo({ '.pytest.ini': '[pytest]\naddopts = -k fast\n' }));
    if (PYTEST7) expect(r).toMatchObject({ ok: true, addopts: ['-k', 'fast'] });
    else expect(r).toMatchObject({ ok: false, error: 'version-dependent' });
  });

  it.skipIf(NO_PYTEST)('accepts files that differ only in name when the values agree', () => {
    const r = run(
      repo({
        'pytest.ini': '[pytest]\naddopts = -q\n',
        'setup.cfg': '[tool:pytest]\naddopts = -q\n',
      }),
    );
    expect(r).toMatchObject({ ok: true, config_file: 'pytest.ini' });
  });

  it.skipIf(NO_PYTEST)('has no adapter for a pytest newer than 9 in the fallback', () => {
    const program =
      `import runpy, json; m = runpy.run_path(${JSON.stringify(SIDECAR)}); ` +
      'R = m["Refusal"]\n' +
      'try:\n    m["generation_for"]("10.0"); print("accepted")\n' +
      'except R as e:\n    print(e.reason)';
    const out = execFileSync(PY, ['-c', program], { encoding: 'utf8' }).trim();
    expect(out).toBe('unsupported-pytest');
  });
});

describe('pytest_config.py guards (#174 review)', () => {
  it.skipIf(NO_PYTEST)(
    "uses pytest's own resolution for the installed pytest, not the fallback",
    () => {
      // A pytest upgrade that changes determine_setup must fail here, not slip
      // silently onto the fallback.
      const r = run(repo({ 'pytest.ini': '[pytest]\naddopts = -q\n' })) as Result & {
        resolver?: string;
      };
      expect(r.resolver).toBe('pytest');
    },
  );

  it.skipIf(NO_PYTEST)('refuses an @file argument, which pytest >= 8.2 would expand', () => {
    const root = repo({ 'pytest.ini': '[pytest]\n', 'args.txt': '-c ci.ini\n' });
    expect(run(root, ['-q', '@args.txt'])).toMatchObject({ ok: false, error: 'argument-file' });
    expect(run(root, ['-q'], { envAddopts: '@args.txt' })).toMatchObject({
      error: 'argument-file',
    });
  });

  it.skipIf(NO_PYTEST)('refuses a relative root', () => {
    const r = spawnSync(PY, [SIDECAR], {
      input: JSON.stringify({ root: '.', args: [] }),
      encoding: 'utf8',
    });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: 'relative-root' });
  });

  it.skipIf(NO_PYTEST)('never echoes config content or a host path in a refusal', () => {
    const token = 'ghp_FAKEtoken0123456789abcdefFAKE';
    const root = repo({ 'tox.ini': `${token} = oops\nnot a line\n[pytest]\n` });
    const r = run(root);
    const raw = JSON.stringify(r);
    expect(r).toMatchObject({ ok: false, config_file: 'tox.ini', error: 'config-syntax' });
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(root);
  });

  it.skipIf(NO_PYTEST)('names an absolute -c outside the root by its basename only', () => {
    const outside = repo({ 'ci.ini': '[pytest]\naddopts = -k fast\n' });
    const r = run(repo({}), ['-c', path.join(outside, 'ci.ini')]);
    expect(r).toMatchObject({ ok: true, config_file: 'ci.ini', addopts: ['-k', 'fast'] });
  });
});
