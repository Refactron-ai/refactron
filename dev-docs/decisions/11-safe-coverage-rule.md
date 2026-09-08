# ADR-11: SAFE requires every coverable changed statement to have executed

> Status: **Accepted** (superseded in part by [ADR-18](18-excluded-changed-statement-floors.md))
> Date: 2026-08-17
> Deciders: @omsherikar
>
> **Superseded in part (2026-09-06, ADR-18, GHSA-9xch-4mch-222g):** the
> "coverable = statements − excluded" subtraction below is attacker-controllable
> (a diff can add `# pragma: no cover` / a coveragerc regex to a changed
> statement). ADR-18 removes the subtraction: an excluded CHANGED statement now
> floors to UNPROVEN. The per-statement, per-file rule this ADR established stands;
> only the treatment of excluded changed statements changed.

## Context

`SAFE` has rested on a per-**file** coverage rule since v1 of the verify engine. A changed file cleared the coverage check as soon as *one* of its changed statements appeared in the coverage map (`src/verify/coverage-attribution.ts`, `allFilesExercised`). A diff changing 40 statements in one file, of which 1 executed, returned:

```
SAFE | coverage.py | "Tests pass and the changed code is covered."
```

The reason string asserts "the changed code is covered", which overstates what was proven. The shortfall was disclosed elsewhere in the report (`coverage.uncovered` is always populated, `coverage.changedStatements` carries the ratio), but disclosure is not the verdict, and both consumers — the MCP tool and the CI gate — read `report.verdict`.

This was a known limitation, not a hidden one. `docs/verification/verdicts.mdx` shipped it to users and called requiring all changed statements "the roadmap item here". It is filed as issue #109, with the decision separated into #108 because the replacement rule is not a detail: it decides how many currently-`SAFE` verdicts become `UNPROVEN` for every consumer.

The measurement needed already exists. `changedStatements: { total, covered }` is computed in `attributeChangedLines`, carried on the public report, and annotated "Additive and advisory: it does NOT feed the verdict rule." Today it is consumed only for CLI display. No new measurement is required, only a rule change.

One complication forced the decision to be made rather than assumed. `changedStatements.total` counts statements coverage.py **excluded** — `# pragma: no cover` bodies and `if TYPE_CHECKING:` blocks. An excluded statement increments `total`, can never increment `covered` because no test can execute it, and is pushed to `uncovered` tagged `excluded: true`. A literal `covered === total` rule therefore makes `SAFE` **unreachable** for any diff that adds a typing-only import block.

## Decision

**`SAFE` requires that every changed statement a test *could* have executed did execute.** Formally: `covered === coverable`, where `coverable` is the count of distinct changed statements minus those coverage.py excluded, and `coverable > 0`.

Excluded statements are subtracted from the denominator rather than counted as covered. Counting them as covered would let a diff whose only changed statement is inside `if TYPE_CHECKING:` read as proven, which is the opposite of true: no test can reach it, so nothing about it was proven.

`coverable > 0` is load-bearing. A change consisting entirely of excluded statements has a denominator of zero, and `0 === 0` would issue `SAFE` on a change no test can reach. Such a change floors at `UNPROVEN`, and its `missingTests` hints already say the right thing ("excluded from coverage … review this change by hand") rather than asking for an impossible test.

The per-file conjunct is subsumed, not removed: if every coverable changed statement executed, then every changed file holding a coverable statement was exercised. The existing cross-file test survives unmodified, which is the check that the tightening did not trade one protection for another.

`reportVersion` stays `1`. No field is added, renamed, retyped or removed, so the **shape** contract holds. The **semantics** of `verdict` and `coverage.changedLinesCovered` do change, and a consumer storing fleet history can partition it exactly: a `SAFE` carrying `changedStatements.covered < total` was earned under the old rule. That is strictly more information than a version bump would give, since it identifies *which runs* were affected rather than only *when* the change landed. Tracked separately: an `engineVersion` field is the general answer to semantic tightenings and should be filed rather than solved here.

Version: **patch**, shipping as 0.4.x. Semver would put a behaviour change in the minor for a 0.x project, but this repository reserves the minor for a delivered milestone rather than a mechanical rule (see `COMMIT_CONVENTIONS.md`). One consequence to know rather than debate: `^0.4.0` resolves to `>=0.4.0 <0.5.0`, so a patch reaches existing users automatically where a minor would not. The changelog therefore has to carry the weight a version number is not carrying.

## Alternatives considered

### Alternative A: ratio threshold, `covered / total >= X`

Keep most current `SAFE` verdicts by requiring a high fraction rather than all.

Rejected. It puts an arbitrary constant at the centre of the one number the product's honesty rests on, and the constant is indefensible at every value: a diff sitting just above the line is `SAFE` and one just below is `UNPROVEN`, with no difference in what was actually proven. It also cannot be explained to a user in a sentence, and "SAFE means 90% of your change was tested" is a claim nobody wants to read on a verification tool.

### Alternative B: keep the per-file rule, rely on disclosure

Leave the heuristic and point users at `coverage.uncovered` and `changedStatements`.

Rejected. This was the status quo, and it is precisely the shape of defect this project treats as unforgivable: the verdict claims proof it does not have. Disclosure beside a wrong verdict is not a substitute for a right one, because every automated consumer gates on `verdict` and never reads the ratio.

### Alternative C: count excluded statements as covered

Simpler than subtracting them: treat `# pragma: no cover` as satisfied.

Rejected. It makes a diff whose only change is inside an excluded block read as fully proven. Subtracting from the denominator and requiring `coverable > 0` reaches the honest answer for the same cases at the same cost.

## Consequences

- **Positive**: `SAFE` now means what its reason string says. A reader can check the claim against `changedStatements` and find them consistent.
- **Positive**: fail-safe direction only. Every verdict this changes moves `SAFE` to `UNPROVEN`; no path can move `UNSAFE` or `UNPROVEN` to `SAFE`, because the rule is a strict tightening of one conjunct and the gate results feeding `UNSAFE` are untouched.
- **Negative**: real diffs that read `SAFE` today read `UNPROVEN` tomorrow. Partially-covered changes are common, so this is not a rare edge; it is the point of the change and it is visible to every user.
- **Negative**: a large refactor touching many statements now needs near-complete coverage of the changed lines to earn `SAFE`. For weakly-tested repositories `SAFE` becomes hard to reach. That is an honest report of a weak suite, but it will read as the tool getting stricter for no reason unless the reason string explains itself.
- **Neutral**: exit codes unchanged. `SAFE` and `UNPROVEN` both exit `0`; only `UNSAFE` exits `1`. No CI pipeline breaks.
- **Neutral**: `changedStatements` stops being advisory and becomes a verdict input. Its comment must stop saying otherwise.

## Compliance

- A red-first integration test: a single changed file with many changed statements of which exactly one executes, asserting `UNPROVEN`. Proven failing against the pre-change tree, where it returns `SAFE`.
- A unit test on `attributeChangedLines` for the same shape, so a failure localises to attribution rather than fusion.
- `tests/unit/verify/coverage-attribution.test.ts` "one executed statement in a file is enough for the per-file heuristic" is **rewritten, not deleted**: same input, inverted expectation, comment replaced with the new rule. Deleting it would remove the record of what changed.
- "every changed file must have an exercised statement (per-file, not global)" must keep passing **unmodified**, proving the cross-file protection was not traded away.
- A test that an excluded-only change does not reach `SAFE`, and a test that an otherwise-covered change containing an excluded statement does.
- Every pre-existing `toBe('SAFE')` assertion in the suite is audited and either still holds or is updated with a note saying why the verdict changed. Two of this project's three known false `SAFE`s were introduced by fixes for the other, so a silently-edited `SAFE` assertion is the specific thing to watch for.

## Rollout / migration

- **Consumers**: a partially-covered diff that read `SAFE` now reads `UNPROVEN`, with a reason naming the ratio rather than the generic "not exercised by any test", which would be false when some statements did run.
- **Docs**: shipped locations stating the old per-file rule are corrected together — `docs/overview.mdx`, `docs/quickstart.mdx`, `docs/verification/verdicts.mdx`, `docs/verification/verify-diff.mdx`, `docs/mcp/overview.mdx`, `README.md`.

  **Amendment, 2026-08-17 (issue #123).** As originally written this section
  claimed five locations were "corrected together". They were not. Four survived
  the sweep in #113 and shipped contradicting the engine: `verdicts.mdx:42`
  (against its own line 44), `verdicts.mdx:86` (a JSON sample the engine can no
  longer produce), `verify-diff.mdx:176`, and `docs/mcp/overview.mdx:127`, which
  is agent instruction text.

  The cause is worth recording, because it will recur. The sweep grepped for the
  literal phrase `at least one changed (line|statement)`. Line 42 reads `at least
  one changed **statement**` — markdown emphasis inside the phrase — and
  `mcp/overview.mdx` wrapped the phrase across two lines. A line-oriented,
  literal grep cannot see either. **A rule-change sweep must search for the
  concept with a whitespace- and emphasis-tolerant pattern across the whole file,
  not for a phrase within a line**, and must finish by re-running that search and
  reading every surviving hit rather than trusting a clean exit code.
- **Release**: 0.4.x, alongside ADR-12's scope rule. Both are tightenings of `SAFE` and the changelog presents them under one "what SAFE now means" heading, because shipping two independent narrowings of the same verdict in one release is otherwise confusing.

## Open questions / follow-ups

- [ ] `engineVersion` on `VerdictReport`. Two ADRs in one release have now changed what `SAFE` means without changing the report shape. `reportVersion` answers "can I parse this?", not "what did SAFE mean when this was written?"
- [ ] Branch coverage. This rule is statement-level: a changed `if` whose true branch never ran still counts as covered. That is a strictly larger gap than the one closed here.
- [ ] Non-Python coverage. A TypeScript or mixed diff still returns `UNPROVEN` with "coverage could not be determined", so this rule never applies to it.
