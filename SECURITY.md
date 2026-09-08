# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report privately via either:

- **GitHub Security Advisory** (preferred): https://github.com/Refactron-ai/refactron/security/advisories/new
- Email: `omsherikar0229@gmail.com`

You will receive an acknowledgement within **72 hours**. For high or critical
issues we coordinate disclosure with you and aim to ship a patched release before
any public details are published. Please allow a reasonable embargo window.

When reporting, include a description, reproduction steps, the affected version,
and the impact you believe it has. A reproduction we can run is worth more than a
careful description of one.

## Supported versions

| Version   | Status                                                              |
| --------- | ------------------------------------------------------------------- |
| `0.4.x`   | **Supported.** Security fixes ship here.                            |
| `0.3.x`   | End of life. Contains known false-`SAFE` defects fixed in `0.4.x`.  |
| `≤ 0.2.x` | End of life. Contains [GHSA-q3vj-5qq5-m84g](https://github.com/Refactron-ai/refactron/security/advisories/GHSA-q3vj-5qq5-m84g). |

Refactron is pre-1.0 and ships behaviour changes in patch releases. Security
fixes are not backported below the current minor; upgrade instead.

## What Refactron is

A verification layer. A diff goes in; `SAFE`, `UNSAFE` or `UNPROVEN` comes out,
backed by the repository's own test suite run in an isolated shadow tree with
changed-statement coverage fused in.

It ships two binaries from one npm package: `refactron` (CLI) and `refactron-mcp`
(a stdio MCP server). The PyPI distribution is a shim that locates and executes
the npm binary; it contains no engine code of its own.

The refactoring product — `analyze`, `run`, `document`, `rollback`, `preflight`,
`init`, the AST transforms and the atomic batch writer — was removed in `0.4.0`.
Refactron no longer writes code. Anything below describing a write path to your
files describes something that does not exist.

## Threat model

Refactron's inputs are **hostile by design**. The diff under verification is
authored by an AI agent, a contributor, or a codemod, and the test suite it runs
belongs to the repository being verified. Both are treated as untrusted.

### What we defend

- **Your working tree.** Refactron never writes to it. Changes are applied to a
  copy under the system temp directory, the gates run there, and the copy is
  removed. There is no code path from a verdict to your files.
- **Shadow-tree containment.** A change whose path resolves outside the shadow
  tree is refused. Containment is resolved with `realpath`, not string
  comparison, and repository symlinks whose target escapes the repository are not
  mirrored into the tree.
- **Diff intake.** A path taken from a diff's `---`/`+++` headers is refused
  before it is read if it resolves outside the repository.
- **Your credentials.** The test suite Refactron runs does not inherit them.
  Every variable handed to a spawn that executes the suite is stripped if its name
  carries a credential word (`TOKEN`, `SECRET`, `KEY`, `PASSWORD`, `COOKIE`,
  `SESSION`, `AUTH`, `CERT`, …, matched per underscore-segment so `MY_TOKENIZER_PATH`
  survives) OR its value looks like a credential — a known token prefix (`sk_`,
  `ghp_`, `AKIA…`), a `user:pass@` connection string, a `-----BEGIN` block, or a
  high-entropy blob. Value shape is the axis an attacker cannot rename around
  (ADR-20). `REFACTRON_FORWARD_ENV` re-admits a var an operator knows is a non-secret.
- **Verdict integrity.** A false `SAFE` is the only unforgivable defect in this
  product. Every degradation path — a missing sidecar, an unmeasurable coverage
  run, a test command we cannot parse, a flaky heal — resolves to `UNPROVEN`,
  never to `SAFE`.

### What we explicitly do not defend

Stated plainly, because a guarantee with an unstated hole is worse than no
guarantee.

- **We do not sandbox your test suite.** Running `refactron verify-diff` runs the
  repository's tests. That is no more and no less safe than running `npm test` or
  `pytest` on the same repository yourself. A test that writes to an absolute
  path, opens a socket, or spawns a process will do so. Isolation means the
  shadow tree is a genuine copy, not that the suite is confined to it.

- **Credential redaction is best-effort, not a sandbox.** We strip variables whose
  name or value looks like a credential (above), which closes the common shapes and
  every vector in GHSA-7gr9-rqqx-xg6m — but a secret that is BOTH benignly named and
  benign-valued (say `DEPLOY_PIN=8675`) is undetectable. Do not run untrusted
  verification in an environment scoped to hold production secrets it does not need;
  the durable control is not putting them there, not the redaction.
- **We do not sandbox the Python sidecars.** They parse source with the standard
  library and LibCST; they do not execute it.
- **The MCP server applies no authentication.** For a stdio transport the trust
  boundary is the process spawn: whoever starts the server can already run
  arbitrary commands as you. It makes no network calls and reaches no remote
  service. Do not expose it over a network transport without adding
  authentication first.
- **A `SAFE` verdict is not a proof of correctness.** It means your suite ran the
  changed code and stayed green. It inherits exactly what your tests check.
- **Narrowing detection is a strong check, not a guarantee.** Refactron reads the
  test command, the environment and your pytest configuration, and knows the
  common flags of `pytest`, `unittest`, `vitest` and `jest`. A command using a
  flag it does not recognise reports `unknown`, which does not cap the verdict.
  A vitest `include` or a jest `testMatch` is not seen; those are JavaScript and
  would have to be executed rather than parsed.

## Supply chain

- npm releases are published from GitHub Actions with an OIDC trusted publisher
  and `--provenance`. Verify with `npm audit signatures`.
- PyPI releases use a trusted publisher. That attestation covers the **shim**,
  not the engine: the shim executes whichever `refactron` binary is first on your
  `PATH`. If you pin the PyPI package, pin the npm package to the same version.
- Releases are gated on `npm audit --audit-level=high`.
- Remediation is lockfile-only where possible; a declared range is not widened to
  clear an advisory.

## Runtimes

Node.js **18+** is required. Python **3.8+** is required for coverage-backed
verdicts and for the syntax, imports and statement-mapping sidecars. Without
Python, verdicts degrade to `UNPROVEN` rather than failing open.

## Past advisories

| Advisory | Affected | Fixed | Summary |
| --- | --- | --- | --- |
| [GHSA-q3vj-5qq5-m84g](https://github.com/Refactron-ai/refactron/security/advisories/GHSA-q3vj-5qq5-m84g) | `>= 0.2.0, < 0.4.2` | `0.4.2` | The shadow tree hardlinked unchanged files, so a verified test suite could write through into the caller's repository while the verdict reported `SAFE`. |

## Known dependency advisories

None outstanding. `npm audit --audit-level=high` reports zero vulnerabilities as
of `0.4.2`.
