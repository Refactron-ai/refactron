# ADR-17: Isolate the coverage driver from module shadowing

> Status: **Accepted**
> Date: 2026-09-06
> Deciders: @omsherikar
> Closes: GHSA-739m-x9gc-9wjv (private advisory).

## Context

`reportCoverage` invoked the coverage driver as `python3 -m coverage run|json …`
with `cwd = the shadow tree`. For `python -m`, CPython puts cwd first on
`sys.path`, so a **`coverage.py` file committed at the repo root** shadows the
real tool. A hostile PR ships one that fabricates `coverage.json` marking every
changed line executed → the changed-line coverage rule (ADR-11) is satisfied on
fabricated evidence and the verdict is a clean, undisclosed **false SAFE**,
reachable by any PR with no machine access. Reproduced end-to-end through the real
MCP server across 0.4.0–0.4.5.

The constraint that makes this non-trivial: the coverage run must stay
**observationally equivalent** to the tests-gate suite run (the governing rule at
the top of `python-line-coverage.ts` — two prior false SAFEs came from the two
runs diverging). So the fix must isolate the **driver** (the `import coverage`)
without changing what the **suite** sees on `sys.path`.

## The trap (why the obvious fix is wrong)

Launching the driver by absolute package path (`python <site-packages>/coverage
run …`) sets `sys.path[0]` to the coverage dir and looked sufficient. It is **not**:
measured empirically, it still forges under `PYTHONPATH=.` — the *documented*
shadow-bypass remedy. `import coverage` from the package-dir launch does not
resolve at `sys.path[0]` (the coverage package's own dir holds no top-level
`coverage`), so it falls through to `PYTHONPATH` **before** site-packages, and a
repo-local `coverage.py` on `PYTHONPATH=.` (= the shadow cwd) is imported. This is
exactly the "the fix for one false SAFE introduces another" failure this module
keeps relearning — caught here before shipping.

## Decision

**Launch the coverage CLI from a `-c` program that loads coverage from the real
site-packages FIRST, then restores the suite's `sys.path`:**

```python
import sys
sys.path.insert(0, <resolved site-packages>)  # ahead of cwd AND PYTHONPATH
import coverage.cmdline as C
del sys.path[0]                                # restore: the suite runs as the gate ran it
sys.exit(C.main())
```

- **Resolve** the site-packages dir with `<runner> -c "import coverage, os;
  print(os.path.dirname(os.path.dirname(coverage.__file__)))"` run from a
  **freshly-created empty temp dir** (neutral cwd) with the **base env only —
  never the testCmd's `PYTHONPATH`**. Both properties matter: a neutral cwd
  defeats cwd-shadowing; dropping the attacker-hoisted `PYTHONPATH` defeats
  path-shadowing of the resolve itself.
- **Insert / import / delete.** Inserting site-packages at `sys.path[0]` makes the
  driver's `import coverage` resolve the real tool ahead of cwd and `PYTHONPATH`.
  Deleting the inserted entry before `C.main()` runs the suite means the suite
  sees the exact `sys.path` the gate gave it. Verified: the suite's `sys.path[0]`
  is byte-identical to the gate's under `PYTHONPATH=.`, so the package-under-test
  still imports from the shadow.
- **Never fall back to `-m coverage`.** If resolution fails (coverage not
  importable for the interpreter, or a namespace `coverage/` dir with
  `__file__ = None`), the run the gate performed cannot be measured, so decline
  (`coverageToolFound: false` → UNPROVEN). This is the load-bearing invariant, the
  single line most likely to be "simplified" back into the hole.

`shadow-tree.ts` is untouched: the repo-local `coverage.py` stays in the shadow
(the gate's suite legitimately sees it); it is only denied to the **driver**.

## Alternatives considered

- **Absolute-path package launch alone.** Rejected: forges under `PYTHONPATH=.`
  (above).
- **`-P` / `PYTHONSAFEPATH=1`.** Rejected: Python 3.11+ only; the repo supports
  3.8+. The `-c` insert/import/delete is universal.
- **Denylist a repo-local `coverage.py` / `sitecustomize.py` in the shadow.**
  Rejected: a denylist against a whitelist problem — `coverage.py` is not the only
  shadowing name, and it would diverge the suite from the gate. The launcher
  immunizes the driver's import against all cwd/`PYTHONPATH` shadowing at once.

## Consequences

- **Positive.** Closes GHSA-739m-x9gc-9wjv, including under `PYTHONPATH=.`.
  Fail-safe by construction: the only verdict move is toward UNPROVEN.

  Correction (2026-09-07): an earlier version of this bullet claimed the fix also
  closed a repo-root `sitecustomize.py` driver-startup vector "because the driver's
  neutral cwd never imports it." That was WRONG — only the site-packages RESOLVE
  runs from a neutral cwd; the DRIVER runs from the shadow tree, so `site` imports
  a shadow `sitecustomize.py` at startup exactly as before. The launcher does NOT
  close the `sitecustomize` sys.modules substitution (F1), and no in-process
  launcher can (attempts with `-S` and with a `sys.modules` purge both failed;
  see ADR-19). That vector and the general in-process forgery family are mitigated
  by the trust-mode gate (ADR-19), which withholds SAFE for an untrusted diff.
- **Negative, fail-safe.** A repo whose coverage is importable ONLY via the
  testCmd's `PYTHONPATH` (not installed in the interpreter) now declines to
  UNPROVEN. A repo that vendors a root `coverage.py` without pip-installing
  coverage declines (indistinguishable from the attack, correctly refused). Both
  are rare and move only toward UNPROVEN.
- **Out of scope, filed separately.** The suite runs *in the same process* as
  coverage's collector, so a malicious test can still tamper with the data file /
  tracer in-process, and a `[tool.coverage] plugins = evil` entry makes the driver
  import an attacker plugin. A1's fix does not touch these; they are their own
  findings/advisories.

## Compliance

- Red-first: `tests/integration/coverage-driver-shadow.test.ts` — a repo-root
  `coverage.py` fabricating coverage returns SAFE on the pre-fix tree and UNPROVEN
  after, **and** a second case pins the `PYTHONPATH=.` regression so the abs-path
  form cannot be reintroduced.
- Equivalence preserved: `tests/integration/coverage-reporter.test.ts` (30 cases,
  including the shebang-interpreter and json-failure paths) stays green.
- Isolation at the redaction site: `tests/unit/verify/runner-env-redaction.test.ts`
  — a planted repo-root `coverage.py` is now never executed by any coverage spawn.
