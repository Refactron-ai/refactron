import { spawn } from 'node:child_process';
import { redactEnvForRunner } from '../../verify/runners/run.js';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Canonical form for path keys in the covered-lines set: no leading `./`,
 *  forward slashes only. Both producer (this module) and consumer (any
 *  detector that looks up `${ctx.relPath}:${line}`) must apply this so the
 *  set lookup actually hits. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

export interface CoverageReportInput {
  projectRoot: string;
  testCmd?: string; // default: 'python3 -m pytest -q'
  pythonBin?: string; // default: 'python3'
  _probeOverride?: boolean; // test-only injection point
}

export interface CoverageReport {
  coverageToolFound: boolean;
  coveredLines: Set<string>; // `${relPath}:${line}` (1-indexed)
  // Every file coverage.py MEASURED, whether or not any line ran. A changed
  // file missing from this set was never loaded by the suite at all, which is a
  // different claim from "its lines did not execute" and must not be reported
  // as one: the usual cause is the tests importing an installed copy of the
  // package instead of the tree under verification.
  measuredFiles: Set<string>;
  // Every EXECUTABLE line per file (`executed_lines` UNION `missing_lines`),
  // keyed by the same normalized relative path as `coveredLines`. coverage.py
  // attributes a statement's execution to its FIRST line only: continuation
  // lines, closing brackets, blanks and comments are in NEITHER list. A consumer
  // asking "is this physical line covered?" therefore reports every line a
  // formatter wrapped as uncovered. This set is what lets a consumer map a
  // changed line back to the statement that actually ran.
  executableLines: Map<string, Set<number>>;
  // Lines coverage.py EXCLUDED from judgement (`# pragma: no cover`, and in most
  // projects `if TYPE_CHECKING:`). Reported separately from `executableLines`
  // because an excluded statement can never be exercised by ANY test: a consumer
  // that reports it as uncovered must say so differently, instead of asking the
  // user for a test that cannot exist. Note the exclusion is a PHYSICAL RANGE,
  // not a set of statement starts: measured on coverage 7.11, a pragma'd `def`
  // whose body spans 6..11 reports excluded_lines [5,6,7,8,9,10,11].
  excludedLines: Map<string, Set<number>>;
  // Conditional lines with an untaken arc, `${relPath}:${line}` (ADR-14).
  // Undefined means no `--branch` data, not "none": attribution then falls back
  // to the statement rule, which never grants SAFE on absent measurement.
  partialBranchLines?: Set<string>;
  runDurationMs: number;
  // True when coverage.py exists but the measurement could not be performed
  // (unwrappable command, failed run, no data emitted). Callers MUST treat this
  // as "unknown coverage", never as "nothing is covered": claiming zero
  // coverage we never measured is a lie about the user's test suite.
  measurementFailed: boolean;
  measurementFailureReason?: string;
}

// THE RULE THIS MODULE IS GOVERNED BY
//
// SECURITY INVARIANT (ADR-17, GHSA-739m-x9gc-9wjv). The coverage DRIVER is
// launched via `coverageLauncher` (a `-c` program that loads coverage from the
// resolved site-packages FIRST, then restores the suite's sys.path). NEVER
// `python -m coverage` and NEVER an absolute-package-path launch alone: both let
// a repo-local `coverage.py` shadow the real tool (`-m` via cwd; the bare
// abs-path launch via `PYTHONPATH=.`, measured), and a hostile one fabricates
// coverage into a false SAFE. `resolveSitePackages` runs from a NEUTRAL cwd with
// the BASE env only (never the testCmd's PYTHONPATH). If it cannot resolve
// coverage, DECLINE — never fall back to `-m coverage`. This is the line most
// likely to be "simplified" back into the hole; it is written in blood.
//
// `toCoverageRunArgs` returns non-null only when the argv and env it produces
// are observationally equivalent to what `sh -c <testCmd>` would have run.
// Anything it cannot prove equivalent returns null and the verdict degrades to
// unknown.
//
// This is not conservatism for its own sake. The tests gate runs the command
// through a shell (`src/verify/runners/detect.ts`); this path rebuilds it as
// argv because `coverage run` takes argv. If the two disagree about what runs,
// a SAFE verdict becomes two individually-true claims about two DIFFERENT
// executions: the gate proved one tree green, coverage proved another tree
// exercised. That is not a weaker SAFE, it is an incoherent one, and it is how
// this module produced a false SAFE once already (see the entry-point note in
// toCoverageRunArgs). Losing a measurement costs a verdict; losing equivalence
// costs the truth of every verdict this module supports.
//
// Equivalence may be ESTABLISHED in two ways, and only two:
//
//   1. By RECOGNITION. The command is already equivalent in both spawn shapes
//      (`python3 -m pytest`, `python3 tests/runtests.py`). Nothing is rebuilt.
//
//   2. By CONSTRUCTION. We reproduce a bounded shell behaviour so the two
//      spawns agree. There are TWO today, and they compose:
//
//        - PATH resolution of a console entry point, so sys.path[0] is the bin
//          directory in both spawns rather than cwd in ours.
//        - Shebang honouring, so the script runs under the interpreter the
//          kernel would have exec'd rather than under ours.
//
//      Their boundary is enumerated, not approximated. Recognised:
//        #!/abs/path/to/python      (exactly one word)
//        #!/usr/bin/env python3     (exactly two words)
//      Declined: any shebang with ARGUMENTS (`-E`, `-s`, `-I` change which
//      paths Python trusts and we do not forward them), any `env -S` form, a
//      relative interpreter, a non-Python interpreter, and anything unreadable.
//
//      A construction is admitted only when all three hold:
//        a. TOTAL over its input: every case the shell handles we handle
//           identically, or we decline. No "close enough".
//        b. CHECKABLE against an observable, not an argument. Here the
//           shadow-bypass guard independently tests whether coverage measured
//           the copy the gate imported.
//        c. Its failure is a DECLINE, never a fall back to a form already
//           known to be non-equivalent.
//
// Clause (c) is written in blood: falling back to module form when resolution
// failed reintroduced the exact false SAFE the construction existed to remove,
// on every pyenv, asdf and nix setup, because their console scripts are shell
// shims rather than Python files.
//
// Clause (a) is written in blood too. Honouring a shebang while DROPPING its
// arguments looked like a partial win and was a false SAFE: `-E` makes Python
// ignore PYTHONPATH, so the gate imported the installed copy while coverage
// imported the shadow copy and measured it as covered. Worse, that divergence
// had been masked on the previous release by an unrelated failure, so fixing
// the interpreter is what would have unmasked it. Partial reproduction of a
// shell behaviour is not a partial win; it is a confident wrong answer.
//
// So: new shell features get taught to this path only when equivalence can be
// PROVEN, not when a bug report asks for them.

// Shell metacharacters mean the command is a composite the coverage wrapper
// cannot reliably wrap (`pytest && lint`, pipes, substitutions). Guessing here
// risks measuring only part of the suite, so we decline and report unknown.
// Exported so src/verify/test-scope.ts declines exactly the same commands this
// runner does. Two independent parsers of the same testCmd string disagreeing
// about what the shell would do is the failure this file's header warns about;
// sharing the predicate is cheaper than keeping two copies honest.
export const SHELL_COMPOSITE_RE = /&&|\|\||[;|`<>]|\$\(/;

/** How to hand `testCmd` to `coverage run`. Module form needs `-m`; a script
 *  path must be passed positionally, or coverage tries to import a module by
 *  that name (Django's `python3 tests/runtests.py` failed exactly this way). */
/** Split a command into argv, honoring single and double quotes. The tests gate
 *  hands the command to a shell, where `-k "not slow"` is ONE argument; a plain
 *  whitespace split would pass `"not` and `slow"` and silently change which
 *  tests run, so the measured coverage would not match the verified run. */
function tokenizeCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of cmd.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur || started) out.push(cur);
      cur = '';
      started = false;
      continue;
    }
    cur += ch;
  }
  if (cur || started) out.push(cur);
  return out;
}

/** A leading `NAME=VALUE` token, as a shell would read it. The name must be a
 *  valid shell identifier, so `--opt=1` and `-k` are flags rather than
 *  assignments, and an empty value is legal (`FOO= cmd` unsets FOO). */
const ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

/** A `~` the shell would expand: at the start of the value, or after any `:`,
 *  since tilde expansion applies to each colon-separated segment of a
 *  PATH-like assignment value. */
const TILDE_EXPANDS_RE = /(^|:)~/;

/** What to hand `coverage run`, plus any environment the command carried.
 *  The env is separate because `coverage run` takes argv, not a shell line. */
export interface CoverageRunPlan {
  args: string[];
  env: Record<string, string>;
  /** The interpreter named by a resolved console script's shebang, when it is
   *  an absolute path. `coverage run <script>` runs the file as SOURCE in the
   *  CURRENT interpreter and never honours the shebang, while the shell that
   *  runs the tests gate does, so without this a venv's pytest would be
   *  executed by whatever python we happened to spawn. Absent when the shebang
   *  names no specific interpreter (`#!/usr/bin/env python3`), where the
   *  caller's python resolves the same way the shell's would. */
  interpreter?: string;
}

/** Resolves a console entry point (`pytest`) to the script file a shell would
 *  execute for it, or null when it cannot be resolved to a Python script we can
 *  hand to `coverage run` positionally. Injected so the classifier stays pure
 *  and testable, and REQUIRED so no call site can omit it and silently select a
 *  spawn shape the gate would not have used. */
export interface ResolvedEntryPoint {
  script: string;
  interpreter?: string;
}

export type EntryPointResolver = (
  name: string,
  env: Record<string, string>,
) => ResolvedEntryPoint | null;

export function toCoverageRunArgs(
  testCmd: string,
  resolveEntryPoint: EntryPointResolver,
): CoverageRunPlan | null {
  if (SHELL_COMPOSITE_RE.test(testCmd)) return null;
  const tokens = tokenizeCommand(testCmd);
  if (tokens.length === 0) return null;

  // Hoist a leading run of `NAME=VALUE` assignments. The tests gate runs the
  // command through `sh -c`, where these are environment assignments; this
  // runner spawns argv directly, so without hoisting `PYTHONPATH=.` was
  // classified as a MODULE NAME below and `coverage run -m PYTHONPATH=.` wrote
  // no data file at all. That silently capped every project following our own
  // shadow-bypass advice at UNPROVEN. Stop at the first non-assignment, so a
  // real argument that merely contains `=` (`pytest -k a=b`) is never eaten.
  const env: Record<string, string> = {};
  let i = 0;
  for (; i < tokens.length; i++) {
    const m = ASSIGNMENT_RE.exec(tokens[i] ?? '');
    if (!m) break;
    const value = m[2] as string;
    // `PYTHONPATH=$HOME/x` and `PYTHONPATH=~/x` are expanded by the shell the
    // tests gate runs under, and would be passed through literally here. The
    // two runs would then see different paths, so the coverage numbers would
    // describe a run that was never verified. Decline instead: unknown is
    // honest, a mismatch is not. (Backticks and `$(` are already refused by
    // SHELL_COMPOSITE_RE above. Tilde expands after each `:` in a PATH-like
    // value, so it is refused anywhere a path segment can start.)
    if (value.includes('$') || TILDE_EXPANDS_RE.test(value)) return null;
    env[m[1] as string] = value;
  }
  const afterEnv = tokens.slice(i);
  if (afterEnv.length === 0) return null;

  // Drop a leading interpreter: `python3 -m pytest` and `python3 script.py`
  // both describe what to run, not how to spawn it.
  let rest = afterEnv;
  if (/^python[0-9.]*$/.test(afterEnv[0] ?? '')) rest = afterEnv.slice(1);
  if (rest.length === 0) return null;

  const head = rest[0] ?? '';
  if (head === '-m') {
    const mod = rest.slice(1);
    return mod.length > 0 ? { args: ['-m', ...mod], env } : null;
  }
  // A script path (ends in .py, or is a path) runs positionally; anything else
  // is a console entry point we invoke as a module (pytest, vitest).
  if (head.endsWith('.py') || head.includes('/') || head.includes('\\')) {
    return { args: [...rest], env };
  }

  // Console entry point. Prefer to run the SAME file the gate's shell would
  // run, positionally, so sys.path[0] is the bin directory in both spawns and
  // neither run can import a copy the other did not. This is what lets the
  // shadow-bypass guard work: when an editable install resolves imports to the
  // ORIGINAL tree, coverage now measures that tree too, the shadow file is
  // absent from measuredFiles, and the guard fires as designed.
  const resolved = resolveEntryPoint(head, env);
  if (resolved !== null) {
    return {
      args: [resolved.script, ...rest.slice(1)],
      env,
      ...(resolved.interpreter ? { interpreter: resolved.interpreter } : {}),
    };
  }

  // Unresolvable, so decline. There is deliberately no fallback to `-m` here.
  //
  // Module form is what shipped before, and it is the shape that produced the
  // false SAFE: `-m` prepends CWD to sys.path while the console script the gate
  // runs does not, so on any project where something else supplies the package
  // (an editable install, a plain install, PYTHONPATH) the gate ran the ORIGINAL
  // tree while coverage measured the SHADOW tree, and fusing those two true
  // statements produced SAFE for a change that broke the suite.
  //
  // Falling back to it would keep that hole open wherever resolution fails, and
  // resolution fails on exactly the setups people use: pyenv and asdf install
  // `#!/usr/bin/env bash` shims, nix wraps programs the same way, and Windows
  // console scripts are native `.exe` launchers. That is not a corner, so the
  // fallback is not a safety net; it is the bug with narrower reach.
  //
  // The cost is bounded and honest. `python3 -m pytest -q`, which is what
  // auto-detection produces and what every documented example teaches, is
  // module form on BOTH sides and never reaches this branch.
  return null;
}

/** Find the file a shell would execute for a console entry point, and accept it
 *  only if it is a Python script we can hand to `coverage run` positionally.
 *
 *  The shebang check is the whole safety argument. A Windows console script is
 *  an `.exe` launcher and a Unix one is a Python file with `#!.../python`;
 *  handing the former to `coverage run` would fail, so it is rejected here and
 *  the caller falls back to module form. Resolution uses the EFFECTIVE PATH,
 *  including any hoisted `PATH=` prefix, so it agrees with what the gate's
 *  shell would have resolved. */
export function resolveConsoleScript(
  name: string,
  env: Record<string, string>,
): ResolvedEntryPoint | null {
  // Windows declines, deliberately rather than incidentally. Console scripts
  // there are native `.exe` launchers with no Python shebang, and `coverage
  // run` cannot execute one. We also never consult PATHEXT, so a lookup would
  // either find nothing or find some extensionless file the shell would not
  // have run: `accessSync(X_OK)` is documented as having no effect on Windows
  // and behaves as F_OK, so it cannot filter that out. Refusing here is the
  // decision, and the caller's message names module form as the way through.
  if (process.platform === 'win32') return null;

  // A name containing a separator is a path, not a PATH lookup. The shell runs
  // it relative to ITS cwd, which is the shadow root and not this process's cwd,
  // so we cannot reproduce it here.
  if (name.includes('/') || name.includes('\\')) return null;

  const search = env.PATH ?? process.env.PATH ?? '';
  for (const dir of search.split(path.delimiter)) {
    // An empty element means cwd to a POSIX shell, and a relative element is
    // resolved against the SHELL's cwd. Either way the shell would search a
    // directory we cannot identify from here, and anything we found later on
    // PATH might be shadowed by something in it. Decline rather than guess.
    if (dir === '' || !path.isAbsolute(dir)) return null;

    const candidate = path.join(dir, name);
    try {
      // The shell skips a match it cannot execute and keeps searching, so this
      // must too: a non-executable file earlier on PATH is invisible to it.
      fsSync.accessSync(candidate, fsSync.constants.X_OK);
      if (!fsSync.statSync(candidate).isFile()) continue;
    } catch {
      continue; // missing, not executable, or a directory: keep searching
    }

    // This is the file the shell would run. It is the ONLY candidate we may
    // consider: scanning past it to find a Python script further down would
    // run a different program than the gate did, which is precisely the
    // divergence this resolver exists to remove.
    try {
      const fd = fsSync.openSync(candidate, 'r');
      try {
        const buf = Buffer.alloc(512);
        const read = fsSync.readSync(fd, buf, 0, 512, 0);
        const first = (buf.subarray(0, read).toString('utf8').split('\n')[0] ?? '').replace(
          /\r$/,
          '',
        );
        // Only a Python script can be handed to `coverage run` positionally.
        // A shim (`#!/usr/bin/env bash`, pyenv and asdf install these), a
        // native launcher (Windows `.exe`), or a shebang we cannot read is not
        // one, and the caller declines rather than substituting module form.
        if (first.startsWith('#!') && /python/i.test(first)) {
          // Exactly two shebang shapes are reproducible. Everything else
          // declines, because we run `<interpreter> -m coverage run <script>`
          // and can only claim equivalence when that is what the kernel would
          // have done.
          //
          //   #!/abs/path/to/python          one word   -> run under it
          //   #!/usr/bin/env python3         two words  -> PATH resolves the
          //                                               same for us, so the
          //                                               caller's python stands
          //
          // A shebang carrying ARGUMENTS is refused, and that is the important
          // case rather than a tidiness rule. `-E`, `-s`, `-I` change which
          // paths Python trusts: `-E` makes it ignore PYTHONPATH entirely. The
          // gate execs the script so the kernel applies those flags; dropping
          // them here would let the gate import the INSTALLED copy while
          // coverage imports the SHADOW copy and measures it as covered, and
          // fusing those yields SAFE for a change no test ran. Fedora and RHEL
          // ship `#!/usr/bin/python3 -s` as their packaging default, so this is
          // a real shape, not a hypothetical one.
          //
          // Forwarding a flag whitelist is deliberately NOT done. It is
          // plausibly sound for -E and -s and definitely unsound for -S, which
          // would break importing coverage itself, and the rule at the top of
          // this file says features are taught here only when equivalence can
          // be proven.
          const words = first.slice(2).trim().split(/\s+/).filter(Boolean);
          const head0 = words[0] ?? '';
          if (/(^|\/)env$/.test(head0)) {
            // `env python3` and nothing more. `env -S ...` re-splits the line
            // and is not reproduced.
            const named = words[1] ?? '';
            // Carry the NAME, not nothing. `env python3.11` is a different
            // binary from our `python3`, and running the script under ours is
            // the very mismatch this resolves. A bare name is resolved by the
            // spawn through the same PATH the shell would have searched.
            return words.length === 2 && /python/i.test(named)
              ? { script: candidate, interpreter: named }
              : null;
          }
          return words.length === 1 && path.isAbsolute(head0)
            ? { script: candidate, interpreter: head0 }
            : null;
        }
      } finally {
        fsSync.closeSync(fd);
      }
    } catch {
      // unreadable: treat as not resolvable
    }
    return null;
  }
  return null;
}

/** Resolve the site-packages directory that holds the REAL coverage for `runner`,
 *  or null if coverage is not importable there.
 *
 *  SECURITY (ADR-17, GHSA-739m-x9gc-9wjv). Two properties, both load-bearing:
 *
 *  1. **Neutral cwd.** Runs from a fresh EMPTY temp dir, never the shadow, so a
 *     repo-local `coverage.py` on cwd cannot shadow the resolve.
 *  2. **Base env only, never the testCmd's `PYTHONPATH`.** An attacker-hoisted
 *     `PYTHONPATH` (even the documented `PYTHONPATH=.`) would otherwise point the
 *     resolve at a hostile `coverage.py` that precedes site-packages. We resolve
 *     the interpreter's OWN installed coverage. Cost: a repo whose coverage is
 *     importable ONLY via the testCmd's PYTHONPATH now declines to UNPROVEN — the
 *     fail-safe direction.
 *
 *  Returns `dirname(dirname(coverage.__file__))` (the site-packages dir), which
 *  `coverageLauncher` inserts at `sys.path[0]` so the driver's `import coverage`
 *  resolves from there ahead of cwd and PYTHONPATH. A namespace `coverage/` dir
 *  (`__file__ = None`) raises in the probe and yields null, exactly as before. */
async function resolveSitePackages(
  pythonBin: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const neutral = await fs.mkdtemp(path.join(os.tmpdir(), 'refactron-cov-probe-'));
  try {
    return await new Promise((resolve) => {
      const p = spawn(
        pythonBin,
        ['-c', 'import coverage,os;print(os.path.dirname(os.path.dirname(coverage.__file__)))'],
        { cwd: neutral, env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      p.stdout.on('data', (d: Buffer) => {
        out += d.toString();
      });
      p.on('exit', (code) => resolve(code === 0 && out.trim() ? out.trim() : null));
      p.on('error', () => resolve(null));
    });
  } finally {
    await fs.rm(neutral, { recursive: true, force: true });
  }
}

/** The `-c` program that launches the coverage CLI immune to module shadowing.
 *  It inserts the resolved site-packages at `sys.path[0]`, imports coverage from
 *  THERE (ahead of cwd and PYTHONPATH), then removes the inserted entry so the
 *  SUITE runs with the exact `sys.path` the gate gave it — observational
 *  equivalence with the tests-gate run is preserved (verified: the suite's
 *  `sys.path[0]` is identical to the gate's). Never `-m coverage`: that resolves
 *  from cwd and reopens GHSA-739m-x9gc-9wjv. `site` is JSON-encoded, a valid
 *  Python string literal on every platform. */
function coverageLauncher(site: string): string {
  return `import sys; sys.path.insert(0, ${JSON.stringify(site)}); import coverage.cmdline as C; del sys.path[0]; sys.exit(C.main())`;
}

/** Run a command in `cwd` with `env` and resolve to its exit code + stderr.
 *  Returns null exit code on spawn error. */
function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    p.stdout.on('data', () => {
      /* drop */
    });
    p.on('exit', (code) => resolve({ code, stderr }));
    p.on('error', () => resolve({ code: null, stderr }));
  });
}

export async function reportCoverage(input: CoverageReportInput): Promise<CoverageReport> {
  const t0 = performance.now();
  const pythonBin = input.pythonBin ?? 'python3';
  // Module form, matching what `detect.ts` auto-detects and what every
  // documented example teaches. It is equivalent by recognition in both
  // spawn shapes on every platform, whereas the bare console script it used
  // to default to can only be made equivalent where it resolves.
  const testCmd = input.testCmd ?? 'python3 -m pytest -q';

  const plan = toCoverageRunArgs(testCmd, resolveConsoleScript);
  if (plan === null) {
    return {
      coverageToolFound: true,
      coveredLines: new Set(),
      measuredFiles: new Set(),
      executableLines: new Map(),
      excludedLines: new Map(),
      runDurationMs: performance.now() - t0,
      measurementFailed: true,
      // Name the remedy that fits the CAUSE. This branch is shared by four of
      // them, and only one is fixed by module form: telling someone whose
      // command is `pytest && lint` to write `python -m pytest` sends them
      // round the same loop, which is the confidently-wrong-remedy defect this
      // module keeps having to relearn.
      measurementFailureReason: SHELL_COMPOSITE_RE.test(testCmd)
        ? `cannot run this test command under coverage: ${testCmd}. It combines ` +
          `several commands, and measuring only part of the suite would describe ` +
          `a run that never happened. Point testCmd at the test command alone.`
        : `cannot run this test command under coverage: ${testCmd}. If it names ` +
          `a console entry point (for example \`pytest\`), use module form ` +
          `instead (\`python -m pytest\`), which can be measured on every ` +
          `platform. Console scripts are native launchers on Windows and shell ` +
          `shims under pyenv, asdf and nix, and neither can be run under coverage.`,
    };
  }

  // Run under the interpreter the resolved console script's shebang names, not
  // ours: `coverage run <script>` executes the file in the CURRENT interpreter,
  // so a venv's pytest must run under its own python or the shadow-bypass floor
  // blames the user's sys.path.
  const runner = plan.interpreter ?? pythonBin;

  // Resolve the REAL coverage's site-packages for the runner (ADR-17). Neutral
  // cwd + base env, so a repo-local `coverage.py` on cwd OR a hoisted
  // `PYTHONPATH` cannot redirect us to a hostile coverage. Null means coverage
  // is not importable for this interpreter (or a namespace `coverage/` dir): the
  // run the gate performed cannot be measured, so decline — never fall back to
  // `-m coverage`, the unsound form this change exists to remove.
  //
  // `_probeOverride` is the test-only injection: false forces the not-found
  // decline; true and undefined resolve for real.
  const site =
    input._probeOverride === false
      ? null
      : await resolveSitePackages(runner, redactEnvForRunner(process.env));
  if (site === null) {
    return {
      coverageToolFound: false,
      coveredLines: new Set(),
      measuredFiles: new Set(),
      executableLines: new Map(),
      excludedLines: new Map(),
      runDurationMs: performance.now() - t0,
      measurementFailed: false,
    };
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'refactron-cov-'));
  const dataFile = path.join(tmp, '.coverage');
  const jsonFile = path.join(tmp, 'coverage.json');
  // Order is deliberate: the command's own assignments override the inherited
  // environment, which is the point of writing them, and COVERAGE_FILE goes
  // last so a test command cannot redirect the data file we are about to read.
  //
  // That last part is defence in depth, not the load-bearing protection. A
  // mutation that flips the order alone changes nothing observable, because
  // `--data-file` is passed on argv to both `coverage run` and `coverage json`
  // below and argv beats the environment. Both are kept: the ordering states
  // the intent, `--data-file` enforces it.
  // Redacted for the same reason as the tests gate (SEC-3): this spawn executes
  // the repository's own test suite, which the diff under verification defines.
  // Fixing only the gate left the leak wide open here - the end-to-end probe
  // still read every credential - because coverage runs the suite a second time.
  const env = { ...redactEnvForRunner(process.env), ...plan.env, COVERAGE_FILE: dataFile };

  const covered = new Set<string>();
  const measured = new Set<string>();
  const executable = new Map<string, Set<number>>();
  const excludedByFile = new Map<string, Set<number>>();
  const partial = new Set<string>();
  let failureReason: string | undefined;
  try {
    // 1) Run tests under coverage. A nonzero exit here is NOT itself a failure
    // (a red suite still produces valid coverage data); what matters is whether
    // a data file was written at all. A command coverage could not launch
    // leaves nothing behind, and that must read as unknown, not zero.
    // `--branch` also measures arcs, catching an untaken branch on a conditional
    // whose header executed (ADR-14). No measured runtime cost.
    const launch = coverageLauncher(site);
    const runArgs = ['-c', launch, 'run', '--branch', '--data-file', dataFile, ...plan.args];
    const run = await runCmd(runner, runArgs, input.projectRoot, env);
    const wroteData = await fs
      .access(dataFile)
      .then(() => true)
      .catch(() => false);
    if (!wroteData) {
      failureReason =
        run.code === null
          ? `coverage run could not be spawned: ${run.stderr.trim().slice(0, 200)}`
          : `coverage run produced no data (exit ${run.code}): ${run.stderr.trim().slice(0, 200)}`;
    }

    // 2) Emit JSON. --ignore-errors: a suite that runs exec(compile(src,
    // "string", "exec")) leaves a measured "file" with no source on disk, and
    // without the flag `coverage json` exits non-zero and writes NOTHING,
    // silently zeroing coverage for every real file. Phantom entries are
    // dropped; real files keep their data.
    // The SAME interpreter that produced the data, not ours. `coverage json`
    // re-parses every measured source to compute missing_lines, and with
    // --ignore-errors a file the reporting interpreter cannot parse is dropped
    // SILENTLY with exit 0. Reporting under a different version than the run
    // therefore makes a file using newer syntax vanish from measuredFiles, and
    // the shadow-bypass floor then blames the user's sys.path for what was
    // really a parser mismatch: the exact wrong-remedy symptom this issue is
    // about, reproduced through the report step.
    const emit = await runCmd(
      runner,
      ['-c', launch, 'json', '--ignore-errors', '--data-file', dataFile, '-o', jsonFile],
      input.projectRoot,
      env,
    );
    if (failureReason === undefined && emit.code !== 0) {
      // Data exists but we could not turn it into a report. Reporting an empty
      // covered set here would be the same lie as a failed run: unknown, not zero.
      failureReason = `coverage json failed (exit ${emit.code ?? 'null'}): ${emit.stderr.trim().slice(0, 200)}`;
    }

    // 3) Parse.
    try {
      const raw = await fs.readFile(jsonFile, 'utf8');
      const parsed = JSON.parse(raw) as {
        files?: Record<
          string,
          {
            executed_lines?: number[];
            missing_lines?: number[];
            excluded_lines?: number[];
            missing_branches?: [number, number][]; // untaken arcs [source, dest]
          }
        >;
      };
      for (const [relPath, fileData] of Object.entries(parsed.files ?? {})) {
        // Normalize the path: strip a leading `./` and force forward slashes
        // so keys match whatever convention the detector emits for its own
        // relPath. Without this, coverage.json's `flask_appbuilder/foo.py`
        // never matches a detector lookup of `./flask_appbuilder/foo.py:42`.
        const normalized = normalizePath(relPath);
        measured.add(normalized);
        // executed UNION missing UNION excluded. The first two are the statement
        // starts coverage.py judged; the third is the one that bites. A statement
        // matched by `exclude_lines` (`# pragma: no cover`, and in most projects
        // `if TYPE_CHECKING:`) is dropped from BOTH judged lists, so an executable
        // set built from executed+missing alone has a HOLE where that code lives.
        // A consumer resolving a changed line to its enclosing statement would
        // then walk backwards through the hole and land on whatever covered
        // statement precedes it, reporting provably-unexecuted code as covered.
        // Excluded lines are still code, so they belong in the executable set:
        // they are never in `coveredLines`, so anything attributed to them stays
        // honestly unproven.
        const stmts = executable.get(normalized) ?? new Set<number>();
        for (const line of fileData.executed_lines ?? []) {
          covered.add(`${normalized}:${line}`);
          stmts.add(line);
        }
        for (const line of fileData.missing_lines ?? []) {
          stmts.add(line);
        }
        const skipped = excludedByFile.get(normalized) ?? new Set<number>();
        for (const line of fileData.excluded_lines ?? []) {
          stmts.add(line);
          skipped.add(line);
        }
        // The arc SOURCE is the conditional whose branch went untested. The dest
        // is an unexecuted line (statement rule handles it) or a join point.
        for (const [srcLine] of fileData.missing_branches ?? []) {
          partial.add(`${normalized}:${srcLine}`);
        }
        executable.set(normalized, stmts);
        excludedByFile.set(normalized, skipped);
      }
    } catch {
      // JSON missing or unparseable. We have no measurement, so say so rather
      // than returning an empty covered set that reads as "nothing is covered".
      if (failureReason === undefined) {
        failureReason = 'coverage report could not be read';
      }
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }

  return {
    coverageToolFound: true,
    coveredLines: covered,
    measuredFiles: measured,
    executableLines: executable,
    excludedLines: excludedByFile,
    partialBranchLines: partial,
    runDurationMs: performance.now() - t0,
    measurementFailed: failureReason !== undefined,
    ...(failureReason !== undefined ? { measurementFailureReason: failureReason } : {}),
  };
}
