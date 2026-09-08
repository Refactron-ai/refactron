# ADR-19: The trust-mode gate — withhold SAFE from an untrusted diff

> Status: **Accepted**
> Date: 2026-09-07
> Deciders: @omsherikar
> Closes: GHSA "Finding 1" (private advisory) — the in-process coverage forge.

## Context

Coverage and the pass/fail gates are measured by running the diff's OWN test
suite in the SAME process as the coverage collector (`reportCoverage` in
`src/analyze/coverage/python-line-coverage.ts`). A hostile diff therefore owns
the process the measurement runs in. Red-team reproduced a **~6-line
`conftest.py`** — public coverage API only
(`coverage.Coverage.current().get_data().add_arcs`) — that marks a never-called
changed line executed, earning a clean **false SAFE**. Verified end-to-end
through `verifyDiff` and through the published `refactron@0.4.5` MCP server;
present in every shipped line (0.3.1–0.4.5). No `sitecustomize`, no `PYTHONPATH`,
no coverage-tool substitution: `conftest.py` is loaded by pytest unconditionally.

The launcher and exclusion fixes (ADR-17, ADR-18) close *named* forgery vectors
(a repo-root `coverage.py`; a changed-line exclusion). They do not, and cannot,
close the *general* problem that attacker code shares the collector's process.
Two attempts to close the sibling `sitecustomize` sys.modules substitution (F1)
in the launcher both failed: `python -S` is version-fragile (a repo `site.py`
forges on Python ≤3.10, where `site` is not frozen) and re-exposes coverage's own
transitive stdlib imports to cwd-shadowing on all versions; purging `sys.modules`
under normal startup is defeated by a `meta_path` finder. **There is no robust
in-process launcher fix.** Detecting the forgery is undecidable from inside the
process the forger controls.

## Decision

**A would-be-SAFE verdict is WITHHELD — floored to UNPROVEN — unless the diff's
author is declared TRUSTED.** The floor is a single choke point in `fuseVerdict`
(`src/verify/verdict-fuse.ts`), applied only to the SAFE branch:

- **Default: untrusted.** The product's stated purpose is verifying untrusted
  changes (an AI agent's, an outside contributor's), so the safe default must be
  the one that does not trust the forgeable measurement. `UNSAFE` (a real gate
  failure) is unaffected — an attacker does not forge a failure against their own
  goal; only `SAFE` is withheld.
- **`trusted` is asserted by the OPERATOR, never inferred from the diff.** It
  enters at the I/O boundary: `--trusted` (CLI), `trusted` (verifyDiff input and
  the `verify_change` MCP tool, default false). The diff is the untrusted input;
  it cannot certify itself. In `fuseVerdict` the parameter is REQUIRED (like
  `testScope`) so a new call site cannot silently default to the permissive
  regime — the same discipline that guards the two prior false-SAFE mechanisms.
- **`trustMode` is disclosed** on every `VerdictReport`, and the withheld verdict
  carries a distinct reason substring ("SAFE is withheld"), so a consumer can
  tell a trust withhold from a real coverage gap.

The mitigation stops *trusting* the forgeable evidence rather than trying to
*detect* the forgery. It is therefore the **unified** fix for the whole
in-process family — the `conftest` forge, the `sitecustomize` substitution, and
any future in-process vector all resolve to UNPROVEN for an untrusted diff, with
no per-vector detection. ADR-17/ADR-18 remain as defense-in-depth for the
**trusted** path (a trusted author's stray `coverage.py` or exclusion still can't
fabricate a covered line).

## Alternatives considered

- **Keep patching the launcher.** Rejected: whack-a-mole, and proven
  insufficient — `conftest` tampering needs no launcher vector at all.
- **Mandatory mutation testing for coverage-based SAFE (ADR-15 promoted).**
  Rejected as the *proof*: mutation also runs the attacker's suite in-process, so
  it is a mitigation, not a guarantee. Kept as an optional deeper check.
- **Emit SAFE with an "advisory / not tamper-proof" label.** Rejected: a labeled
  forgeable SAFE is still a false SAFE by the cardinal rule; a consumer keying on
  `verdict === 'SAFE'` is misled.
- **Default trusted, opt-in `--untrusted`.** Rejected: it makes the dangerous
  regime the default and leaves every existing integration (including the MCP
  server that verifies untrusted changes) emitting forgeable SAFEs.

## Consequences

- **Positive.** Closes the entire in-process forgery family for the default
  (untrusted) regime — the regime the product is sold for. Fail-safe: the only
  verdict move is toward UNPROVEN.
- **Negative, fail-safe.** For an untrusted diff, a legitimate fully-covered
  change now returns UNPROVEN instead of SAFE. This is a real behavior change —
  the common coverage-SAFE flips by default — and a consumer keying on SAFE sees
  fewer of them. It is the honest cost: that SAFE was forgeable. Trusted/self use
  (`--trusted`) keeps the old behavior exactly.
- **Strategic.** A trust-grade SAFE over an *untrusted* diff cannot be produced
  by a local, in-process CLI. It requires a **hermetic** run whose measurement
  the suite cannot reach — the future second path to trust-grade SAFE, and the
  reason the signed-verdict backend (the open-core moat) exists. `trustMode` and
  a future `hermetic` signal are the hooks for it.

## Compliance

- Red-first: `tests/integration/coverage-inprocess-forgery.test.ts` (the
  `conftest` forge → UNPROVEN), `tests/integration/trust-gate.test.ts` (one
  honest fully-covered change: trusted → SAFE, untrusted → UNPROVEN), and
  `tests/unit/verify/verdict-fuse.test.ts` (the gate, both directions, plus
  `trustMode` stamped on every verdict).
- Contract: `trustMode` is additive on `VerdictReport`; `reportVersion` stays 1
  (a SAFE-semantics change is signalled by `engineVersion`, per the ADR-11/12
  precedent), and `src/contracts.ts` is untouched.
