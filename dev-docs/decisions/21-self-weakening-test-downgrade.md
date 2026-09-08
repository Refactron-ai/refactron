# ADR-21: Withhold SAFE when a diff weakens its own tests

> Status: **Accepted** (founder sign-off given)
> Date: 2026-09-08
> Deciders: @omsherikar
> Relates: #163. Extends [ADR-19](19-trust-mode-gate.md).

## Context

Refactron verifies a diff against the POST-diff test suite. A diff can therefore
"pass" by relaxing the very tests that would catch it — removing an assertion,
deleting a test, adding a `skip`/`xfail`. The weakened suite reads green, the
changed line is still covered, and on the **trusted** path that earned `SAFE`. The
engine already surfaced `testFilesChanged` for exactly this worry, but as a note,
not a verdict input. This is squarely Refactron's premise: an AI agent quietly
relaxing its own test to make its change pass is a documented failure mode.

The untrusted path is out of scope here: ADR-19 already floors an untrusted
would-be-SAFE to `UNPROVEN`. The exposure is the trusted path (`--trusted`).

## Decision

A **trusted** would-be-`SAFE` whose diff **weakened** any changed test file is
withheld to `UNPROVEN`, naming the weakened test (distinct reason substring
"weakened the tests"). `testWeakening` is a **required** `fuseVerdict` param (a
forgotten one silently skips the downgrade — the exact defect), and an **additive**
`testWeakening?: WeakenedTest[]` field on `VerdictReport` (disclosure; present on
untrusted-withheld reports too). `reportVersion` stays `1`; `src/contracts.ts`
untouched.

**Degrade-only, never `UNSAFE`.** We cannot distinguish a self-weakening from a
legitimate behavior change (which also updates its tests). So the only sound move
is to withhold `SAFE`, not to assert the change is broken.

Detection (`src/verify/test-weakening.ts`) is a **conservative heuristic** on
string/comment-stripped source: a NET drop in assertion count, a deleted/renamed
test function, or an added skip/xfail/`SkipTest` marker. Net-additive changes (new
tests, new assertions) are strengthening and are never flagged.

### Scope: broad (any weakened test), not covering-scoped — and why

The downgrade fires when the diff weakened ANY changed test, not only the specific
test that covers the changed line. That refinement is **not deferred by choice —
it is not computable today**: Refactron measures line coverage, not per-test
attribution, so "the test that covers this changed statement" cannot be resolved.
Broad-but-fail-safe means the only error is a false `UNPROVEN` (over-withholding),
never a false `SAFE`. Covering-scoped detection is a follow-on gated on per-test
coverage.

### Placement invariant

`testWeakening` is checked INSIDE the trusted-`SAFE` branch of `fuseVerdict`, NOT
folded into the `wouldBeSafe` conjunction — folding it in would push a reason into
the fall-through reason ladder that spawned two prior false SAFEs. The cost:
**any new `SAFE`-returning path (e.g. a future verified-hermetic trust source) MUST
re-check `testWeakening.length === 0`.** Today there is exactly one `SAFE` return
and it is guarded; a comment at the conjunction records this.

## Known limitations (honest — a heuristic, not a proof)

Every evasion below is a **degrade-miss**: it leaves the pre-#163 verdict (already
`SAFE`), so it introduces **no new false SAFE** — the feature catches the common
and lazy cases and misses the deliberate ones.

- **Closed:**
  - an `assert` line parked inside a docstring/string no longer masks a removed
    real assertion (strings are stripped before counting);
  - `async def test_*` functions are tracked, so deleting or renaming an
    (pytest-asyncio/anyio) async test is caught (CodeRabbit, PR #166);
  - a compound `foo(); assert x` counts the inline assertion at the `;` boundary,
    so removing it does not net zero (CodeRabbit, PR #166).
- **Intake fail-safe (CodeRabbit, PR #166).** The pre-diff read of the base test
  file (`detectWeakenedTests`) fails SAFE-ward on every uncertainty: a non-ENOENT
  read error (EACCES/EISDIR/EIO) and a repo-escaping edit path are BOTH recorded as
  weakening (→ downgrade), never swallowed as "no weakening" — the latter would let
  a gutted test ride a trusted `SAFE`. Escaping paths are refused with the same
  symlink-aware boundary the unified-diff intake uses, before any read, so the read
  cannot become a content-disclosure oracle. Deep checks (mutation/flaky) are also
  skipped once weakening is present, since the verdict is already floored.
- **Out of scope, tracked as follow-ups (#164 recall, #165 precision):**
  - **Count-preserving compensation** — remove the covering assertion, pad an
    unrelated test in the same file. The file-global count nets zero. Needs
    per-test (per-function or coverage-linked) counting.
  - **Semantic loosening** — `assert x == 5` → `assert x >= 0`: same count, weaker
    meaning. Needs assertion-semantics (AST), not a count.
  - **Bare `return` short-circuit** — a `return` added before the asserts in a
    test body (imperative `pytest.skip()` / `raise SkipTest` ARE caught). Needs
    per-function body analysis.

These are pinned as known-negative tests so the suite does not imply coverage it
lacks, and Level 1 must be described as clear-weakening-only, never as complete.

## Consequences

- **Positive.** Closes the common/lazy self-weakening `SAFE` on the trusted path —
  strictly more honest than main, where a trusted gutted-test diff got a clean
  `SAFE`. Disclosure (`testWeakening`) rides `base`, so even an untrusted-withheld
  report surfaces the weakening.
- **Negative, fail-safe.** A legitimate test refactor that net-removes an
  assertion (collapsing asserts into `@parametrize`, extracting an assert helper)
  reads `UNPROVEN` on the trusted path — annoying, never dangerous, and it hands
  the author a named, actionable reason. Track the false-`UNPROVEN` rate with the
  existing `scripts/flip-rate/` corpora.
- **Fail-safe by construction.** The signal only moves `SAFE` → `UNPROVEN`; it
  cannot create a `SAFE` or assert `UNSAFE`.

## Semver

Additive field, `reportVersion` 1, `contracts.ts` untouched → a `SAFE`-semantics
**tightening** signalled by `engineVersion`, shipped as a **patch (0.4.6 → 0.4.7)**,
staying in 0.4.x. Not a minor: the version-bumping rule forbids a minor on an
additive-field mechanic alone.

## Compliance

Red-first: `tests/integration/self-weakening-tests.test.ts` — a behavior-changing
diff that removes its covering assertion is `SAFE` on `main` under `--trusted`,
`UNPROVEN` after (pinned with the reason + `testWeakening` + `changedLinesCovered
=== true` so a coverage-gap UNPROVEN can't pass it green). Unit:
`tests/unit/verify/test-weakening.test.ts` (removed assert, deleted/renamed test,
async rename, inline `; assert`, each skip/xfail family, `self.fail`, docstring-mask,
and the known-negatives), `tests/unit/verify/detect-weakened-tests.test.ts` (the
intake fail-safe: read-error → weakening, escaping path → refused, ENOENT → new
file), and the `verdict-fuse.test.ts` downgrade both directions.
