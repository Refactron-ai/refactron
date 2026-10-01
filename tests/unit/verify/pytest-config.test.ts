// tests/unit/verify/pytest-config.test.ts
//
// The TypeScript side of the pytest config sidecar (#174). Every way the read
// can fail must reach assessTestScope as `narrowed` with a "could not be read"
// signal: an empty answer read as "no narrowing" is a false SAFE.
import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parsePytestConfigOutput } from '../../../src/verify/pytest-config.js';
import { readPytestContext } from '../../../src/verify/verify-diff.js';
import { assessTestScope } from '../../../src/verify/test-scope.js';
import { testCommandInterpreter } from '../../../src/analyze/coverage/python-line-coverage.js';

function hasPytest(): boolean {
  try {
    execSync('python3 -c "import pytest"', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const NO_PYTEST = !hasPytest();
const WINDOWS = process.platform === 'win32';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pycfg-ts-'));
  dirs.push(root);
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
  return root;
}

/** A stand-in interpreter: a shell script that ignores its arguments. */
function fakePython(body: string): string {
  const dir = tmp();
  const bin = path.join(dir, 'python');
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

const CMD = 'python3 -m pytest -q';
const scopeWith = async (root: string, pythonBin: string, timeoutMs?: number) =>
  assessTestScope(
    CMD,
    {},
    undefined,
    await readPytestContext(root, CMD, {}, [], {
      pythonBin,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    }),
  );

describe('parsePytestConfigOutput accepts only the contract (#174)', () => {
  it('reads a well-formed answer', () => {
    expect(
      parsePytestConfigOutput(
        JSON.stringify({
          ok: true,
          config_file: 'pytest.ini',
          addopts: ['-k', 'x'],
          testpaths: null,
          python_files: null,
        }),
      ),
    ).toEqual({
      ok: true,
      file: 'pytest.ini',
      addopts: ['-k', 'x'],
      testpaths: null,
      pythonFiles: null,
    });
  });

  it('turns the sidecar reason class into text and keeps the file', () => {
    expect(
      parsePytestConfigOutput('{"ok": false, "config_file": "tox.ini", "error": "config-syntax"}'),
    ).toEqual({ ok: false, file: 'tox.ini', reason: 'pytest cannot parse it' });
  });

  it('never passes free text or a host path through', () => {
    const leaky = parsePytestConfigOutput(
      JSON.stringify({ ok: false, config_file: '/home/u/secret/ci.ini', error: 'token=abc123' }),
    );
    expect(leaky).toEqual({
      ok: false,
      file: 'ci.ini',
      reason: 'the config reader produced unexpected output',
    });
    expect(
      parsePytestConfigOutput(
        JSON.stringify({ ok: false, config_file: '../../etc/x.ini', error: 'config-syntax' }),
      ),
    ).toMatchObject({ file: 'x.ini' });
  });

  it.each([
    ['not JSON', 'hello'],
    ['empty', ''],
    ['a JSON scalar', '3'],
    ['ok missing', '{"config_file": null}'],
    ['addopts as a string', '{"ok": true, "config_file": null, "addopts": "-k x"}'],
    ['a non-string item', '{"ok": true, "config_file": null, "addopts": [1]}'],
    ['a key absent', '{"ok": true, "config_file": null, "addopts": null, "testpaths": null}'],
  ])('refuses %s', (_label, stdout) => {
    expect(parsePytestConfigOutput(stdout).ok).toBe(false);
  });
});

describe('readPytestContext fails closed (#174)', () => {
  it('when the interpreter does not exist', async () => {
    const a = await scopeWith(tmp({ 'pytest.ini': '[pytest]\n' }), '/nonexistent/python3');
    expect(a.scope).toBe('narrowed');
    expect(a.signals.join(' ')).toMatch(/could not be read.*could not be started/);
  });

  it.skipIf(WINDOWS)('when the reader hangs', async () => {
    const a = await scopeWith(tmp(), fakePython('sleep 10'), 300);
    expect(a.scope).toBe('narrowed');
    expect(a.signals.join(' ')).toMatch(/could not be read.*timed out/);
  });

  it.skipIf(WINDOWS)('when the reader prints something else', async () => {
    const a = await scopeWith(tmp(), fakePython('echo hello'));
    expect(a.scope).toBe('narrowed');
    expect(a.signals.join(' ')).toMatch(/could not be read.*unparseable/);
  });

  it.skipIf(WINDOWS)('when the answer is off-contract', async () => {
    const a = await scopeWith(tmp(), fakePython(`echo '{"ok": true, "addopts": "-k x"}'`));
    expect(a.scope).toBe('narrowed');
    expect(a.signals.join(' ')).toMatch(/could not be read.*unexpected output/);
  });

  it.skipIf(WINDOWS)('when the reader exits non-zero, even with a clean answer', async () => {
    const clean = JSON.stringify({
      ok: true,
      config_file: null,
      addopts: null,
      testpaths: null,
      python_files: null,
    });
    const a = await scopeWith(tmp(), fakePython(`echo '${clean}'; exit 3`));
    expect(a.scope).toBe('narrowed');
    expect(a.signals.join(' ')).toMatch(/could not be read.*exited 3/);
  });

  it.skipIf(WINDOWS || NO_PYTEST)('when pytest cannot be imported', async () => {
    const a = await scopeWith(
      tmp({ 'pytest.ini': '[pytest]\naddopts = -q\n' }),
      fakePython('exec python3 -I -S "$@"'),
    );
    expect(a.scope).toBe('narrowed');
    expect(a.signals.join(' ')).toMatch(/could not be read.*importable/);
  });

  it.skipIf(NO_PYTEST)('when the config does not parse, naming the file', async () => {
    const a = await scopeWith(
      tmp({ 'pyproject.toml': '[tool.pytest.ini_options\naddopts = "-q"\n' }),
      'python3',
    );
    expect(a.scope).toBe('narrowed');
    expect(a.signals.join(' ')).toMatch(
      /pytest configuration in pyproject\.toml could not be read/,
    );
  });

  it.skipIf(NO_PYTEST)('never echoes the config line that failed to parse', async () => {
    const token = 'ghp_FAKEtoken0123456789abcdefFAKE';
    const root = tmp({ 'pytest.ini': `[pytest]\naddopts = -q\n${token}\n` });
    const a = await scopeWith(root, 'python3');
    expect(a.scope).toBe('narrowed');
    const text = JSON.stringify(a);
    expect(text).not.toContain(token);
    expect(text).not.toContain(root);
    expect(text).toContain('pytest.ini');
  });
});

describe('readPytestContext on a readable config (#174)', () => {
  it.skipIf(NO_PYTEST)('returns the values and walks only for testpaths', async () => {
    const plain = await readPytestContext(
      tmp({ 'pytest.ini': '[pytest]\naddopts = -q\n', 'tests/test_a.py': '' }),
      CMD,
      {},
    );
    expect(plain).toEqual({
      config: { file: 'pytest.ini', addopts: ['-q'], testpaths: null, pythonFiles: null },
      testFiles: null,
    });

    const scoped = await readPytestContext(
      tmp({
        'pytest.ini': '[pytest]\ntestpaths = tests/unit\n',
        'tests/unit/test_a.py': '',
        'tests/int/test_b.py': '',
      }),
      CMD,
      {},
    );
    expect(scoped.testFiles?.slice().sort()).toEqual([
      'tests/int/test_b.py',
      'tests/unit/test_a.py',
    ]);
  });

  it('reads nothing for a command that does not run pytest', async () => {
    // The nonexistent interpreter proves no spawn was attempted.
    expect(
      await readPytestContext(tmp(), 'npx vitest run', {}, [], {
        pythonBin: '/nonexistent/python3',
      }),
    ).toEqual({ config: null, testFiles: null });
  });
});

describe('testCommandInterpreter picks the interpreter the tests run under (#174)', () => {
  const pinned = (bin: string) => ({ kind: 'pinned', bin });
  const UNPINNED = { kind: 'unpinned' };

  it.each([
    ['python3 -m pytest -q', 'python3'],
    ['python3.11 -m pytest -q', 'python3.11'],
    ['PYTHONPATH=. python3.12 -m pytest', 'python3.12'],
    ['/opt/venv/bin/python -m pytest', '/opt/venv/bin/python'],
  ])('%s -> %s', (cmd, expected) => {
    expect(testCommandInterpreter(cmd, '/repo')).toEqual(pinned(expected));
  });

  it.each([
    'make test',
    'pytest -q && lint',
    'poetry run pytest -q',
    'uv run pytest',
    'pipenv run pytest',
    'pdm run pytest',
    'hatch run test',
    'rye run pytest',
    'env PYTHONPATH=. python3 -m pytest',
  ])('cannot tell for %s', (cmd) => {
    expect(testCommandInterpreter(cmd, '/repo')).toEqual(UNPINNED);
  });

  it('resolves a relative interpreter against the root it is given', () => {
    expect(testCommandInterpreter('.venv/bin/python -m pytest', '/repo')).toEqual(
      pinned(path.resolve('/repo', '.venv/bin/python')),
    );
  });

  it('refuses a relative interpreter that leaves the root', () => {
    expect(testCommandInterpreter('../elsewhere/bin/python -m pytest', '/repo')).toEqual({
      kind: 'refused',
    });
  });

  it.skipIf(WINDOWS)('finds a bare interpreter through a hoisted PATH', () => {
    const bin = tmp();
    fs.writeFileSync(path.join(bin, 'python3'), '#!/bin/sh\n');
    fs.chmodSync(path.join(bin, 'python3'), 0o755);
    expect(testCommandInterpreter(`PATH=${bin} python3 -m pytest`, '/repo')).toEqual(
      pinned(path.join(bin, 'python3')),
    );
    expect(testCommandInterpreter(`PATH=${tmp()} python3 -m pytest`, '/repo')).toEqual(UNPINNED);
  });

  it.skipIf(WINDOWS)("follows a console script's shebang, as coverage does", () => {
    const bin = tmp();
    fs.writeFileSync(path.join(bin, 'pytest'), '#!/opt/tool/bin/python3.12\nimport pytest\n');
    fs.chmodSync(path.join(bin, 'pytest'), 0o755);
    expect(testCommandInterpreter(`PATH=${bin} pytest -q`, '/repo')).toEqual(
      pinned('/opt/tool/bin/python3.12'),
    );
  });

  it.skipIf(WINDOWS)('reads the shebang of a path-form console script under the root', () => {
    const root = tmp({ '.venv/bin/pytest': '#!/opt/venv/bin/python3.11\nimport pytest\n' });
    expect(testCommandInterpreter('.venv/bin/pytest -q', root)).toEqual(
      pinned('/opt/venv/bin/python3.11'),
    );
    const shim = tmp({ 'bin/pytest': '#!/usr/bin/env bash\nexec pyenv exec pytest "$@"\n' });
    expect(testCommandInterpreter('bin/pytest -q', shim)).toEqual(UNPINNED);
  });

  it.skipIf(WINDOWS)("never takes a wrapper's own shebang interpreter", () => {
    const bin = tmp();
    fs.writeFileSync(path.join(bin, 'poetry'), '#!/opt/poetry/venv/bin/python\n');
    fs.chmodSync(path.join(bin, 'poetry'), 0o755);
    expect(testCommandInterpreter(`PATH=${bin} poetry run pytest`, '/repo')).toEqual(UNPINNED);
  });
});
