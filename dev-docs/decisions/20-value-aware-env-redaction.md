# ADR-20: Value-aware credential redaction to the verified suite

> Status: **Accepted**
> Date: 2026-09-07
> Deciders: @omsherikar
> Closes: GHSA-7gr9-rqqx-xg6m (advisory B).

## Context

`redactEnvForRunner` (`src/verify/runners/run.ts`) strips credentials from the
environment before Refactron spawns the repository's OWN test suite — attacker
code in the verify-untrusted-PR deployment, where the CI environment holds the
secrets of the repo being protected. It is the single choke point: the tests gate
(`runRunner`) and all three coverage spawns (`python-line-coverage.ts`) use it.

It was an enumerated **name denylist** (exact names + trailing suffixes `_TOKEN`,
`_SECRET`, `_API_KEY`, `_PASSWORD`, `_CREDENTIALS`). Advisory B showed it leaks:
`STRIPE_KEY` (bare `_KEY`), `DATABASE_URL` / `REDIS_URL` (connection strings with
embedded credentials), `SESSION_COOKIE`, `MY_COMPANY_SECRET_VALUE` (ends `_VALUE`,
not `_SECRET`) all reached the suite. A name denylist keyed on the one axis where
enumeration fails.

## Decision

Keep forwarding by default (a denylist, not an allowlist) but match three ways:

1. **Exact denylist** — the existing set, verbatim.
2. **Segment-based name match** — split the name on `_`; drop if any segment is a
   credential word (`SECRET`, `TOKEN`, `KEY`, `PASSWORD`, `COOKIE`, `SESSION`,
   `AUTH`, `CERT`, `PEM`, …). Segment, not substring: `STRIPE_KEY`/`SESSION_COOKIE`/
   `MY_COMPANY_SECRET_VALUE` drop, while `MY_TOKENIZER_PATH` and `SECRETARY_EMAIL`
   are kept.
3. **Value-shape match** — drop regardless of name if the VALUE is a known token
   prefix (`sk_`, `ghp_`, `AKIA…`, …), a connection string with an embedded
   `user:pass@`, a `-----BEGIN` block, or a high-entropy opaque blob (≥32 chars,
   base64/hex charset, no `\s/:`, Shannon entropy ≥ 4.0). Value shape is the axis
   an attacker cannot rename around — the repo's real Stripe key looks like one
   however it is named.

Plus **`REFACTRON_FORWARD_ENV`** (comma-separated names in Refactron's parent env):
an operator opt-in un-redact hatch for a var they know is a non-secret, trusted on
the same basis as the secrets (it lives in the CI env, not the diff) and never
forwarded to the child itself.

## Why not an allowlist (the rejected alternative)

An allowlist (forward only known-safe names) is fail-safe on confidentiality but
was rejected here, and the distinction from ADR-19 is the reason:

- ADR-19 broke a default because detection was **undecidable** — the attacker owned
  the measurement process, so the only sound move was to stop trusting. Redaction
  is **decidable**: the defender builds the environment dictionary before spawn and
  the suite only reads it. Fail-safe is not forced.
- A redaction false positive can only move a verdict toward UNPROVEN/UNSAFE, **never
  toward a false SAFE**. So over-redaction is a usability cost, not a trust defect —
  which is why the denylist's residual imperfection is acceptable here and the
  verdict boundary's was not.
- An allowlist drops every suite's custom non-secret var by default (e.g.
  `MY_TOKENIZER_PATH`, pinned "must keep"), a WIDE breaking change and the SECOND
  breaking default in 0.4.6. For a security release adoption is part of the
  mitigation; a fix people pin away from is not a fix. The evidence (B's four
  vectors) showed the denylist CONTENTS were incomplete, not that the architecture
  was wrong.

Value scrubbing is the layer an allowlist would still have needed anyway; here it
is the boundary, not a supplement.

## Consequences

- **Positive.** Every reported B vector no longer reaches the suite, and value-shape
  generalizes past them to unnamed/oddly-named secrets. No suite breakage, no second
  breaking default. One pure function changed; `VerdictReport` untouched (do NOT add
  withheld-var names to the report — that would leak the names).
- **Negative, fail-safe and bounded.** A high-entropy non-secret (a 40-char git SHA)
  can be redacted; the cost is a suite that needed it degrading to UNPROVEN/UNSAFE,
  re-addable by name via `REFACTRON_FORWARD_ENV`. Never a false SAFE.
- **Residual, disclosed (SECURITY.md).** A value that is BOTH benignly named and
  benign-valued (e.g. `DEPLOY_PIN=8675`) is undetectable by name or shape. Redaction
  is best-effort defense-in-depth, NOT a sandbox: do not run untrusted verification
  in an environment scoped to hold production secrets it does not need.

## Compliance

- Red-first: `tests/unit/verify/runner-env-redaction.test.ts` — the B vectors and a
  value-shape / escape-hatch set are RED against the pre-fix denylist and green
  after, at the pure function AND at the real spawn (the SEC-3 probe, since a pure
  test passed once while the spawn still leaked).
- Sibling to ADR-17/18/19 (the same "the diff and its suite are hostile" pass); the
  advisory claims the reported vectors fixed, not the whole class.
