# Changelog

All notable changes to Refactron are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.4.6] - 2026-09-07

### Security - a coverage-based `SAFE` on an untrusted diff was forgeable (BREAKING DEFAULT)

Refactron measured coverage and the pass/fail gates by running the diff's OWN
test suite in the same process as the measurement, so a hostile diff controlled
the evidence. A ~6-line `conftest.py` (public coverage API,
`Coverage.current().get_data().add_arcs`) marked a never-executed changed line as
covered and earned a false `SAFE` for an untested change. Reproduced end-to-end;
present in 0.3.1-0.4.5. A false `SAFE` is the one defect this tool exists to
prevent, so the fix changes a default.

**A would-be-`SAFE` is now WITHHELD to `UNPROVEN` for an UNTRUSTED diff, which is
the default.** No launcher can stop in-process tampering (the attacker owns the
process), so Refactron stops trusting the forgeable measurement rather than trying
to detect the forgery. Trust is asserted by the operator, never inferred from the
diff:

- CLI: pass `--trusted` for a diff whose author you trust (self/dev use).
- MCP / library: `trusted: true` (default `false`).

`UNSAFE` is unchanged. Every report now carries `trustMode: 'trusted' |
'untrusted'`, and a withheld verdict's `reason` begins "SAFE is withheld", so a
consumer can tell a trust withhold from a real coverage gap. A trust-grade `SAFE`
over an untrusted diff will require a hermetic (out-of-process) run. (ADR-19)

**Upgrade note.** If you rely on a coverage-based `SAFE` for diffs you author
yourself, add `--trusted` (or `trusted: true`) to keep it. If you verify untrusted
PRs in CI, the default is now the correct one: those verdicts degrade to
`UNPROVEN` instead of a forgeable `SAFE`. Exit codes are unchanged (`UNPROVEN` and
`SAFE` both exit 0).

Also hardened, as defense-in-depth for the trusted path:

- A repo-root `coverage.py` can no longer shadow the coverage driver (ADR-17).
- A changed statement the diff excludes from coverage (`# pragma: no cover`, a
  coverage config) now floors the verdict instead of being subtracted (ADR-18).


### Added — `--flaky-check`, an opt-in stability check

A default `SAFE` assumes your tests are deterministic. The suite runs once, so a
test that passes because of randomness, ordering, timing, or hash-seed dependence
— not because behaviour is preserved — still counts toward `SAFE`. The single-run
fast path cannot tell a stable green from a lucky one.

`verify-diff --flaky-check` closes that gap. After a would-be-`SAFE` verdict, it
reruns the suite K times (default 3) on fresh trees, each under a different
`PYTHONHASHSEED`. If any test's outcome varies across the reruns, the green was
never stable, so the verdict floors at `UNPROVEN`, naming the flaky test:

```
[UNPROVEN] Tests pass, but a test outcome varied across reruns
(tests/test_x.py::test_scale); the green is flaky, not stable. Fix the
flakiness or the verdict cannot be SAFE.
```

Off by default and slower (K extra full-suite runs); downgrade-only (a varied
test moves `SAFE` to `UNPROVEN`, a stable rerun never lifts a verdict); an
inconclusive rerun that times out is skipped, not held against you. Varying
`PYTHONHASHSEED` catches dict/set order-dependence deterministically; timing,
network, and `random`-based flakes are probabilistic, so K reruns give K chances.
Python-focused, like coverage and mutation. Decided on measurement (ADR-16). The
default gate is documented as assuming deterministic tests.

### Changed — `--mutate` now perturbs constants, not only operators

`--mutate` swapped only operators, so a changed line whose behaviour lives in a
constant — a number, a string, `True`/`False`/`None`, or a bare `return
<literal>` — generated zero mutants and earned `SAFE` even when no test asserted
the value. `verify-diff --mutate` now also mutates those constants; a surviving
constant mutant floors the verdict at `UNPROVEN`, naming it:

```
[UNPROVEN] Tests pass, but a mutant of a changed statement survived
(status.py:2, 3 to 0): no test failed when its behaviour changed. Add a test
that asserts on it.
```

Docstrings and other behaviour-inert literals are excluded (by AST span), so an
inert string cannot manufacture a false survivor, and the budget is filled
operators-first so a constant never evicts a higher-signal operator mutant. Still
opt-in, downgrade-only, and Python-only (ADR-15).

## [0.4.5] — 2026-09-01

### Fixed — a changed conditional with an untested branch could earn `SAFE`

The coverage rule was statement-level: a changed `if`/`elif` counted as covered
the moment its header executed. So a change to a conditional whose one branch no
test entered earned `SAFE` with the changed behaviour untested. A changed
conditional is one of the most common regression shapes, and it is exactly where
statement coverage is weakest.

`SAFE` now also requires that changed conditionals were fully branched. With
`coverage.py --branch`, a changed line reported as a partially-taken branch
floors the verdict at `UNPROVEN`, and the reason names it:

```
[UNPROVEN] Tests pass, but a changed conditional has a branch no test took
(calc.py:3). Add a test that enters the other branch.
```

The decision was made on measurement, not assertion (ADR-14). `--branch` added
no runtime cost on a real 600-test suite. The flip is surgical: it bites only a
changed conditional with an untaken arc, never straight-line code (0% affected)
or a fully-exercised conditional, so it cannot make `SAFE` unreachable for
ordinary changes.

Fail-safe throughout: without `--branch` data the check falls back to the
statement rule, and absent data never grants `SAFE`. The rule can only move
`SAFE` to `UNPROVEN`, never the other way.

Branch coverage is Python-only, like the rest of the coverage check. A
TypeScript or mixed diff still caps at `UNPROVEN`.

### Added — `--mutate`, an opt-in check for whether the change was asserted

Coverage proves a changed statement ran, not that any test would fail if its
behaviour changed. A line a test executes but never asserts on earns `SAFE`.

`refactron verify-diff --mutate` perturbs the operators in the changed statements
(boundary, arithmetic, boolean), reruns the suite against each, and floors the
verdict at `UNPROVEN` if any mutant survives — the suite passed while the changed
behaviour was altered — naming the survivor:

```
[UNPROVEN] Tests pass, but a mutant of a changed statement survived
(calc.py:2, + to -): no test failed when its behaviour changed.
```

Off by default and slower (it reruns the suite once per mutant), so it is a deep
check, not the fast gate. Downgrade-only: a survivor can move `SAFE` to
`UNPROVEN`, never the reverse; a clean run never lifts a verdict; an inconclusive
mutant (timeout) is skipped. Bounded to the changed statements, Python-only. See
ADR-15.

---

## [0.4.4] — 2026-08-21

### Fixed — a pytest config file could turn `UNSAFE` into `SAFE`

This is an inverted verdict, not a missed abstention, and it was reachable in
every release from 0.4.1 to 0.4.3. If your project configures pytest with
`addopts` or `testpaths`, read this.

Refactron classified the scope of a run from the **command string**. A config
file narrowing the suite was invisible, so the report said `scope: "full"`, the
classifier's strongest claim, for a run that was narrowed.

Reproduced, with a control:

```
calc.py            def add(a, b): return a + b   ->   return a - b
tests/test_a.py    asserts isinstance(add(1,2), int)   # executes the line
tests/test_b.py    asserts add(1,2) == 3               # catches the break
pytest.ini         [pytest]  addopts = -k test_a       # excludes test_b

full suite:   FAILED tests/test_b.py::test_b - assert -1 == 3
refactron:    SAFE  "Tests pass and the changed code is covered."
```

Every gate was satisfied honestly. Tests passed because the failing one never
ran. Coverage was complete because the weak test executed the changed statement.
The command carried no filter. With no config file present the same change
correctly returned `UNSAFE`, so it was the config that flipped the verdict.

`addopts` and `testpaths` are now read from `pytest.ini`, `tox.ini`, `setup.cfg`
and `pyproject.toml`, and the verdict floors at `UNPROVEN` when either narrows
the run. The signal names the file, so the reason no longer points at a command
line that contains no filter:

```
-k selects a subset of the suite (from addopts in pytest.ini)
```

**This does not floor every configured project.** `addopts` goes through the same
scanner the command line uses, so `addopts = -q --strict-markers --tb=short`
still classifies as `full`. A fix that made `SAFE` unreachable for any project
with a tidy `pytest.ini` would have been worse than the defect it closed.

`testpaths` is answered rather than assumed. `testpaths = ["tests"]` in a project
whose tests all live under `tests/` excludes nothing and stays `full`; the same
line in a project with a test file outside that directory floors the verdict and
names the file:

```
testpaths in pytest.ini leaves out extra/test_c.py
```

The first draft of this fix treated any `testpaths` as narrowing. That is the
safe direction, but `testpaths = tests` is close to the most common line in any
pytest config, and flooring it would have made this fix worse than the defect for
a large share of projects. Refactron now compares the setting against the test
files your repository actually has. Where it cannot answer — the discovery
pattern is customised through `python_files`, or the scan came back empty — it
floors and says which of those it was.

Only the repository root is read. pytest walks up to find its rootdir, but your
suite runs inside an isolated copy whose parent is a temporary directory, so a
config above your repository never reaches the run being judged.

### Changed

- **`full` now means more than it did.** It was "no filter in the command"; it is
  now "no filter in the command, the environment, or your pytest config". It is
  still not a proof that the whole suite ran: a plugin or a `conftest.py` can
  deselect tests in ways nothing here inspects, and `docs/verification/verdicts.mdx`
  says so.
- Docs corrected in four places that stated config narrowing was not seen:
  `docs/verification/verdicts.mdx`, `docs/mcp/tool-reference.mdx`, `SECURITY.md`,
  and ADR-12. ADR-12 also carried a stale claim that an ambient `PYTEST_ADDOPTS`
  was undetectable; it has been detected since 0.4.1, and the amendment records
  both corrections.

### Known limitations, unchanged

- A vitest `include` or a jest `testMatch` is still not read. Those are
  JavaScript and would have to be executed rather than parsed. They cannot
  currently produce a false `SAFE`, because coverage is Python-only and a
  JavaScript or TypeScript change already caps at `UNPROVEN`.
- The `testpaths` comparison uses the test files already in your repository. A
  test file **added by the diff itself**, in a directory `testpaths` excludes,
  is not counted, so a change that ships a new test which never gets collected
  can still read `full`. The CLI's existing "this diff modifies test files" note
  is the only signal there today. Narrower than the defect fixed above, and
  tracked separately.
- `full` is still not a proof that the whole suite ran. A plugin or a
  `conftest.py` can deselect tests in ways nothing here inspects.

---

## [0.4.3] — 2026-08-20

### Security

Two fixes to what the verified test suite can reach. Neither is exploitable
without already being able to supply a diff or a test command to Refactron,
which is the normal mode of use, so both are worth taking.

- **The verified suite no longer inherits your credentials.** Refactron runs the
  repository's own test suite, and that suite is defined by the diff under
  verification. It was handed the full parent environment. Reproduced: a test in
  the verified suite read `REFACTRON_TOKEN`, `GITHUB_TOKEN`, `NPM_TOKEN` and
  `AWS_SECRET_ACCESS_KEY` in plaintext. This matters most in the deployment
  Refactron is built for, a CI gate verifying an untrusted pull request, where
  the environment holds the credentials of the repository being protected.

  Credentials are now removed from the environment of every spawn that executes
  your suite. This is a denylist, covering the common names plus anything ending
  in `_TOKEN`, `_SECRET`, `_API_KEY`, `_PASSWORD` or `_CREDENTIALS`. `PATH`,
  `HOME`, `VIRTUAL_ENV` and the rest of your toolchain are untouched.

  This is redaction, not a sandbox. Running `verify-diff` still runs your tests,
  exactly as running them yourself does. `SECURITY.md` now says so plainly.

- **A diff can no longer name a file outside the repository.** The path came from
  the diff's own `+++` header and was read with no containment check, so a diff
  naming `../../../.ssh/id_rsa` caused Refactron to open it. The shadow tree
  blocked the resulting write, but the read had already happened, and whether the
  patch applied was an oracle for the file's contents. Containment now runs at
  intake, before the first read.

Both fixes above shipped with a bypass of themselves, found in review of this
release and fixed here. Recording that plainly, because the pattern is the
lesson: a redaction that covers two of three spawns is not a redaction, and a
containment check that is lexical while the read follows symlinks is not
containment.

- **The coverage probe was redacted too.** `-m coverage --version` runs with the
  project root as cwd, and `-m` puts cwd on `sys.path`, so a `coverage.py` at
  the repository root shadows the real module and the diff under verification
  executes as us. That probe passed no environment at all and inherited
  everything, while the two coverage spawns after it were correctly redacted.
  The env parameter is now required rather than optional, so a call site that
  omits it fails to compile.

- **Diff paths now resolve symlinks before they are trusted.** The containment
  check was lexical, but `readFile` follows links, so `repo/link -> /secrets`
  let `link/creds.txt` pass and read outside anyway. Reproduced as an oracle:
  a diff whose removal line guessed the target's contents was accepted, while a
  wrong guess reported "diff did not apply", which discloses the file one guess
  at a time. Both cases now return the same message.

### Changed

- `SECURITY.md` rewritten. The previous version described the refactoring product
  removed in 0.4.0 and stopped its supported-versions table at `0.2.x`. It now
  documents the shipped product, records
  [GHSA-q3vj-5qq5-m84g](https://github.com/Refactron-ai/refactron/security/advisories/GHSA-q3vj-5qq5-m84g),
  and adds a section the old policy lacked: what Refactron explicitly does **not**
  defend. We do not sandbox your test suite, the MCP server has no authentication
  because a stdio transport's trust boundary is the process spawn, `SAFE` is not a
  proof of correctness, and narrowing detection is a strong check rather than a
  guarantee.

---

## [0.4.2] — 2026-08-19

### Security

**Refactron could write to your working tree. Update immediately.**

The shadow tree was populated with **hardlinks**, so every file your diff did not
change shared an inode with your real file. The tests gate then runs the test
suite *as the diff defines it* — and a diff may edit `conftest.py`, a fixture, or
any test file. Any in-place write from that suite went straight through into your
repository, and the verdict said `SAFE` while it happened.

**This did not require an attacker.** Any suite with a snapshot updater, a golden-
file regenerator, or a test that writes a fixture could silently modify the
repository being verified.

- **Affected:** every published version, `0.1.0-beta.2` through `0.4.1`, on npm
  and PyPI.
- **Reachable from:** the CLI, and the MCP `verify_change` tool, which applies no
  authentication.
- **Contradicts:** the guarantee stated in the README, the docs and
  `SECURITY.md` — "your working tree is never touched" — which was false for the
  entire life of the product.
- **Fixed by:** copying instead of hardlinking. `COPYFILE_FICLONE` keeps the
  speed on APFS, Btrfs and XFS; elsewhere it degrades to a normal copy. Measured
  at 522–568ms on a 601-module repository, against a verification that already
  costs three suite runs.

Two related fixes in the same path:

- **Shadow-tree containment could be escaped by a symlink.** The check was
  lexical (`path.relative(...).startsWith('..')`), which correctly refuses `../`
  and absolute paths but not a repository symlink pointing outside itself.
  Containment is now resolved with `realpath`, and escaping symlinks are no
  longer mirrored into the shadow tree.
- **A rejected change leaked a full copy of your source.** The shadow tree is
  populated before the containment check, and nothing cleaned it up on the throw
  path, so a complete copy of the repository survived in the temp directory.

Working-tree immunity and shadow-tree containment now have tests. They did not
before, which is how this survived four minor releases.

### Fixed — four more false `SAFE` verdicts in the 0.4.1 narrowing check

Found by an adversarial review of the 0.4.1 release itself. All four are commands
the classifier parsed and confidently mislabelled, so the documented hedge did not
cover them. None is a regression — 0.4.0 also returns `SAFE` — but 0.4.1 wrote an
affirmative `testScope` into the report while doing it.

| Command | Was | Now |
| --- | --- | --- |
| `pytest -q --durations-min=0.5 tests/test_a.py` | `SAFE` | `UNPROVEN` |
| `python3 -m unittest discover -s tests/unit` | `SAFE` | `UNPROVEN` |
| `pytest --cov --collect-only` | `full` | `narrowed` |
| `python3 runtests.py` | `full` | `unknown` |

The first is the serious one: the scanner stopped at the first flag it did not
recognise and discarded any filter after it, so a single stock pytest flag
disabled the whole check.

Also fixed: ambient `PYTEST_ADDOPTS` was scanned with the pytest flag table for
every project, including vitest and jest ones, because the runner gate added in
0.4.1 was never wired to the code path that uses it.

### Changed

The docs no longer state the narrowing check as an absolute. It is a strong check
on the runners and flags Refactron knows; a command using an unrecognised plugin
flag reports `unknown`, and `unknown` does not cap the verdict. Run the bare
command if you need certainty.

---

## [0.4.1] — 2026-08-19

**Read this one.** Nothing about the report's shape changed, so a version number
alone will not tell you what did: **five false `SAFE` verdicts are fixed, and
what earns a `SAFE` is now narrower.** Every verdict that moves, moves from
`SAFE` toward `UNPROVEN`. Nothing that was `UNSAFE` or `UNPROVEN` can become
`SAFE`, and exit codes are unchanged (`SAFE` and `UNPROVEN` both exit `0`).

Because this is a patch, `^0.4.0` picks it up automatically. That is deliberate:
these are correctness fixes and they should reach you without a manual bump.

### Fixed — five ways a change could earn a `SAFE` it had not earned

Each was reproduced before being fixed. In every case a **passing** suite and
**measured** coverage still produced a `SAFE` that the full suite contradicts.

| The command | Was | Now |
| --- | --- | --- |
| `pytest -q tests/test_scale.py` | `SAFE` on a change that breaks a test | `UNPROVEN` |
| `pytest -q --collect-only` | `SAFE` while running **zero** tests | `UNPROVEN` |
| `PYTEST_ADDOPTS="-k x" pytest -q` | `SAFE` while running one test | `UNPROVEN` |
| `python3 -m unittest tests.test_scale` | `SAFE` on a change the suite catches | `UNPROVEN` |
| 40 statements changed, 1 executed | `SAFE`, "the changed code is covered" | `UNPROVEN` |

If you acted on a `SAFE` from 0.4.0 or earlier for a change verified with a
narrowed test command, or one where `coverage.changedStatements` showed
`covered < total`, that verdict claimed more than it had proven. Re-verify.

### Changed

**What `SAFE` means is narrower.** Two independent rules tightened it. Both move
verdicts in the same direction: `SAFE` becomes `UNPROVEN`. Nothing that was
`UNSAFE` or `UNPROVEN` can become `SAFE`, and exit codes are unchanged.

#### 1. `SAFE` now requires every coverable changed statement to have run

The old rule cleared a whole file as soon as **one** of its changed statements
executed. A diff changing 40 statements in one file, of which 1 ran, returned
`SAFE` with the reason "Tests pass and the changed code is covered."

`SAFE` now requires that every changed statement a test _could_ reach did run.
Partial coverage reports `UNPROVEN` and names the ratio:

```
[UNPROVEN] Tests pass, but only 3 of 14 changed statements were exercised.
```

Statements coverage.py excluded (`# pragma: no cover`, `if TYPE_CHECKING:`) are
subtracted from the count rather than held against you, since no test can reach
them. A change consisting _entirely_ of excluded statements does not reach
`SAFE`: there is nothing a test could have proven about it.

If you are comparing against stored reports, a `SAFE` whose
`coverage.changedStatements` shows `covered < total` was earned under the old
rule. See ADR-11.

#### 2. A narrowed test command can no longer earn `SAFE`

Passing a `testCmd` such as `pytest tests/unit/test_foo.py`, or one using `-k`,
`-m`, `-t` or `--onlyChanged`, scopes the entire verification run. Coverage
could report the changed code as fully exercised while the one test that would
have caught the change was never selected. Reproduced: one repo, one diff, two
test files, only the command differing:

```bash
python3 -m pytest -q                       # UNSAFE — the change breaks a test
python3 -m pytest -q tests/test_scale.py   # was SAFE, now UNPROVEN
```

Refactron now classifies the command as `full`, `narrowed` or `unknown` and
reports it on the new `testScope` field. `narrowed` floors the verdict at
`UNPROVEN`. `unknown` (an unparsed wrapper such as `make test`) does not floor,
and that gap is documented rather than hidden. A `PYTHONPATH=` prefix is not
narrowing, so the remedy for shadow bypass is unaffected.

Exit codes are unchanged: `SAFE` and `UNPROVEN` both exit `0`. Pipelines that
parse the verdict string will see more `UNPROVEN`.

### Added

- `testScope` on `VerdictReport`, carried by `verify-diff --json` and the MCP
  `verify_change` tool. Says whether the command was `full`, `narrowed` or
  `unknown`, so a stored verdict can be audited for scoping after the fact.
  Additive; `reportVersion` stays `1`.
- `engineVersion` on `VerdictReport`: the version that produced the report.
  `reportVersion` tells you which **shape** you hold; `engineVersion` tells you
  which **rules** produced the verdict. You want both if you keep reports as
  history, because this release changed the rules without changing the shape.
- `unittest` is now a recognised runner, alongside `pytest`, `vitest` and `jest`.
- A CLI note naming the filter that cost a run its `SAFE`, and a different note
  when the command could not be parsed at all — silence there would let a `SAFE`
  resting on an unreadable command look clean.
- The MCP `testCmd` schema now states the narrowing rule, so an agent learns it
  before spending a verification run rather than after.


### Security

- Cleared two high and one moderate advisory (`nanoid`, `ip-address`, `hono`),
  lockfile-only. No declared dependency range widened. `npm audit` is a release
  gate and was failing before this.

### Known limitations, stated rather than implied

- **Coverage is Python-only.** A TypeScript or mixed diff still returns
  `UNPROVEN`; it cannot reach `SAFE`, which is the fail-safe direction.
- **`SAFE` means executed, not asserted.** Coverage proves a changed statement
  ran, not that any test would fail if its behaviour changed. Tracked in #116.
- **A command we cannot parse is not floored.** `make test`, a wrapper script,
  or an unrecognised plugin flag classifies `unknown` and can still reach `SAFE`.
  Flooring it would make `SAFE` unreachable for most projects; the CLI says so
  out loud instead.
- **Config-file narrowing is not seen.** `pytest.ini` `addopts`/`testpaths`, a
  vitest `include`, a jest `testMatch`. The command and the environment are read;
  your config files are not. Tracked in #118.
- **Statement-level, not branch-level.** A changed `if` whose true branch never
  ran still counts as covered. Tracked in #117.


---

## [0.4.0] — 2026-08-06

**Breaking, despite being a minor.** Refactron is now only a verification layer.
The refactoring product it grew out of has been removed from this package.

Under semver, a `0.x` release may carry breaking changes in a minor, and this one
does. Read the Removed section before upgrading: there is no major-version bump
to warn you, so `^0.3.0` will not pull this in but `refactron@latest` will.

The 0.3.0 entry below says "Nothing was renamed, removed, or redefined." That
was true of 0.3.0 and is explicitly untrue of this release.

### Removed

Six commands, the transforms behind them, and the interactive UI:

| Removed                            | Was                                             |
| ---------------------------------- | ----------------------------------------------- |
| `refactron analyze`                | scan for transform patterns, blast radius, tier |
| `refactron run`                    | plan, verify and apply transforms               |
| `refactron document`               | generate docstrings and changelog prose         |
| `refactron rollback`               | undo the last applied refactor                  |
| `refactron preflight`              | SQLAlchemy 1.x → 2.0 safety report              |
| `refactron init`                   | scaffold `.refactronrc.json`                    |
| bare `refactron` (interactive TUI) | the Ink REPL                                    |

Also removed: the 20 AST transforms and their LibCST sidecars, the autofix
fixers, blast-radius scoring, the tier taxonomy, the `.refactron/` session
store, the legacy verification engine, the language-adapter layer, and the
`src/core/models.ts` and `src/adapters/interface.ts` locked contracts.

**If you use any of it, pin `refactron@0.3.1`.** The code is archived with its
full history and is not currently published under any name.

Why: they were the demo of the verification engine, not the product. They were
also most of the package. What remains is about a sixth of the source and all of
what people install it for.

### Changed

- **Bare `refactron` prints help and exits 2** instead of opening the TUI.
- **An unknown command exits 2** and says so, rather than failing to resolve a
  module.
- **`refactron login` is a real command.** Previously only `login --print-token`
  was dispatched, and it discarded the status callback, so the device code and
  verification URL were never displayed. Status now goes to stderr, which keeps
  `--print-token` pipeable.
- **`--help` describes this product.** It advertised six departed commands and
  called Refactron "safety-first refactoring", the pre-pivot positioning.

### Added

- **A library entry point.** `main` and `types` have pointed at `dist/index.js`
  since before 0.2.0, but no such file existed, so `import { verifyDiff } from
'refactron'` never resolved. `src/index.ts` now exports `verifyDiff`,
  `RefactronVerifier`, `checkPythonSyntax`, `checkTypescriptSyntax`,
  `reportCoverage`, the `VerdictReport` type and the `contracts.ts` surface.
- **`tests/unit/cli/help-drift.test.ts`**, which asserts every verb the help
  advertises is actually dispatched, against the built binary.

### Fixed

- **`build:copy-py` could fail silently.** Its trailing `|| true` bound to the
  whole `&&` chain, so a failure to copy the _verification_ sidecars exited 0:
  green build, green CI, then every Python verdict failing at runtime against a
  missing sidecar. The build now asserts all three sidecars reach `dist/`.

### Internal

- 18 unused runtime dependencies dropped, including `ink`, `react`, `ts-morph`
  and the three `tree-sitter` packages. Five remain.
- The pre-merge gate no longer runs `analyze src/` against this repo. It gates
  the shipped artifact instead. It deliberately does **not** run `verify-diff`
  against this repo either: coverage attestation is Python-only, so a TypeScript
  repo verifying itself caps at `UNPROVEN` permanently.

`TransformId` still lists the 20 transform literals. Narrowing a locked contract
in the same release that restructures the repo would make any regression
un-bisectable; it waits for a later major.

---

## [0.3.1] — 2026-08-06

Two false `SAFE` verdicts, found and fixed. Both had the same shape: coverage
measured a **different program** than the tests gate ran, then reported the
changed lines as covered. A false `SAFE` is the one defect this product cannot
have, so upgrade rather than pin.

Everything here is a fix. No command, flag, contract or report field changed.

### Fixed

- **A leading `NAME=VALUE` on `testCmd` silently disabled coverage.** The tests
  gate runs the override through `sh -c`, which honours the assignment; the
  coverage runner tokenised the command itself and treated `PYTHONPATH=.` as a
  module name. `coverage run -m PYTHONPATH=. python3 -m pytest` imports nothing,
  writes no data file, and the verdict degraded to `UNPROVEN`. That is the safe
  direction, but it capped every project using the documented shadow-bypass
  remedy at `UNPROVEN`, which no amount of test-writing could lift. Leading
  assignments are now hoisted into the child environment. (#95, PR #97)

- **A console entry point ran under the wrong interpreter.** `coverage run
  <script>` executes the file as source in the *current* interpreter and never
  honours its shebang; the shell that runs the gate does. A venv's `pytest` was
  therefore measured under whatever `python3` we happened to spawn, with a
  different set of installed packages. The resolver now models what the shell
  actually does: it stops at the shell's first PATH match, requires the exec
  bit, declines on Windows, and accepts only two shebang shapes. (#98, #99,
  PR #102, PR #103)


- **Shebang arguments were dropped, which was itself a false `SAFE`.**
  `#!/usr/bin/python3 -s` is the Fedora and RHEL packaging default, and `-E`
  makes Python ignore `PYTHONPATH`. The gate execs the script so the kernel
  applies the flag and imports the _installed_ copy; coverage dropped the flag,
  honoured `PYTHONPATH`, imported the _shadow_ copy and measured it as covered.
  The changed file lands in `measuredFiles`, so the shadow-bypass guard stays
  silent and the fusion reads `SAFE` for a change no test executed. Any shebang
  carrying arguments now declines. (PR #103)

- **The shadow-bypass floor blamed the wrong thing.** When measurement failed it
  told users to prefix their test command with `PYTHONPATH=.`, which could not
  have helped and was not the cause. The reason now names the real remedy.
  (PR #103)

- **Coverage declines now say what to do instead.** A console entry point that
  is not a Python script (a native launcher on Windows, a pyenv/asdf/nix shim)
  can never be handed to `coverage run`, so the decline is permanent rather than
  transient. The message names module form, `python -m`, as the fix. (#100)

- **Eight tests reported PASSED without running.** Guards inside test bodies
  returned early when coverage.py or pytest was missing, which vitest counts as
  a pass. Converted to `it.skipIf`. Measured against a coverage-less `python3`
  shim: `19 passed | 3 skipped` before, `12 passed | 10 skipped` after. (#101)

### Changed

- **A `testCmd` naming a console entry point that cannot be resolved now reports
  `UNPROVEN` rather than `SAFE`.** This is a verdict change in the safe
  direction and the reason it is not a major: the previous `SAFE` was, in the
  cases this covers, not something the measurement had established.

- **The default `testCmd` moved from `pytest -q` to `python3 -m pytest -q`.**
  Module form is the only form coverage can reliably wrap.

- **The CLI mascot and palette.** The mascot is now Tabslot, and the chrome is
  monochrome cream so the only colours on screen are verdicts, severities and
  diffs. Cosmetic; no output contract changed.

### Docs

- **An MCP tab, with per-client setup for nine clients.** Claude Code, Claude
  Desktop, Codex, Cursor, Gemini CLI, VS Code, Windsurf and the generic case each
  get their own page with a copy-only prompt block you hand straight to the
  agent. (PR #94)

- **One canonical answer for the `PYTHONPATH` question.** `verdicts.mdx` said to
  export it, `verify-diff.mdx` gave no form at all, and nine agent prompts said
  to prefix the test command without saying what the command should look like.
  All of them now name module form, which is not a style preference: coverage
  has to run the same program the gate ran, and a bare console script is only
  runnable under coverage when it resolves to a Python file. (#96)

---

## [0.3.0] — 2026-08-02

The verification layer ships. Refactron can now verify **any** diff, whether an AI agent wrote it, a codemod produced it, or you typed it yourself, and return a three-way verdict: `SAFE`, `UNSAFE`, or `UNPROVEN`. It applies the change in an isolated shadow tree, runs your real test suite, and checks whether those tests actually exercise the lines that changed. Your working tree is never touched. The same gate is exposed to AI agents over MCP.

This is a minor, not a major. Nothing was renamed, removed, or redefined: no `TransformId` changed, no CLI flag was dropped, no `.refactron/` field disappeared, and no locked contract shape moved. The transform CLI (`analyze`, `run`, `document`) behaves exactly as it did in 0.2.4. Everything below is additive.

Two new binaries ship in this package: `refactron` (unchanged name, new commands) and `refactron-mcp`.

### Added

- **`verify-diff` command.** `refactron verify-diff [repoRoot] --diff <file>` verifies an arbitrary unified diff end to end and prints `[SAFE|UNSAFE|UNPROVEN] <reason>`. The diff is applied in an isolated shadow tree, the syntax / imports / tests gates run against it, and changed-line coverage is fused into the verdict. Read-only: your working tree is never mutated. `--json` emits the full report, `--test-cmd` overrides the detected runner. Exit codes: `1` on `UNSAFE`, `2` on unusable input, `7` unauthenticated, `0` on `SAFE` and on `UNPROVEN`. (PR #75)
- **`refactron-mcp`, an MCP server exposing `verify_change`.** A stdio server your AI agent calls before it lands a change. It accepts either full-file `edits` (`{path, newContent}[]`) or a `unifiedDiff`, plus an optional `testCmd`, and returns the same JSON verdict report the CLI produces. Installing the package puts `refactron-mcp` on your PATH. (PR #75)
- **Three-way verdict fusion.** `SAFE` means every gate passed **and** your tests exercise the changed code. `UNSAFE` means a gate failed. `UNPROVEN` means the suite is green but the change is not proven, or coverage could not be measured. `UNPROVEN` exits `0`: it is a warning, not a rejection. Coverage attestation is Python-only, via `coverage.py`; a TypeScript, mixed-language, or otherwise non-Python diff caps at `UNPROVEN` and never returns a false `SAFE`. (PR #75)
- **`preflight` command.** A coverage-aware SQLAlchemy 1.x to 2.0 migration safety report. Every `Model.query` site is classified safe-to-automate, unproven, or needs-review, with the reason named, so you know which parts of the migration a codemod can own and which need a human. `--fail-on-unproven` exits `1` so CI can gate on it. Both the attribute form and the class-attribute form of `Model.query` are detected. (PR #74)
- **Python line-coverage reporting via `coverage.py`.** `analyze` tags findings with whether a test actually exercises them. This is the measurement the coverage-aware classification and the `SAFE` verdict both rest on. (PR #74)
- **`reportVersion` on the verdict report.** The `--json` and MCP report shape is a public contract, and consumers store these reports as fleet history. `reportVersion: 1` tells them which shape they are holding. (PR #86)
- **`coverage.changedStatements`** (`{total, covered}`) and **`coverage.filesWithUncovered`** in the report, so the ratio behind a verdict is legible instead of implied. The `uncovered` list is now always present, including on `SAFE`. (PR #86)
- **`testFilesChanged` in the report.** The changed files that match test conventions, surfaced as a CLI note and in JSON. An agent that weakens its own tests can no longer ride a green verdict unnoticed. This is a disclosure, not a verdict input. (PR #79)
- **`flakyTests` in the report.** Tests that failed once and passed on a retry, so a verdict floored by flakiness names the tests that caused it. (PR #83)

### Changed

- **`refactron --help` gained `verify-diff` and `preflight`.** No existing command, flag, or exit code changed.
- **Package description and keywords** now describe the verification layer rather than the transform CLI. Metadata only.
- **`NOTICE` now ships in the npm tarball.** The project relicensed to Apache-2.0 in 0.2.4 and added a `NOTICE` file, but the published package never included it. Apache-2.0 section 4(d) expects it to travel with the distribution. It ships in the PyPI wrapper too.

### Fixed

Every item below is a false-verdict class that the shipped verification layer does **not** have. `verify-diff` was never on npm before today, so none of these ever reached a released build; they are listed because what a verification tool refuses to claim is the product.

- **A diff that deleted a file could verify `SAFE`.** Diff operations that could not be modeled were silently skipped, so a diff removing a module plus one benign edit passed the gates while applying it broke every import in the package. Deletions, renames, copies, and binary changes are now refused loudly (exit `2`), detected via both the patch parser and a raw scan of the diff text so pure renames the parser drops are still caught. (PR #79)
- **A diff could lie about creating a file and splice content into a live one.** A hunk with no context and no deletions has no anchor, so it applies at the header line even on a drifted base. That guard trusted the diff's own `--- /dev/null` claim; it now derives new-file status from what is actually on disk. Submodule pointer bumps and non-UTF-8 bases are likewise refused rather than partially verified. (PR #82)
- **A changed blank line could vouch for a function that never ran.** Coverage was attributed by walking back to the nearest preceding statement start, which cannot distinguish a continuation line from a blank, comment, or dead-branch line. An executed `def` header therefore covered a body that was never called: a real logic change inside an uncalled function plus one changed blank line elsewhere read `SAFE`. Attribution is now exact line-to-statement containment from the Python AST, innermost statement wins, and a line carrying no code token is inert (it can neither change behavior nor be proven, so it never marks a file exercised). (PR #86)
- **CRLF diffs could produce a false `SAFE`.** Changed-line derivation now normalizes CRLF before diffing, so a change differing only in line endings no longer mismatches coverage and slips through as covered. (PR #75)
- **A flaky suite became a false `UNSAFE` rate.** The tests gate blamed the diff for any failure after the change. It now computes new failures against the green-by-construction baseline set, and when new failures appear it reruns once on a **fresh** shadow tree. A timing flake heals on a pristine tree; a regression that only heals through first-run state mutation (an idempotency break) fails again and stays a gate failure. Unparseable test output yields an empty failure set and falls back to any-failure-fails, never anything more lenient. (PR #83)
- **A healed flake could still reach `SAFE`.** A gate that passes only because a failure vanished on retry never observed a clean stable green, so flakiness now floors the verdict at `UNPROVEN`. (PR #83)
- **The imports gate produced systematic false `UNSAFE` verdicts on modern Python.** Confirmed against `pallets/click`. Imports inside `if TYPE_CHECKING:` were flagged even though they never run at runtime; platform-conditional imports failed on the wrong OS; and the gate blamed the change for the repo's pre-existing unresolvable imports. It now skips `TYPE_CHECKING`-guarded imports, resolves imports in both the base and the changed file, and fails only on imports the change introduced or newly broke. The TypeScript imports check got the same delta treatment. Reasons name the module and the project-relative path, never the absolute shadow path. (PR #78)
- **Script-form test commands reported fake zero coverage.** Runners invoked as scripts (`tests/runtests.py`, `manage.py test`, custom harnesses) were mangled into a request to execute a module named `python3`, which failed silently and became "not exercised by any test" for code that provably is exercised. Found against `django/django`. Coverage now classifies the command as module form, script form, or unwrappable composite and builds the right invocation. Quoted arguments survive tokenizing, so `-k "not slow"` stays one argument and the measured test set matches the one the gate ran. (PR #84)
- **A failed measurement read as "nothing is covered".** An impossible or failing coverage run, a failing `coverage json` step, or an unreadable report all returned an empty covered set, which is indistinguishable from genuinely uncovered code. They now report a measurement failure, and the verdict says coverage could not be determined. (PR #84)
- **A directory named `coverage/` defeated the coverage probe.** A JS coverage output directory on `sys.path` imports as a namespace package, so the import-based probe reported the tool present while `coverage run` then failed silently. The probe now uses module execution, which a data directory cannot satisfy. (PR #80)
- **A pip-installed project could read as "not exercised".** When tests import the installed copy rather than the tree under verification, changed files never appear in coverage's measured set. That now reads as unknown coverage, not as uncovered code. (PR #84)
- **Removal-only diffs reported a misleading coverage miss.** A diff that only deletes lines produced a bare "not exercised by any test" with an empty uncovered list. Such files now surface as `removalOnlyFiles` and the reason says what actually happened: there are no added lines for coverage to attest. The verdict stays a conservative `UNPROVEN`, because removing uncovered behavior would go unnoticed by a green suite. (PR #81)
- **Dynamically compiled code broke coverage reporting entirely.** Suites that `exec(compile(...))` give coverage a phantom filename, `coverage json` exits non-zero, and every project doing so falsely read `UNPROVEN`. Phantom entries are now dropped and real files keep their data. Found against `Textualize/rich`. (PR #78)
- **Spec-style repos silently skipped the flaky delta.** The vitest failure-line matcher only recognized `.test.[tj]sx`, so a `.spec.mts` or `.test.cjs` project yielded an empty failure set. Broadened to the same conventions the verdict uses. (PR #83)
- **Windows: the Python sidecar's CRLF output corrupted parsed module names.** Sidecar output is now split on `\r?\n`. (PR #78)
- **Coverage was unavailable in CI.** `coverage.py` is installed into the same `python3` the test suite spawns, so the coverage-based verdict is exercised in the runner instead of degrading to `UNPROVEN`. (PR #74)

### Security

- **Dependency advisories cleared.** `npm audit` reports 0 vulnerabilities, down from 6 (4 high). Resolved entirely in the lockfile with no change to any declared range in `package.json`: `brace-expansion` (three transitive copies, ReDoS) and `fast-uri` (ReDoS in the Ajv URI validator) moved to patched versions. The runtime dependencies `@modelcontextprotocol/sdk` (1.29.0 to 1.30.0) and `js-yaml` (4.1.1 to 4.3.1) moved with them, both inside their declared ranges.
- **Hostile diffs are refused, not partially verified.** The input rejections listed under Fixed are a security posture, not only a correctness one: `verify-diff` accepts untrusted input by design, since the whole point is verifying a diff you do not trust. A diff that misrepresents its own operations now fails loudly instead of earning a verdict for the half that parsed.
- **The PyPI wrapper no longer performs an unpinned global install.** `pip install refactron` previously ran `npm install -g refactron` on first use, which wrote outside the Python environment and fetched whatever version was `latest` regardless of the version you pinned. It now detects the CLI and, if missing, prints the exact matching command and exits non-zero. See the wrapper notes below.

### PyPI wrapper (`pip install refactron`)

The Python wrapper is published alongside the npm package and is versioned in lockstep with it. It remains a thin shim: **Node.js 18+ is still required**.

- **Relicensed to Apache-2.0**, matching the rest of the project since 0.2.4. The wrapper's metadata and bundled `LICENSE` still said MIT. `NOTICE` now ships with the distribution as well.
- **Version drift fixed.** `pyproject.toml` said 0.2.4 while `refactron.__version__` said 0.2.0. There is now one literal, in `refactron/__init__.py`, which `pyproject.toml` reads statically; the packaged metadata and the runtime value cannot disagree again.
- **No more surprise global install** (see Security above). A missing CLI prints `npm install -g refactron@0.3.0` or `npx refactron@0.3.0` and exits `1`.
- **Version-skew warning.** If the Node CLI on your PATH is a different version from the wrapper, a one-line warning goes to stderr naming both. Silence it with `REFACTRON_SKIP_VERSION_CHECK=1`.
- **Fixed an infinite exec loop.** The wrapper resolved the `refactron` name on `PATH` and executed it. Inside a virtualenv, that name resolves to the wrapper's own console script, so with the npm CLI absent the process re-executed itself forever. CLI resolution now skips the wrapper's own entry points and any Python console script, with an environment sentinel as a backstop.

---

## [0.2.4] — 2026-06-17

Reliability and observability release. Five real fixes, one feature (tier taxonomy), one license change. No new transforms, no API breakage — every existing call site keeps working.

### Added

- **Tier taxonomy on every transform** (debt / modernization / style). `analyze` output now groups findings and remediation minutes by tier, so the headline "N findings" splits into "57 debt (315 min), 102 modernization (490 min), 2,569 style (4,483 min)" instead of one undifferentiated count.
- **`byTier` and `minutesByTier` fields** in `analyze --json` output. Invariant: `debt + modernization + style === totalMinutes`.
- **BY TIER section** in the boxed TUI analyze output, sitting above BY TRANSFORM.

### Changed

- **License: MIT → Apache 2.0.** Every right MIT granted is still granted; Apache 2.0 adds an explicit patent grant from contributors. Closes a question enterprise legal teams routinely raise before adopting source-code tooling. See `LICENSE`, `NOTICE`, and `docs/faq.mdx#why-apache-20`.

### Fixed

- **`run --transforms=all` silently dropped 8 transforms.** The CLI's local `TRANSFORM_IDS` list had drifted out of sync with the engine's `TRANSFORM_ORDER` when the v0.2.3 catalog expansion landed — `--transforms=all` was passing only 12 of 20 ids to the engine. The CLI now imports `TRANSFORM_ORDER` directly so there's exactly one list. Drift is also pinned by a new test that cross-checks the alphabetised set. (closes #48; PR #49)
- **`--files=<glob>` was ignored on `--apply`.** The glob filter only narrowed the dry-run preview; the apply path silently rewrote every matching finding regardless of scope. The filter is now applied to `plan.changes` before the dry-run / apply split, so both paths honour it. (closes #50; PR #52)
- **Documenter broke files with multi-line return-type signatures.** On signatures like `def get_dataclass(...) -> type[\n  Union[\n    A,\n    B,\n  ]\n]:` the docstring inserter latched onto the first inner line of the type subscript as if it were the function body, producing syntactically invalid Python. The inserter now walks bracket-balanced signatures and recognises single-line `def f() -> T: ...` Protocol stubs as having no separate body to insert above. (closes #51; PR #52)
- **`apply` and `rollback` dropped POSIX file modes.** Atomic-writer and rollback both reset mode bits to umask defaults instead of preserving the original. Both paths now round-trip modes. Mode-preservation tests skip on Windows (NTFS does not honour POSIX modes). (8e2020e)
- **`class_to_dataclass` injected imports before `from __future__`.** Generated `from dataclasses import dataclass` landed at line 0 even when the module led with `from __future__ import annotations`, breaking PEP 236 ordering. Imports now insert after the `__future__` block. (bc31d0c)
- **Silent refusals in four transform sidecars.** `pep585_generics`, `pep604_optional_union`, `datetime_utc_alias`, and `callback_to_async_await` previously refused some candidates without emitting any `precondition` record — users saw "detected, but nothing changed" with no explanation. Each refusal path now records `{id, satisfied: false, reason}`. (186d714)
- **`manual_typecheck_to_hints` was the silently-silent sidecar.** The Bug #3 fix above missed this transform. The Ansible trial showed 16 of 20 files with findings produced zero precondition records. Every refusal path now emits one; gate on "function contains an `isinstance(Name, Name)` call" prevents noise from unrelated siblings; nested-def scan stops at function boundaries to avoid false-positive outer-function records. Net effect on Ansible: 16 silent files → 0; 4 records → 87, covering all 20 files. (closes #57; PR #58)

### Internal

- Operations scaffolding under `.claude/` — 10 senior subagent personas, 3 project slash commands (`/review`, `/check-locked`, `/new-transform`), three hooks (commit-message validation, locked-file write block, post-write auto-format), CODEOWNERS, ARCHITECTURE.md, GLOSSARY.md, RUNBOOK.md, CODE_STYLE.md, COMMIT_CONVENTIONS.md, PRD/Plan/ADR templates. Developer-facing only — does not change library behaviour.
- New `docs/reference/performance.mdx` and `docs/reference/citations.mdx` pages, wired into Mintlify nav.
- README rewritten in a tighter prose-led style with a 1500×880 animated SVG banner; the demo gif still ships under `docs/assets/`.

### Known follow-ups (not blocking this release)

- `manual_typecheck_to_hints` now records why it refuses, but on Ansible it still rewrites 0 of 20 files — the dominant refusal is "function body has more than one statement" (e.g. docstring + dispatcher, or dispatcher + raise fallthrough). Expanding the rewriter to handle those shapes is tracked as #59 for a future release.
- Eight new transform candidates derived from a deeper Ansible scan (PEP 526 type-comment → annotation, TOCTOU-safe `makedirs`, redundant `(object)` base, subprocess legacy → `run`, `imp` → `importlib`, and three more) are filed as #62–#69 for v0.3 / v0.4 prioritisation.

---

## [0.2.3] — 2026-05-27

Ten new deterministic transforms — six for Python, four for TypeScript — roughly doubling Refactron's transform coverage. Adds the `pythonVersion` config key for safe version-gated rewrites.

### Added

- **Python — `super_no_args`** — drop redundant explicit class/self args from `super()` calls.
- **Python — `lru_cache_to_cache`** — `@functools.lru_cache(maxsize=None)` → `@functools.cache` (≥ 3.9).
- **Python — `pep585_generics`** — `typing.List` / `Dict` / `Tuple` → built-in `list` / `dict` / `tuple` (≥ 3.9, or `from __future__ import annotations`); drops now-unused `typing` imports; refuses when runtime type evaluation is in use.
- **Python — `pep604_optional_union`** — `Optional[X]` → `X | None`, `Union[A, B]` → `A | B` (≥ 3.10, or `from __future__ import annotations`); same runtime-type-eval safety as `pep585_generics`.
- **Python — `datetime_utc_alias`** — `datetime.timezone.utc` → `datetime.UTC` (≥ 3.11; no `__future__` override since this is a runtime attribute).
- **Python — `yield_from_for_loop`** — `for x in y: yield x` → `yield from y` when the loop has no other body. Refuses inside `async def` (a CPython compile-stage SyntaxError that LibCST's parser does not catch).
- **TypeScript — `indexof_to_includes`** — `arr.indexOf(x) !== -1` / `>= 0` / `> -1` → `arr.includes(x)`; `=== -1` / `< 0` → `!arr.includes(x)`. Type-aware via ts-morph (String / Array / ReadonlyArray receivers only). Gated on tsconfig target ≥ ES2016.
- **TypeScript — `object_assign_to_spread`** — `Object.assign({}, a, b)` → `{ ...a, ...b }`. Preserves first-arg literal properties; inlines object-literal sources; refuses on spread-element arguments. Gated on tsconfig target ≥ ES2018.
- **TypeScript — `string_concat_to_template_literal`** — `"Hello " + name + "!"` → `` `Hello ${name}!` ``. ts-morph type-checks every operand; refuses on `any` / `unknown` / non-`string|number|boolean`. Gated on tsconfig target ≥ ES2015.
- **TypeScript — `vue_set_delete_to_assignment`** — `Vue.set` / `this.$set` → direct assignment; `Vue.delete` / `this.$delete` → `delete obj.k`. `.js` / `.ts` only (Vue SFC parser deferred to v0.4). Refuses `delete` in expression context (return-value semantics differ). Caveat shipped in suggestion text: in Vue 2 codebases this is a semantic change because direct assignment isn't reactive for new keys.
- **Configuration — `pythonVersion`** — pin the Python target for version-gated transforms; auto-detected from `pyproject.toml`'s `requires-python` when not set.

### Changed

- **Engine composition (PR #38)** — multi-transform composition is now order-stable: when several transforms touch the same file, each emits its own `FileChange` carrying the cumulative content (last per path is the one written to disk). Fixes a silent-data-loss bug where only the LAST transform's rewrite survived under `run --apply`.

### Internal

- Shared sidecar helpers: `src/transform/transforms/python/_py/_python_version.py` (version gating), `_typing_cleanup.py` (PEP 585/604 shared logic).
- Shared TS helper: `src/transform/transforms/typescript/_tsconfig.ts` (tsconfig target resolution with `extends` chain support, including TS 5.0+ array-extends and JSONC stripping).

## [0.2.2] — 2026-05-18

Quality-of-life release for the analyze → run → document pipeline: boxed
CLI output, a real `rollback` command, and a much more efficient
`document`. All changes landed via PR #31.

### Added

- **Bordered table output** — `analyze` renders one box per file plus boxed TRANSFORMS / BY TRANSFORM / SUMMARY blocks; `run --dry-run` is restructured to match, with a CHANGES table and a four-sided diff box per file
- **`rollback` command** — undo an applied refactor or `document` run; operation journal with LIFO undo, drift-safe, `--all` / `--force` / `--dry-run`
- **`run --apply` live progress** — gate-by-gate status and per-file verify/apply detail; batch-first verification with a per-file fallback when the batch fails
- **`run --apply` short-circuit** — exits early with a clear message when no test runner is detected, instead of silently skipping the test gate
- **Full report saved to disk** — `analyze` and `run --dry-run` write the complete report to `.refactron/reports/` so long output survives terminal scrollback
- **`document` enrichments** — inline comments, a per-run modernization report under `docs/refactron/`, and a post-apply syntax re-check

### Changed

- **`document` is far more efficient** — docstring requests are batched with bounded concurrency and token-aware rate limiting; the LLM call count is now O(source tokens / batch budget) instead of O(symbols)

### Fixed

- **`document` produced zero docstrings on large files** — batches were sized by input tokens only, so dozens of symbols packed into one request whose combined response overran the completion cap and truncated mid-object. Batches are now also capped by response size, and `parseBatchDocstrings` salvages every complete entry from a truncated reply
- **`document` six-quote docstring bug** — `""""""…""""""` produced by a contradictory prompt plus unconditional quote wrapping
- **`document` rate-limited runs ground on for minutes** — each LLM call is paced once, not re-paced on every retry
- **`document` report / CHANGELOG paths** — normalized to forward slashes (were OS-native `\` on Windows, breaking the markdown and the Windows CI leg)
- **`analyze` old-string-format line numbers** — multi-line `%` / `.format()` findings now anchor on the operator, not the opening string quote that can sit many lines above
- **`analyze` over-reported `manual_typecheck_to_hints`** — no longer flags an isinstance chain on an already-annotated parameter, which the transform always skips
- **`deprecated_api_requests_to_httpx` emitted runtime-broken code** — a blind `requests.X → httpx.X` rename produced non-existent names (`httpx.ConnectionError`) and wrong types (`httpx.Timeout` is a config class). The transform now refuses files that use `requests` API which is not a safe httpx drop-in
- **`analyze` "Fixable N/N"** — replaced with an honest auto-fix-candidate count that defers the real number to `run --dry-run`
- **vitest per-test timeout** — corrected the config key (`timeout` → `testTimeout`); Python LibCST tests no longer flake against the 5 s default

## [0.2.1] — 2026-05-16

Patch release. Fixes a crash on large source files and lands two
transform-coverage improvements surfaced by the comparison benchmark.

### Fixed

- **`analyze` crashed on files larger than ~32 KB** — tree-sitter's native binding rejects a string input past ~32 KB with `Error: Invalid argument`, aborting the whole run. Parsing now uses tree-sitter's callback-input form, which streams the source in chunks and has no size cap. A single unparseable file is also skipped instead of aborting the run (PR #29)
- **`var_to_const_let` dropped whole files** — the hoisting and reassignment checks matched identifiers by text across the entire file, so two functions each declaring a same-named `var` tripped a false-positive and the transform skipped the file. Reference resolution is now scope-correct, and for-loop `var i` initializers are covered (PR #27)

### Changed

- **`format_to_fstring` now converts the full printf grammar** — `%d`, `%.2f`, `%x`, `%o`, `%e`, `%g`, width and precision specifiers, and `%%`. Previously only plain `%s` was handled. Mapping `%(name)s`, non-literal targets, and dynamic `*` widths are still conservatively skipped (PR #27)

## [0.2.0] — 2026-05-15

First public release of the v2.0 deterministic-refactoring rebuild.

### Added

- **Engine** — 10 deterministic AST transforms (5 Python via LibCST, 5 TypeScript via ts-morph) with cross-file preconditions
- **3-gate verification** — syntax + imports + tests on a shadow tree, atomic batch write or rollback (PRs #7, #8, #11, #13, #15)
- **Documentation engine** — Step 4 of the pipeline; the only LLM-touching component, runs only on already-verified diffs (PR #15)
- **5 LLM providers** for `document`: Ollama (local default — for the trust-conscious), Groq (BYOK fast), OpenAI, Anthropic, Backend (managed via api.refactron.dev for Pro users) (PR #22)
- **CLI output redesign** — by-file findings with code excerpts (analyze), per-file unified diffs (run --dry-run), gate-by-gate progress + structured failure surface (run --apply) (PR #19)
- **Authentication** — OAuth device flow with `REFACTRON_TOKEN` env var support; long-lived API keys for stay-logged-in semantics (PRs #13, #25)
- **`.refactronrc.json` config** — cosmiconfig + ajv schema validation; `transforms`, `exclude`, `testCmd`, `confidence`, `dryRun`, `documentation` (PRs #13, #20, #22)
- **Performance** — per-file parallelization in plan step, 3× speedup on python-legacy-mini (PR #23)
- **Mintlify documentation site** with full transform catalog, safety model diagram, FAQ, citations
- **Reproducible perf bench** infrastructure at `bench/`

### Changed

- REPL output history rendered via Ink `<Static>` to eliminate whole-screen flicker (PR #24)
- Spinner reduced from 80ms tick + per-char shimmer to 250ms tick + single brand color (~50 → ~4 ANSI escapes/sec) (PR #24)
- `RefactronRc.documentation.provider` defaults to `'backend'` so authenticated Pro users get LLM docs out-of-the-box (PR #22)

### Fixed

- REPL `clear` now wipes the terminal viewport, not just React state (PR #24)
- REPL `document` defaults to the active session's analyze target (was reading stale `last-apply.json` from cwd) (PR #22)
- `RefactronRc.exclude` field is now wired into discovery (was dead code since Week 5) (PR #20)
- Run `--apply <file>` parser stops eating the path argument (PR #17)
- REPL `document` output no longer vanishes into Ink's render buffer (PR #18)
- Verify failure surface no longer drops vitest's FAIL section (was front-slicing 4000 chars) (PR #19)
- Findings rendered in source order within each file, not detector-emission order (PR #20)
- CHANGELOG written next to the changed files' project marker, not to cwd (PR #22)
- Cross-platform: Windows path separators normalized in formatters; Node 18 execa.timedOut wall-clock derivation (PR #19, #20)

### Documentation

- SECURITY.md with disclosure policy + threat model
- 30-second demo GIF in README
- 13 docs site pages (Safety Model, 10 transform pages, CLI Reference, Configuration, FAQ, Why No LLM)
- ADRs 1–10 covering every weekly architecture decision

### Honest limitations

- No Ruby / Go / Rust adapters in 0.2; multi-language is post-launch
- Documentation engine requires a reachable LLM provider (graceful skip otherwise)
- Self-analysis on Refactron's own repo fails the test gate by design (mutating fixtures breaks meta-tests) — see `docs/known-limitations`

---

## [0.1.0-beta.2] — 2026-04-05

### Added

**Interactive Issue Browser**

- `analyze` now opens the interactive issue browser automatically after scanning — no extra command needed
- Full-screen Ink TUI: paginated issue list, detail panel, diff preview, filter mode
- `a` — fix selected issue in place (atomic write + backup, marks ✔, stays in browser)
- `A` — fix all fixable issues in one pass with live `fixing N/M…` progress
- `d` — dry-run diff preview (12 lines, Esc to dismiss)
- `v` — verify a fixed issue's file (only available after fixing, shows ✓ safe / ✘ blocked)
- `/` — real-time filter by message, file, severity, or type
- `j`/`k` and `↑`/`↓` — navigation; `g`/`G` — jump to first/last; `PgUp`/`PgDn` — page
- Status messages auto-dismiss after 3s

**Work Sessions**

- `WorkSessionManager` — persists full `CodeIssue[]` to `.refactron/work-sessions/{id}.json`
- `autofix` and `verify` commands operate on the active session — no re-scan needed
- `session list` — list all saved sessions; `session <id>` — load and activate
- `issues` command — open browser on any active session

**CLI UX**

- Slash command picker: typing `/` in the prompt shows a filterable command menu
- Ctrl+C double-press to exit: first press shows warning, auto-dismisses after 800ms
- `hint: <tip>` line below spinner rotates through random tips every 4s while a command runs
- Session header (`SessionHeader`) stays fixed at top — never scrolls away
- Terminal mouse scroll re-enabled (removed alternate screen buffer, runs on main screen)
- Mouse wheel no longer injects arrow keys into the REPL history

### Changed

- `analyze` returns `openBrowser: true` — browser launches immediately after scan summary
- StatusLine footer bar removed — cleaner UI
- `logout` exits the session on completion
- Git subprocess calls batched via `--stdin` (1 call vs N per-file)
- `isGitRepo()` result cached; temporal profiles built in parallel

### Fixed

- `SessionHeader` was rendering inside `Static` (scrolled away); moved to live Ink tree
- Single-extension glob `**/*.{py}` edge case replaced with `**/*.py`
- Second `analyze` run returning 0 files (`.refactron/` JSON picked up by glob); added ignore
- Unused vars lint errors across REPL, IssueBrowser, LoginFlow, session types

---

## [0.1.0-beta.1] — 2026-04-04

Initial beta release.

### Added

**Core**

- `CodeIssue` model with mandatory `BlastRadius` — every issue carries a non-optional impact score
- `ILanguageAdapter` interface — language-agnostic contract for all language-specific work
- `RefactronConfig` with YAML loader and deep-merge defaults (`refactron.yaml`)

**Blast Radius Engine**

- Transitive import graph traversal (`InMemoryImportGraph`)
- Function-level call graph (`InMemoryCallGraph`)
- `BlastRadiusAnalyzer` — 0–100 weighted score (files 40%, functions 40%, test coverage gap 20%)
- 5 blast levels: `trivial`, `low`, `medium`, `high`, `critical`

**Verification Engine**

- Blast-radius-aware check selection — trivial runs syntax only, critical runs all three checks
- `SyntaxCheck`, `ImportsCheck`, `TestGateCheck` delegates
- 45s timeout for standard checks, 120s for critical blast
- Atomic file writes (temp → rename) with Windows fallback

**Analysis Engine (7 Analyzers)**

- `SecurityAnalyzer` — SQL injection, `eval()`, hardcoded secrets, `exec()`
- `ComplexityAnalyzer` — cyclomatic complexity (default threshold: 10)
- `CodeSmellAnalyzer` — long methods (default: 50 lines)
- `DeadCodeAnalyzer` — unreachable code after control flow statements
- `TypeHintsAnalyzer` — missing Python return types, TypeScript explicit `any`
- `DependenciesAnalyzer` — unused imports
- `PerformanceAnalyzer` — list concat in loops, `await` inside loops

**Language Adapters**

- `PythonAdapter` — syntax via `ast.parse`, imports via `py_compile`, tests via `pytest`
- `TypeScriptAdapter` — syntax via TypeScript compiler API, tests via `vitest`/`jest`
- `AdapterRegistry` — auto-detection by file extension and project structure

**AutoFix Engine (14 Fixers)**

- `UnusedImportsFixer`, `TrailingWhitespaceFixer`, `DeadCodeFixer`
- `SortImportsFixer`, `NormalizeQuotesFixer`, `TypeHintsFixer`
- `DocstringsFixer`, `SimplifyBooleanFixer`, `UnusedVariablesFixer`
- `FixIndentationFixer`, `MissingCommasFixer`, `RemoveDebugFixer`
- `MagicNumbersFixer`, `ConvertFstringFixer` (flag-only in MVP)

**Pipeline**

- `FixQueue` — enqueue, status transitions (PENDING → APPLIED/BLOCKED/SKIPPED)
- `SessionManager` — state machine (ANALYZED → FIXING → FIXED → ROLLED_BACK)
- `SessionStore` — `.refactron/sessions/` JSON persistence
- `BackupManager` — per-session file backups enabling rollback
- `Orchestrator` — full analyze → fix → verify → atomic write pipeline

**Temporal Analysis**

- Git log parsing for change velocity (6-month window)
- Co-change pair detection (files that change together >50% of commits)
- Risk scoring: `DANGER`, `HIGH`, `MEDIUM`, `LOW`

**CLI**

- `refactron analyze` — scan with interactive Ink issue browser
- `refactron autofix` — fix with verification gate
- `refactron verify` — verify a single file
- `refactron status` — show session state
- `refactron rollback` — restore from backup
- `refactron diff` — show unified diff
- `--version` / `--help` fast paths (<10ms, no app load)

**Terminal UI (Ink)**

- `IssueList` — navigable list with blast radius display
- `IssueDetail` — expanded issue view
- `VerificationView` — live check progress
- `DiffView` — syntax-highlighted unified diff
- `BlastRadiusGraph` — ASCII impact visualization
- `StatusBar` — always-visible severity summary
- `ProgressBar` — animated scan progress

**CI/CD**

- GitHub Actions: CI (typecheck, lint, test matrix, build), release, security, nightly
- Dependabot weekly npm updates
- CodeQL analysis
- Nightly regression against 5 real-world repos (Django, Requests, FastAPI, Black, Flask)

### Technical Notes

- TypeScript 5.4, Node.js 18+, ESM (`"type": "module"`)
- `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`
- Ink 5 / React 18 terminal UI
- `"jsx": "react-jsx"` (automatic runtime — no `import React` required)
- 45 tests across 13 test files

---

## Upcoming

- Go language adapter
- JSON and SARIF output formats
- `--output <file>` flag for CI integration
- Semgrep integration for deeper security analysis
- Tree-sitter-based import graph (replaces regex heuristics)
- VS Code extension
