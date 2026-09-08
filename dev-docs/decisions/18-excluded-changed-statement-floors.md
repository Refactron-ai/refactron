# ADR-18: An excluded changed statement floors SAFE

> Status: **Accepted**
> Date: 2026-09-06
> Deciders: @omsherikar
> Closes: GHSA-9xch-4mch-222g (private advisory). Supersedes in part [ADR-11](11-safe-coverage-rule.md).

## Context

ADR-11 defined the SAFE coverage rule in terms of **coverable** statements:
`coverable = changedStatements − excludedStatements`, and required every coverable
changed statement to have executed. Excluded statements (`# pragma: no cover`,
`if TYPE_CHECKING:`, coverage config `exclude_lines`) were **subtracted** from the
requirement, on the theory that no test can execute them, so counting them would
make SAFE unreachable for a diff that merely adds a typing-only import block.

That theory assumes a good-faith author. The verify engine's inputs are hostile by
design: the diff under verification is untrusted, and so is every file it carries,
**including the coverage configuration and any pragma**. So the exclusion set is
attacker-controlled.

**The hole, reproduced (GHSA-9xch-4mch-222g).** A diff adds a backdoor and marks
it excluded:

```python
    result = amount + 1
    if amount == 1337:  # pragma: no cover
        return -999999.0
    return result
```

`fee(100)` is the only test; it exercises `result` and `return result` but never
the pragma'd branch. The `# pragma: no cover` subtracts the two malicious
statements from the requirement, so the file reads `covered === coverable` and the
verdict is `SAFE` over a live `return -999999.0` — a false SAFE, the one
unforgivable defect. The only disclosure is a `uncovered[].excluded: true` entry
that reads as benign. Inline pragma, `.coveragerc`, and `pyproject
[tool.coverage] exclude_lines` all reach it; all are attacker-authored.

## Decision

**Stop subtracting excluded statements. An excluded CHANGED statement floors the
file to UNPROVEN.** A file is proven iff it has at least one changed statement and
**every** changed statement executed:

```ts
if (acc.statements === 0 || acc.covered < acc.statements) allFilesProven = false;
```

coverage.py never lists an excluded line in `executed_lines`, so an excluded
changed statement can never be counted covered, and `covered < statements` whenever
one exists. The `statements === 0` arm preserves ADR-11's guard that keeps
removal-only and inert-only files UNPROVEN.

An excluded changed statement is not evidence of anything — the author chose to
exclude it. `UNPROVEN` ("we could not prove this changed statement is exercised")
is the true verdict; `SAFE` would be the lie.

**Disclosure.** `CoverageAttribution`/`CoverageAssessment` gain an additive
`excludedChangedStatements` count, and the UNPROVEN reason gains a distinct,
stable substring for the exclusion-floor case whose remedy is **not** "add a test"
(no test can execute an excluded line): it says the changed statement is excluded
from coverage and, for an untrusted diff, cannot be proven — remove the exclusion
or verify it another way.

## Alternatives considered

### F2 — floor only when the exclusion was introduced by the diff
Rejected on **soundness**, not ergonomics. Two independent fatal flaws:
- **It needs data coverage.py does not emit.** Coverage's JSON gives a flat
  `excluded_lines` list with no attribution to the marker/config that triggered
  each exclusion. You cannot tell a `# pragma` from a `.coveragerc` regex from
  `if TYPE_CHECKING:`. (Same lesson as ADR-17: do not build a rule on a
  distinction the measurement cannot make.)
- **It has a known false-SAFE bypass.** Config-driven exclusion
  (`[tool.coverage] exclude_lines = .*# x`) puts **no marker on a changed line** —
  the attacker annotates the malicious statement with an innocuous comment and adds
  the regex in `pyproject`. F2's "only floor if the marker is on a changed line"
  waves it straight through to SAFE. A fix with a known false-SAFE bypass is not a
  fix.

### A "trust my own exclusions" mode
Rejected. It is a feature flag for a hypothetical non-adversarial user, and it
reopens the exact hole. Not added.

### A spoof-proof `if TYPE_CHECKING:` carve-out
`TYPE_CHECKING` blocks are dead at runtime, so they cannot carry a behavioral
backdoor — a tempting carve-out. Deferred: coverage's JSON can't distinguish
`TYPE_CHECKING` from a pragma, and the name itself is spoofable (an attacker binds
`TYPE_CHECKING` to a truthy value), so a sound carve-out needs new AST machinery
with its own threat model — a separate signal, not a security patch. Left to a
future ADR if DX data justifies it.

## Consequences

- **Positive.** Closes GHSA-9xch-4mch-222g. A diff-controlled exclusion can no
  longer clear a changed statement. Fail-safe by construction: the only verdict
  move is `SAFE` → `UNPROVEN`.
- **Negative, and fail-safe.** These legit diffs move from `SAFE` to `UNPROVEN`
  (both exit 0 — not a CI failure):
  - a diff adding `# pragma: no cover` to a changed statement (a defensive
    unreachable branch, `if __name__ == "__main__":`);
  - a diff whose changes touch a file's `if TYPE_CHECKING:` block (typing-only
    imports) — note it drops the **whole file** to UNPROVEN;
  - a diff whose changed statement matches a project `.coveragerc` /
    `pyproject` `exclude_lines`/`exclude_also` regex (`def __repr__`, `@overload`).
  The advisory states this plainly: in the verify-untrusted-PR deployment,
  exclusions are not trusted; a diff relying on them earns UNPROVEN by design.
- **Neutral.** `src/contracts.ts` untouched; `reportVersion` unchanged
  (`excludedChangedStatements` is additive).

## Compliance

- Red-first: `tests/integration/coverage-exclusion-forgery.test.ts` — the pragma'd
  backdoor returns `SAFE` on the pre-fix tree and `UNPROVEN` after, and an honest
  fully-covered change with no exclusions still reaches `SAFE`.
- Unit: `tests/unit/verify/coverage-attribution.test.ts` — an excluded changed
  statement floors the file even when every other changed statement is covered.
- Never strengthens: the rule only ever removes SAFE; it cannot create one.
