import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reportCoverage } from '../../src/analyze/coverage/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURE = path.resolve(__dirname, '../fixtures/coverage-mini');

// Probes BOTH, because the tests below drive `pytest -q` under coverage: an
// image with coverage but no pytest would fail rather than skip. Hoisted to
// module scope so `it.skipIf` can use it. An early `return` inside a test body
// reports PASSED and proves nothing, which is why new tests here use skipIf.
const NO_COVERAGE = (() => {
  try {
    execSync('python3 -c "import coverage, pytest"', { stdio: 'ignore' });
    return false;
  } catch {
    return true;
  }
})();

// Some tests need only a python that runs, not coverage.py or pytest: they use
// `/bin/sh` shims and `_probeOverride`, or decline before anything spawns.
// Gating those on the full probe would silently stop them running on an image
// that lacks pytest, and #100's whole point is a test that runs on the Windows
// leg. Nothing here needs a prerequisite at all.
const NO_PYTHON = (() => {
  try {
    execSync('python3 -c "pass"', { stdio: 'ignore' });
    return false;
  } catch {
    return true;
  }
})();

describe('python-line-coverage reporter', () => {
  // Two explicit worlds. Every classifier assertion says which one it is in,
  // because the answer differs: a console entry point that resolves runs
  // positionally, and one that does not is DECLINED rather than rewritten to
  // module form. Passing the resolver is mandatory so no call site can silently
  // pick a spawn shape the gate would not have used.
  // Deliberately reads `env`, so a regression that stops forwarding the hoisted
  // environment to the resolver shows up as a wrong path rather than passing
  // silently. Without this the resolver would search the ambient PATH while the
  // gate's shell searched the prefixed one, and pick a DIFFERENT executable.
  const RESOLVES = (n: string, env: Record<string, string>) => ({
    script: `${env.PATH ?? '/venv/bin'}/${n}`,
  });
  const UNRESOLVABLE = () => null;

  it.skipIf(NO_COVERAGE)(
    'returns covered lines for a tested function and skips untested',
    async () => {
      const result = await reportCoverage({
        projectRoot: FIXTURE,
        testCmd: 'python3 -m pytest -q',
      });
      expect(result.coverageToolFound).toBe(true);
      expect(result.coveredLines.has('svc_tested.py:2')).toBe(true); // tested_function return
      expect(result.coveredLines.has('svc_tested.py:5')).toBe(false); // untested_function return
      expect([...result.coveredLines].some((k) => k.startsWith('svc_untouched.py:'))).toBe(false);
    },
  );

  // coverage.py only ever marks the FIRST line of a statement. Continuation
  // lines, closing brackets, comments and blanks are never in executed_lines, so
  // a physical-line consumer reports them all as uncovered. executed_lines UNION
  // missing_lines is the file's statement-START set, which is what lets a
  // consumer map a changed line to the statement that actually ran.
  it.skipIf(NO_COVERAGE)('exposes the executable (statement-start) line set per file', async () => {
    const result = await reportCoverage({ projectRoot: FIXTURE, testCmd: 'python3 -m pytest -q' });
    const svc = result.executableLines.get('svc_tested.py');
    expect(svc).toBeDefined();
    // Both the executed `return 42` (line 2) and the missing `return 99` (line
    // 5) are executable; the blank separator line 3 is not.
    expect(svc?.has(2)).toBe(true);
    expect(svc?.has(5)).toBe(true);
    expect(svc?.has(3)).toBe(false);
    // Keyed the same way as coveredLines, so `${rel}:${line}` lookups line up.
    expect([...result.executableLines.keys()]).toContain('svc_tested.py');
    // Every covered line is by definition executable.
    for (const key of result.coveredLines) {
      const idx = key.lastIndexOf(':');
      const file = key.slice(0, idx);
      const line = Number(key.slice(idx + 1));
      expect(result.executableLines.get(file)?.has(line)).toBe(true);
    }
  });

  // coverage.py drops EXCLUDED statements (`# pragma: no cover`, and whatever
  // else the project's exclude_lines matches) from executed_lines AND
  // missing_lines, reporting them in a third list. They are still statements, so
  // leaving them out of the executable set makes a consumer's enclosing-statement
  // lookup skip backwards past them onto whatever covered statement precedes,
  // turning provably-unexecuted code into apparently-covered code.
  it.skipIf(NO_COVERAGE)(
    'counts EXCLUDED lines as executable so they cannot be attributed away',
    async () => {
      const pragma = path.resolve(__dirname, '../fixtures/verify-diff-pragma');
      const result = await reportCoverage({ projectRoot: pragma, testCmd: 'python3 -m pytest -q' });
      const gated = result.executableLines.get('gated.py');
      expect(gated).toBeDefined();
      // `return "-".join(` at line 6 opens the pragma'd body: excluded, never
      // executed, and it must still be a statement the consumer can land on.
      expect(gated?.has(6)).toBe(true);
      expect(result.coveredLines.has('gated.py:6')).toBe(false);
      // The `def dead(...)` line is excluded too, so it must also be executable.
      // Deliberately NOT asserting that it appears in coveredLines: whether an
      // excluded line is ALSO reported as executed varies by coverage.py and
      // Python version (3.13 reports both, 3.11 reports excluded only), and that
      // incidental detail is not the property this test defends.
      expect(gated?.has(5)).toBe(true);
    },
  );

  it('returns coverageToolFound=false when coverage.py is absent', async () => {
    // Force absence by pointing testCmd at a python that can't import coverage —
    // simulate via PATH override or just by inspecting the negative branch.
    // For this test we assert the shape when probe fails.
    const result = await reportCoverage({
      projectRoot: FIXTURE,
      testCmd: 'python3 -m pytest -q',
      _probeOverride: false, // injected for test isolation
    });
    expect(result.coverageToolFound).toBe(false);
    expect(result.coveredLines.size).toBe(0);
    expect(result.executableLines.size).toBe(0);
  });

  it('reports toolFound=false when import succeeds but coverage cannot run', async () => {
    // The namespace-package ghost: a directory literally named `coverage/` on
    // sys.path (e.g. a vitest/jest HTML coverage OUTPUT dir in the cwd) makes
    // `python3 -c "import coverage"` succeed with coverage.__file__ = None,
    // while `python3 -m coverage run` fails (no __main__ in a data dir). The
    // probe must therefore test module EXECUTION, not importability. Simulate
    // with a shim python that accepts `-c import coverage` but fails `-m
    // coverage`: the reporter must report the tool as absent, not silently
    // return empty coverage under toolFound=true.
    const shimDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cov-shim-'));
    const shim = path.join(shimDir, 'python-ghost');
    await fs.writeFile(
      shim,
      '#!/bin/sh\ncase "$*" in *"-m coverage"*) exit 1;; *) exit 0;; esac\n',
      { mode: 0o755 },
    );
    await fs.writeFile(path.join(shimDir, 'python-ghost.bat'), '@echo off\r\nexit /b 1\r\n');
    const result = await reportCoverage({
      projectRoot: FIXTURE,
      testCmd: 'python3 -m pytest -q',
      pythonBin: shim,
    });
    expect(result.coverageToolFound).toBe(false);
    expect(result.coveredLines.size).toBe(0);
  });

  // Script-form test commands (Django's `python3 tests/runtests.py`, manage.py
  // test, custom runners) are extremely common. The old code stripped only a
  // `python -m ` prefix and then unconditionally re-added `-m`, so it ran
  // `coverage run -m python3 tests/runtests.py`, tried to execute a MODULE named
  // "python3", failed, swallowed the failure, and returned an empty covered set:
  // covered Django code read as "not exercised by any test". Proven against
  // django/django during round-4 hardening.
  describe('test-command forms', () => {
    async function scriptRunnerFixture(): Promise<string> {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cov-script-'));
      await fs.writeFile(
        path.join(dir, 'svc.py'),
        'def used():\n    return 1\n\n\ndef unused():\n    return 2\n',
      );
      await fs.writeFile(
        path.join(dir, 'runtests.py'),
        'import sys, os\nsys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))\n' +
          'from svc import used\nassert used() == 1\nprint("ok")\n',
      );
      return dir;
    }

    it.skipIf(NO_PYTHON)('measures coverage for a SCRIPT-form test command', async () => {
      const dir = await scriptRunnerFixture();
      const result = await reportCoverage({ projectRoot: dir, testCmd: 'python3 runtests.py' });
      expect(result.coverageToolFound).toBe(true);
      expect(result.measurementFailed).toBe(false);
      expect(result.coveredLines.has('svc.py:2')).toBe(true); // used() return
      expect(result.coveredLines.has('svc.py:6')).toBe(false); // unused() return
    });

    it.skipIf(NO_COVERAGE)(
      'still measures coverage for module-form commands (regression guard)',
      async () => {
        // Equivalent by RECOGNITION: `python3 -m pytest` is module form on both
        // sides, so this holds on every platform and must never regress.
        const result = await reportCoverage({
          projectRoot: FIXTURE,
          testCmd: 'python3 -m pytest -q',
        });
        expect(result.measurementFailed).toBe(false);
        expect(result.coveredLines.has('svc_tested.py:2')).toBe(true);
      },
    );

    // Equivalent by CONSTRUCTION, and only where the construction is possible.
    // Windows console scripts are native launchers with no Python shebang, so
    // they cannot be handed to `coverage run` positionally and are declined
    // instead of being rewritten to the module form that caused issue #98.
    // Tracked in #100.
    it.skipIf(NO_COVERAGE || process.platform === 'win32')(
      'measures a console-script command by resolving it (POSIX)',
      async () => {
        // The ambient `pytest` shebang decides which branch is correct here.
        // Fedora and RHEL ship `-s` on packaged console scripts, which we
        // decline, so asserting "measures" unconditionally made this red on a
        // supported distro. Assert the shape, then what that shape must give.
        const { resolveConsoleScript } =
          await import('../../src/analyze/coverage/python-line-coverage.js');
        const resolved = resolveConsoleScript('pytest', {});
        const result = await reportCoverage({ projectRoot: FIXTURE, testCmd: 'pytest -q' });
        if (resolved === null) {
          expect(result.measurementFailed).toBe(true);
          expect(String(result.measurementFailureReason)).toContain('module form');
        } else {
          expect(result.measurementFailed).toBe(false);
          expect(result.coveredLines.has('svc_tested.py:2')).toBe(true);
        }
      },
    );

    it.skipIf(NO_PYTHON)(
      'reports measurementFailed when the coverage run cannot execute',
      async () => {
        const dir = await scriptRunnerFixture();
        const result = await reportCoverage({
          projectRoot: dir,
          testCmd: 'python3 no_such_runner_qq.py',
        });
        // Never claim zero coverage when we could not measure at all.
        expect(result.measurementFailed).toBe(true);
        expect(result.coveredLines.size).toBe(0);
      },
    );

    it('keeps quoted arguments intact when tokenizing', async () => {
      // The tests gate runs the command through a shell, so `-k "not slow"` is
      // ONE argument there. A naive whitespace split turns it into `"not` and
      // `slow"`, which changes which tests run and therefore what gets measured.
      const { toCoverageRunArgs } =
        await import('../../src/analyze/coverage/python-line-coverage.js');
      expect(toCoverageRunArgs('pytest tests/ -k "not slow"', RESOLVES)).toEqual({
        args: ['/venv/bin/pytest', 'tests/', '-k', 'not slow'],
        env: {},
      });
      expect(toCoverageRunArgs("pytest -k 'a or b'", RESOLVES)).toEqual({
        args: ['/venv/bin/pytest', '-k', 'a or b'],
        env: {},
      });
      expect(toCoverageRunArgs('python3 tests/runtests.py "my app"', RESOLVES)).toEqual({
        args: ['tests/runtests.py', 'my app'],
        env: {},
      });
    });

    it('hoists a leading NAME=VALUE prefix into the environment (issue #95)', async () => {
      // The tests gate runs the command via `sh -c`, where `PYTHONPATH=. pytest`
      // is an env assignment. The coverage runner spawns argv directly, so it
      // used to classify the assignment as a MODULE NAME and emit
      // `-m PYTHONPATH=. python3 ...`. coverage then imported nothing, wrote no
      // data file, and every such project capped at UNPROVEN forever -- while
      // `PYTHONPATH=` is our own documented remedy for shadow bypass.
      const { toCoverageRunArgs } =
        await import('../../src/analyze/coverage/python-line-coverage.js');

      expect(toCoverageRunArgs('PYTHONPATH=. python3 -m pytest -q', RESOLVES)).toEqual({
        args: ['-m', 'pytest', '-q'],
        env: { PYTHONPATH: '.' },
      });
      expect(toCoverageRunArgs('PYTHONPATH=src python3 -m pytest -q', RESOLVES)).toEqual({
        args: ['-m', 'pytest', '-q'],
        env: { PYTHONPATH: 'src' },
      });
      // The slash used to divert this one into the script-form branch, so it
      // failed differently but just as silently.
      expect(toCoverageRunArgs('PYTHONPATH=./src python3 -m pytest -q', RESOLVES)).toEqual({
        args: ['-m', 'pytest', '-q'],
        env: { PYTHONPATH: './src' },
      });
      expect(toCoverageRunArgs('COVERAGE_CORE=sysmon python3 -m pytest', RESOLVES)).toEqual({
        args: ['-m', 'pytest'],
        env: { COVERAGE_CORE: 'sysmon' },
      });
      // Several assignments in a row, and the remainder still classifies as
      // script form rather than module form.
      expect(toCoverageRunArgs('A=1 B=2 python3 tests/runtests.py', RESOLVES)).toEqual({
        args: ['tests/runtests.py'],
        env: { A: '1', B: '2' },
      });
      // An empty value is a legitimate assignment (`FOO= cmd` unsets in shell).
      expect(toCoverageRunArgs('PYTHONPATH= python3 -m pytest', RESOLVES)).toEqual({
        args: ['-m', 'pytest'],
        env: { PYTHONPATH: '' },
      });
    });

    // `it.skipIf`, never an early return. An early return reports PASSED, and
    // this is the ONLY proof that hoisting survives a real subprocess round
    // trip; the release workflow installs pytest without coverage, so an early
    // return would make that gate green while proving nothing.
    it.skipIf(NO_COVERAGE)(
      'hoists through a real coverage run, keeping the inherited env',
      async () => {
        // Hoisted assignments must ADD to the environment, not replace it: the
        // child still needs the inherited PATH to find python at all.
        //
        // The COVERAGE_FILE assertion below is deliberately weaker than it
        // looks. Flipping the spread order alone does NOT break it, because
        // `--data-file` is also passed on argv to both `coverage run` and
        // `coverage json`, and argv beats the environment. So this detects only
        // the CONJUNCTION of "ordering flipped" and "--data-file dropped". The
        // ordering is defence in depth, not the load-bearing protection.
        const bogus = path.join(
          os.tmpdir(),
          `refactron-should-not-be-used-${process.pid}.coverage`,
        );
        await fs.rm(bogus, { force: true });

        const result = await reportCoverage({
          projectRoot: FIXTURE,
          // Module form on purpose: a console entry point carrying PYTHONPATH is
          // declined now, since `-m` and a console script disagree about
          // sys.path[0]. This still exercises hoisting through a real subprocess.
          testCmd: `COVERAGE_FILE=${bogus} PYTHONPATH=. python3 -m pytest -q`,
        });

        expect(result.coverageToolFound).toBe(true);
        expect(result.measurementFailed).toBe(false);
        // Real data came back, so PATH survived and our data file won.
        expect(result.coveredLines.has('svc_tested.py:2')).toBe(true);
        expect(
          await fs
            .access(bogus)
            .then(() => true)
            .catch(() => false),
        ).toBe(false);
      },
    );

    it('stops hoisting at the first token that is not an assignment', async () => {
      // `-k a=b` is a pytest ARGUMENT that happens to contain `=`. Eating it
      // would silently change which tests run, so the measured run would no
      // longer be the verified run.
      const { toCoverageRunArgs } =
        await import('../../src/analyze/coverage/python-line-coverage.js');

      expect(toCoverageRunArgs('pytest -k a=b', RESOLVES)).toEqual({
        args: ['/venv/bin/pytest', '-k', 'a=b'],
        env: {},
      });
      // A non-import-affecting prefix still hoists onto a console entry point,
      // so the hoist-stop is exercised here rather than short-circuited by the
      // import-affecting decline.
      expect(toCoverageRunArgs('FOO=1 pytest -k a=b', RESOLVES)).toEqual({
        args: ['/venv/bin/pytest', '-k', 'a=b'],
        env: { FOO: '1' },
      });
      expect(toCoverageRunArgs('PYTHONPATH=. python3 -m pytest -k a=b', RESOLVES)).toEqual({
        args: ['-m', 'pytest', '-k', 'a=b'],
        env: { PYTHONPATH: '.' },
      });
      // A leading token that is not a valid shell identifier is not an
      // assignment: `-k=v` is a flag, and `1BAD=x` cannot be an env name.
      expect(toCoverageRunArgs('pytest --opt=1', RESOLVES)).toEqual({
        args: ['/venv/bin/pytest', '--opt=1'],
        env: {},
      });
      // Nothing left to run once the assignments are removed.
      expect(toCoverageRunArgs('PYTHONPATH=.', RESOLVES)).toBeNull();
    });

    it('declines a hoisted value the shell would expand', async () => {
      // The tests gate runs under `sh -c`, which expands `$HOME` and `~`.
      // Hoisting either literally would put a different path on sys.path for
      // the coverage run than the run we actually verified, so the measurement
      // would describe a run that never happened. Unknown is honest; a silent
      // mismatch is not.
      const { toCoverageRunArgs } =
        await import('../../src/analyze/coverage/python-line-coverage.js');

      expect(toCoverageRunArgs('PYTHONPATH=$HOME/x python3 -m pytest', RESOLVES)).toBeNull();
      expect(toCoverageRunArgs('PYTHONPATH=$PWD python3 -m pytest', RESOLVES)).toBeNull();
      // `sh` expands a tilde at the start of the value AND after each `:`,
      // because expansion applies per segment of a PATH-like value.
      expect(toCoverageRunArgs('PYTHONPATH=~/x python3 -m pytest', RESOLVES)).toBeNull();
      expect(toCoverageRunArgs('PYTHONPATH=a:~/y python3 -m pytest', RESOLVES)).toBeNull();
      // A tilde that is not at a segment boundary is literal to the shell too.
      expect(toCoverageRunArgs('PYTHONPATH=a~b python3 -m pytest', RESOLVES)).toEqual({
        args: ['-m', 'pytest'],
        env: { PYTHONPATH: 'a~b' },
      });
      // A literal `$` in an ARGUMENT is not our problem to expand and was never
      // hoisted, so it keeps classifying as before.
      expect(toCoverageRunArgs('pytest -k "cost$"', RESOLVES)).toEqual({
        args: ['/venv/bin/pytest', '-k', 'cost$'],
        env: {},
      });
    });

    it('matches shell semantics on assignment edge cases', async () => {
      // These four exist because a mutation run showed the rest of the suite
      // survives all of them. Diffing against main cannot prove them red: the
      // return SHAPE changed, so every assertion here goes red on main whether
      // or not it tests anything. Each case below was verified by mutating THIS
      // branch's implementation instead.
      const { toCoverageRunArgs } =
        await import('../../src/analyze/coverage/python-line-coverage.js');

      // Quote removal. A value class of `\S*` would stop matching here, the
      // token would classify as a COMMAND, and we would be back to issue #95
      // with a different first token.
      expect(toCoverageRunArgs('PYTHONPATH="a b" python3 -m pytest -q', RESOLVES)).toEqual({
        args: ['-m', 'pytest', '-q'],
        env: { PYTHONPATH: 'a b' },
      });

      // A shell applies assignments left to right, so the last one wins.
      expect(toCoverageRunArgs('A=1 A=2 python3 -m pytest -q', RESOLVES)).toEqual({
        args: ['-m', 'pytest', '-q'],
        env: { A: '2' },
      });

      // A shell reads `1BAD=x` as a COMMAND name, not an assignment, because
      // the name is not a valid identifier. Hoisting it would make the coverage
      // run succeed against a command the tests gate could never have run.
      expect(toCoverageRunArgs('1BAD=x python3 -m pytest -q', RESOLVES)?.env).toEqual({});
      expect(toCoverageRunArgs('-k=v python3 -m pytest -q', RESOLVES)?.env).toEqual({});

      // The default testCmd. `src/analyze/engine.ts` calls reportCoverage with
      // no testCmd at all, so 'pytest -q' is a second production caller of this
      // classifier and must keep classifying exactly as it did before hoisting.
      expect(toCoverageRunArgs('pytest -q', RESOLVES)).toEqual({
        args: ['/venv/bin/pytest', '-q'],
        env: {},
      });
    });

    it('runs a resolvable console entry point positionally, as the gate does (issue #98)', async () => {
      // `coverage run -m pytest` puts CWD on sys.path ahead of everything the
      // environment supplies, while the console script the gate runs does not.
      // On an editable install that difference made coverage measure the SHADOW
      // tree while the gate ran the INSTALLED one, and fusing those produced a
      // false SAFE for a change that broke the suite. Running the same file the
      // gate runs, positionally, puts sys.path[0] in the same place for both.
      const { toCoverageRunArgs } =
        await import('../../src/analyze/coverage/python-line-coverage.js');

      const resolves = (name: string) => ({ script: `/venv/bin/${name}` });
      expect(toCoverageRunArgs('pytest -q', resolves)).toEqual({
        args: ['/venv/bin/pytest', '-q'],
        env: {},
      });
      // The prefix is hoisted and the entry point still resolves, so this is
      // measurable rather than declined: both spawns now agree.
      expect(toCoverageRunArgs('PYTHONPATH=src pytest -q', resolves)).toEqual({
        args: ['/venv/bin/pytest', '-q'],
        env: { PYTHONPATH: 'src' },
      });
      // Explicit module form is already equivalent on both sides and must NOT
      // be rewritten: the gate runs `python3 -m pytest` too.
      expect(toCoverageRunArgs('python3 -m pytest -q', resolves)).toEqual({
        args: ['-m', 'pytest', '-q'],
        env: {},
      });
      // A script path is already positional and must not be touched.
      expect(toCoverageRunArgs('python3 tests/runtests.py', resolves)).toEqual({
        args: ['tests/runtests.py'],
        env: {},
      });
    });

    // POSIX-only by design: resolution declines outright on Windows, which the
    // platform test below asserts. These build real files and expect a hit.
    it.skipIf(process.platform === 'win32')(
      'resolves an entry point exactly as a shell would (issue #98)',
      async () => {
        // The real resolver, not a stub. Everything the safety argument rests on
        // lives here: once a console entry point resolves, the classifier stops
        // consulting anything else, so a resolution that disagrees with the shell
        // IS a wrong verdict rather than a wrong measurement.
        const { resolveConsoleScript } =
          await import('../../src/analyze/coverage/python-line-coverage.js');

        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cov-path-'));
        const a = path.join(root, 'a');
        const b = path.join(root, 'b');
        await fs.mkdir(a);
        await fs.mkdir(b);
        const PATHV = [a, b].join(path.delimiter);

        // The exec-bit case lives in its own POSIX-only test below: `chmod` is a
        // no-op on Windows, where every readable file reports executable, so the
        // property cannot be expressed there.
        await fs.writeFile(path.join(a, 'tool'), '#!/usr/bin/env python3\nprint(1)\n', {
          mode: 0o755,
        });
        expect(resolveConsoleScript('tool', { PATH: PATHV })).toEqual({
          script: path.join(a, 'tool'),
          interpreter: 'python3',
        });

        // The FIRST executable match wins, and if it is not a Python script we
        // decline instead of looking further down PATH. A pyenv or asdf shim is
        // exactly this shape.
        await fs.writeFile(path.join(a, 'shim'), '#!/usr/bin/env bash\nexec real "$@"\n', {
          mode: 0o755,
        });
        await fs.writeFile(path.join(b, 'shim'), '#!/usr/bin/env python3\nprint(3)\n', {
          mode: 0o755,
        });
        expect(resolveConsoleScript('shim', { PATH: PATHV })).toBeNull();

        // A directory named like the entry point is not a match.
        await fs.mkdir(path.join(a, 'adir'));
        expect(resolveConsoleScript('adir', { PATH: PATHV })).toBeNull();

        // A relative or empty PATH element is resolved against the SHELL's cwd,
        // which is the shadow root and not this process's cwd. We cannot know
        // what it holds, and it could shadow a later match, so decline.
        expect(resolveConsoleScript('tool', { PATH: `relative${path.delimiter}${b}` })).toBeNull();
        expect(resolveConsoleScript('tool', { PATH: `${path.delimiter}${b}` })).toBeNull();

        // A name with a separator is a path, run relative to the shell's cwd.
        expect(resolveConsoleScript('bin/tool', { PATH: PATHV })).toBeNull();

        // Nothing on PATH at all.
        expect(resolveConsoleScript('absent', { PATH: PATHV })).toBeNull();

        // A CRLF shebang still names python.
        await fs.writeFile(path.join(a, 'crlf'), '#!/usr/bin/env python3\r\nprint(4)\r\n', {
          mode: 0o755,
        });
        expect(resolveConsoleScript('crlf', { PATH: PATHV })).toEqual({
          script: path.join(a, 'crlf'),
          interpreter: 'python3',
        });

        // A long venv shebang beyond the old 128-byte read window.
        const deep = '/' + 'd'.repeat(200) + '/bin/python3';
        await fs.writeFile(path.join(a, 'deep'), `#!${deep}\nprint(5)\n`, { mode: 0o755 });
        // An absolute shebang, so the interpreter comes back with it (issue #99).
        expect(resolveConsoleScript('deep', { PATH: PATHV })).toEqual({
          script: path.join(a, 'deep'),
          interpreter: deep,
        });

        // A binary with no shebang (the Windows `.exe` shape) is not runnable by
        // `coverage run`.
        await fs.writeFile(path.join(a, 'native'), Buffer.from([0x4d, 0x5a, 0x90, 0x00]), {
          mode: 0o755,
        });
        expect(resolveConsoleScript('native', { PATH: PATHV })).toBeNull();
      },
    );

    it.skipIf(process.platform === 'win32')(
      'skips a PATH match it cannot execute, as a shell does (POSIX)',
      async () => {
        // A shell skips a non-executable match and keeps searching. Taking it
        // anyway, or scanning past it to a Python script further down, would run
        // a different program than the gate did. Both were real defects: the
        // first attempt at this resolver did exactly that and reintroduced the
        // false SAFE it was written to remove.
        const { resolveConsoleScript } =
          await import('../../src/analyze/coverage/python-line-coverage.js');
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cov-exec-'));
        const a = path.join(root, 'a');
        const b = path.join(root, 'b');
        await fs.mkdir(a);
        await fs.mkdir(b);
        const PATHV = [a, b].join(path.delimiter);

        await fs.writeFile(path.join(a, 'tool'), '#!/usr/bin/env python3\nprint(1)\n', {
          mode: 0o644,
        });
        await fs.writeFile(path.join(b, 'tool'), '#!/usr/bin/env python3\nprint(2)\n', {
          mode: 0o755,
        });
        expect(resolveConsoleScript('tool', { PATH: PATHV })).toEqual({
          script: path.join(b, 'tool'),
          interpreter: 'python3',
        });
      },
    );

    it('carries the interpreter as written, never normalised', async () => {
      // Pure, so this runs on Windows too, where the end-to-end tests cannot.
      //
      // Identity is the path AS WRITTEN. A venv's bin/python3 is a symlink to
      // the base interpreter, which has a DIFFERENT site-packages, so treating
      // them as the same interpreter after a realpath would reintroduce exactly
      // the mismatch this resolves. Case-folding is wrong for the same reason.
      const { toCoverageRunArgs } =
        await import('../../src/analyze/coverage/python-line-coverage.js');
      const plan = toCoverageRunArgs('pytest -q', () => ({
        script: '/venv/bin/pytest',
        interpreter: '/Venv/bin/Python3',
      }));
      expect(plan).toEqual({
        args: ['/venv/bin/pytest', '-q'],
        env: {},
        interpreter: '/Venv/bin/Python3',
      });
    });

    it('gives a shell composite its own reason, not the console-script one', async () => {
      // The plan-null branch is reached by five causes and only ONE is fixed by
      // module form. Telling someone running `pytest && lint` to write
      // `python -m pytest` sends them round the same loop: right verdict,
      // remedy that cannot work, which is the defect class this file keeps
      // relearning.
      const composite = await reportCoverage({
        projectRoot: FIXTURE,
        testCmd: 'pytest -q && echo done',
        _probeOverride: true,
      });
      expect(composite.measurementFailed).toBe(true);
      expect(String(composite.measurementFailureReason)).toContain('combines');
      expect(String(composite.measurementFailureReason)).not.toContain('module form');
    });

    it.skipIf(NO_PYTHON || process.platform === 'win32')(
      'probes the interpreter with the command OWN environment',
      async () => {
        // The probe must see what the real run sees. A hoisted PYTHONPATH can
        // be exactly what makes coverage importable for that interpreter, and
        // probing without it declines a measurable command while telling the
        // user to install something they already have.
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cov-probeenv-'));
        const bin = path.join(root, 'bin');
        await fs.mkdir(bin);
        // Only reports coverage when the command's own PYTHONPATH reached it.
        const shim = path.join(bin, 'python-envaware');
        await fs.writeFile(
          shim,
          '#!/bin/sh\n' +
            'if [ "$PYTHONPATH" != "sentinel-value" ]; then exit 1; fi\n' +
            'case "$*" in *"-m coverage"*) exit 0 ;; *) exit 0 ;; esac\n',
          { mode: 0o755 },
        );
        await fs.writeFile(path.join(bin, 'tool'), `#!${shim}\nprint(1)\n`, { mode: 0o755 });

        const result = await reportCoverage({
          projectRoot: FIXTURE,
          testCmd: `PYTHONPATH=sentinel-value PATH=${bin} tool`,
          _probeOverride: true,
        });
        // The probe passed, so we did NOT decline with the interpreter message.
        expect(String(result.measurementFailureReason ?? '')).not.toContain('from its shebang');
      },
    );

    it('resolution is POSIX-only, by design (issue #100)', async () => {
      // Asserts DIFFERENT things per platform, so it cannot pass under both.
      // A test that declines everywhere for the same reason proves nothing
      // about Windows, which is what the previous version of this did.
      const { resolveConsoleScript } =
        await import('../../src/analyze/coverage/python-line-coverage.js');
      const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'cov-plat-'));
      await fs.writeFile(path.join(bin, 'tool'), '#!/usr/bin/env python3\nprint(1)\n', {
        mode: 0o755,
      });

      if (process.platform === 'win32') {
        // No PATHEXT handling, and a Windows console script is a native `.exe`
        // launcher with no Python shebang, so nothing can resolve. The command
        // declines and the caller tells the user to use module form.
        expect(resolveConsoleScript('tool', { PATH: bin })).toBeNull();
      } else {
        expect(resolveConsoleScript('tool', { PATH: bin })).toEqual({
          script: path.join(bin, 'tool'),
          interpreter: 'python3',
        });
      }
    });

    it.skipIf(NO_PYTHON || process.platform === 'win32')(
      'actually RUNS coverage under the shebang interpreter (issue #99)',
      async () => {
        // The test that makes the fix load-bearing. Without it the whole
        // interpreter switch could be reverted to `runner = pythonBin` and the
        // suite stayed green, because every other test uses a machine where the
        // shebang interpreter and the ambient python3 are the same binary.
        //
        // Here they are provably different: a shim that answers the coverage
        // probe and records that IT was the one invoked.
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cov-runner-'));
        const bin = path.join(root, 'bin');
        await fs.mkdir(bin);
        const marker = path.join(root, 'invoked-by-shebang-interpreter');

        const shim = path.join(bin, 'python-marker');
        await fs.writeFile(
          shim,
          '#!/bin/sh\n' +
            'case "$*" in\n' +
            // The site-packages resolve (ADR-17): print a plausible dir so the
            // launcher can insert it.
            `  *"os.path.dirname(os.path.dirname"*) echo /fake/site ; exit 0 ;;\n` +
            // Writes the data file too, so the run is observed as a SUCCESS
            // and not merely as "the shim was spawned". #99 requires that a
            // matching interpreter still MEASURES, not just that it is chosen.
            `  *" run "*) printf '%s' "$0" > ${marker};\n` +
            `     for a in "$@"; do case "$a" in *.coverage) : > "$a" ;; esac; done\n` +
            `     exit 0 ;;\n` +
            `  *" json "*)\n` +
            `     for a in "$@"; do case "$a" in *coverage.json) echo '{"files":{}}' > "$a" ;; esac; done\n` +
            `     exit 0 ;;\n` +
            '  *) exit 0 ;;\n' +
            'esac\n',
          { mode: 0o755 },
        );
        await fs.writeFile(path.join(bin, 'tool'), `#!${shim}\nprint(1)\n`, { mode: 0o755 });

        const result = await reportCoverage({
          projectRoot: FIXTURE,
          testCmd: `PATH=${bin} tool`,
          _probeOverride: true,
        });

        // The shim wrote the marker, so `coverage run` was spawned under the
        // interpreter named by the script's shebang and not under ours.
        // The contents, not just existence: a failure then reads
        // "expected '<never spawned>' to be '<shim path>'" instead of
        // "expected false to be true".
        const ranUnder = await fs.readFile(marker, 'utf8').catch(() => '<never spawned>');
        expect(ranUnder).toBe(shim);
        // And the run was a SUCCESS, not a decline: both `coverage run` and
        // `coverage json` were served by the shebang interpreter.
        expect(result.measurementFailed).toBe(false);
      },
    );

    it.skipIf(NO_PYTHON || process.platform === 'win32')(
      'declines when the shebang interpreter cannot run coverage (issue #99)',
      async () => {
        // Running the script under OUR python instead of its own is not parity,
        // and when it fails the shadow-bypass floor blamed the user's sys.path
        // and told them to add PYTHONPATH=. -- a remedy that cannot work,
        // because nothing was wrong with sys.path. Decline with the truth.
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cov-interp-'));
        const bin = path.join(root, 'bin');
        await fs.mkdir(bin);

        // A python that exists but cannot import coverage (the resolve fails).
        const nocov = path.join(bin, 'python-nocov');
        await fs.writeFile(
          nocov,
          '#!/bin/sh\ncase "$*" in *"os.path.dirname(os.path.dirname"*) exit 1;; *) exit 0;; esac\n',
          { mode: 0o755 },
        );
        // A console script that names it via its shebang (absolute), so the
        // resolve runs under THAT interpreter, not ours.
        await fs.writeFile(path.join(bin, 'tool'), `#!${nocov}\nprint(1)\n`, { mode: 0o755 });

        const result = await reportCoverage({
          projectRoot: FIXTURE,
          testCmd: `PATH=${bin} tool`,
          _probeOverride: true,
        });

        // Coverage is not importable for the shebang interpreter, so the run the
        // gate performed cannot be measured. Decline (coverageToolFound:false →
        // UNPROVEN) rather than measure under OUR python — the unsound fallback
        // this whole path exists to remove.
        expect(result.coverageToolFound).toBe(false);
      },
    );

    it.skipIf(NO_PYTHON)(
      'an unresolvable entry point declines and names module form (issue #100)',
      async () => {
        // Runs on EVERY platform, including the Windows leg, and distinguishes
        // the two outcomes rather than passing under both. On Windows a console
        // script is a native `.exe` launcher and can never resolve, so this is
        // the permanent behaviour there; elsewhere it is what a pyenv, asdf or
        // nix shim produces. Either way the user must be told what to do, not
        // just that we refused.
        const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'cov-nopath-'));
        const result = await reportCoverage({
          projectRoot: FIXTURE,
          testCmd: `PATH=${empty} pytest -q`,
        });
        expect(result.measurementFailed).toBe(true);
        expect(String(result.measurementFailureReason)).toContain('python -m pytest');
      },
    );

    it.skipIf(process.platform === 'win32')(
      'carries the shebang interpreter, not just the script (issue #99)',
      async () => {
        // `coverage run <script>` runs the file as SOURCE in the current
        // interpreter; it never honours the shebang, while the shell that runs
        // the gate does. So resolving the file is only half of parity: a venv's
        // pytest executed by the system python3 is a different program.
        const { resolveConsoleScript } =
          await import('../../src/analyze/coverage/python-line-coverage.js');

        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cov-shebang-'));
        const bin = path.join(root, 'bin');
        await fs.mkdir(bin);

        // An absolute shebang, which is what pip writes into a venv console script.
        await fs.writeFile(path.join(bin, 'tool'), '#!/opt/venv/bin/python3.11\nprint(1)\n', {
          mode: 0o755,
        });
        expect(resolveConsoleScript('tool', { PATH: bin })).toEqual({
          script: path.join(bin, 'tool'),
          interpreter: '/opt/venv/bin/python3.11',
        });

        // `#!/usr/bin/env python3` names no specific interpreter, so there is
        // nothing to override and the caller's python stands.
        await fs.writeFile(path.join(bin, 'envtool'), '#!/usr/bin/env python3\nprint(1)\n', {
          mode: 0o755,
        });
        // The NAME is carried, because `env python3` may be a different binary
        // from the one we would otherwise spawn; a bare name is resolved by the
        // spawn through the same PATH the shell would have searched.
        expect(resolveConsoleScript('envtool', { PATH: bin })).toEqual({
          script: path.join(bin, 'envtool'),
          interpreter: 'python3',
        });

        // Shapes we cannot reproduce are declined outright. A shebang carrying
        // ARGUMENTS is the important one: `-E` makes Python ignore PYTHONPATH, so
        // dropping it would let the gate import the installed copy while coverage
        // imports the shadow copy and measures it as covered. Fedora and RHEL ship
        // `-s` on packaged console scripts, so this is a real shape.
        await fs.writeFile(path.join(bin, 'flagged'), '#!/opt/py/bin/python3 -E\nprint(1)\n', {
          mode: 0o755,
        });
        expect(resolveConsoleScript('flagged', { PATH: bin })).toBeNull();
        await fs.writeFile(
          path.join(bin, 'envs'),
          '#!/usr/bin/env -S python3 -X utf8\nprint(1)\n',
          {
            mode: 0o755,
          },
        );
        expect(resolveConsoleScript('envs', { PATH: bin })).toBeNull();
      },
    );

    it('DECLINES an entry point it cannot resolve, never falling back (issue #98)', async () => {
      // There is deliberately no fallback to module form. `-m` prepends CWD to
      // sys.path while the console script the gate runs does not, so on any
      // project where something else supplies the package the two spawns import
      // different copies and a change that breaks the suite can read SAFE.
      //
      // Resolution fails on the setups people actually use: pyenv and asdf
      // install `#!/usr/bin/env bash` shims, nix wraps programs the same way,
      // and Windows console scripts are native `.exe` launchers. A fallback
      // would therefore keep the false SAFE alive almost everywhere it started.
      const { toCoverageRunArgs } =
        await import('../../src/analyze/coverage/python-line-coverage.js');

      expect(toCoverageRunArgs('pytest -q', UNRESOLVABLE)).toBeNull();
      expect(toCoverageRunArgs('PYTHONPATH=src pytest -q', UNRESOLVABLE)).toBeNull();
      // No import-affecting variable is needed to make this unsafe: an editable
      // install supplies the competing copy on its own. That is why the decline
      // is unconditional rather than keyed on the environment.
      expect(toCoverageRunArgs('COVERAGE_CORE=sysmon pytest -q', UNRESOLVABLE)).toBeNull();

      // A hoisted PATH must reach the resolver: `sh -c "PATH=/custom/bin pytest"`
      // searches /custom/bin, so this must too.
      expect(toCoverageRunArgs('PATH=/custom/bin pytest -q', RESOLVES)).toEqual({
        args: ['/custom/bin/pytest', '-q'],
        env: { PATH: '/custom/bin' },
      });

      // Forms that are equivalent by RECOGNITION never consult the resolver and
      // are unaffected, which is what keeps the documented command working.
      expect(toCoverageRunArgs('python3 -m pytest -q', UNRESOLVABLE)).toEqual({
        args: ['-m', 'pytest', '-q'],
        env: {},
      });
      expect(toCoverageRunArgs('PYTHONPATH=. python3 -m pytest -q', UNRESOLVABLE)).toEqual({
        args: ['-m', 'pytest', '-q'],
        env: { PYTHONPATH: '.' },
      });
      expect(toCoverageRunArgs('python3 tests/runtests.py', UNRESOLVABLE)).toEqual({
        args: ['tests/runtests.py'],
        env: {},
      });
    });

    it.skipIf(process.platform === 'win32')(
      'reports measurementFailed when the report step fails after a good run',
      async () => {
        // A shim python that satisfies the probe and the `coverage run` (writing a
        // data file) but fails `coverage json`. The old code swallowed that and
        // returned an empty covered set as if measured: the same lie this module
        // exists to prevent.
        const shimDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cov-jsonfail-'));
        const shim = path.join(shimDir, 'python-jsonfail');
        await fs.writeFile(
          shim,
          '#!/bin/sh\n' +
            'case "$*" in\n' +
            '  *"os.path.dirname(os.path.dirname"*) echo /fake/site ; exit 0 ;;\n' +
            '  *" run "*)\n' +
            '     for a in "$@"; do case "$a" in *.coverage) : > "$a" ;; esac; done\n' +
            '     exit 0 ;;\n' +
            '  *" json "*) echo "boom" >&2; exit 1 ;;\n' +
            '  *) exit 0 ;;\n' +
            'esac\n',
          { mode: 0o755 },
        );
        const result = await reportCoverage({
          projectRoot: FIXTURE,
          testCmd: 'python3 -m pytest -q',
          pythonBin: shim,
        });
        expect(result.measurementFailed).toBe(true);
        expect(result.coveredLines.size).toBe(0);
      },
    );

    it.skipIf(NO_PYTHON)('refuses to guess at shell-composite commands', async () => {
      const result = await reportCoverage({
        projectRoot: FIXTURE,
        testCmd: 'pytest -q && echo done',
      });
      expect(result.measurementFailed).toBe(true);
      expect(result.coveredLines.size).toBe(0);
    });
  });

  it.skipIf(NO_COVERAGE)(
    'still reports real files when the suite executes phantom-filename code',
    async () => {
      // A suite that runs exec(compile(src, "string", "exec")) makes coverage.py
      // record a measured "file" named `string` with no source on disk. Without
      // --ignore-errors, `coverage json` exits non-zero and writes nothing, and
      // the reporter silently degrades to zero covered lines: every SAFE verdict
      // on such a project (e.g. Textualize/rich) falsely reads UNPROVEN.
      const phantom = path.resolve(__dirname, '../fixtures/coverage-phantom');
      const result = await reportCoverage({
        projectRoot: phantom,
        testCmd: 'python3 -m pytest -q',
      });
      expect(result.coverageToolFound).toBe(true);
      expect(result.coveredLines.has('svc.py:2')).toBe(true); // covered_function return
    },
  );
});
