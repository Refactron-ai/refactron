# refactron (Python wrapper)

**The verification layer for AI code change.** Refactron proves that a change,
your AI agent's, a codemod's, or your own, preserved behavior. It applies the
diff in an isolated shadow tree, runs your real test suite, and returns a
three-way verdict: `SAFE`, `UNSAFE`, or `UNPROVEN`. Your working tree is never
touched.

This package is a **thin Python shim** around the
[npm `refactron` package](https://npmjs.com/package/refactron). It exists so a
Python-first toolchain can put the `refactron` command on your PATH without
adding Node to your project manifest. All the real work happens in the Node
CLI.

## Requirements

- **Node.js 18+ on your PATH.** This wrapper does not remove the Node
  dependency; it only saves you from wiring the CLI in by hand.
- **Python 3.8+**, plus `coverage.py` in the environment your tests run in if
  you want coverage-backed verdicts.

## Install

```bash
pip install refactron==0.4.8
npm install -g refactron
```

Both lines matter. The pip package gives you the `refactron` entry point; the
npm package is what it runs. Keep the two versions equal: the wrapper prints a
warning to stderr when they disagree.

The wrapper **does not install the npm package for you**. A `pip install` that
silently ran `npm install -g` would write outside your Python environment and
would pull whatever version is `latest`, which is not necessarily the version
you pinned. If the Node CLI is missing, the wrapper tells you the exact command
to run and exits non-zero.

Prefer not to install globally? Skip the pip package and use
`npx refactron <command>` directly.

## Usage

Identical to the npm package. Every argument is passed straight through.

```bash
refactron login                                  # or set REFACTRON_TOKEN in CI
refactron verify-diff . --diff change.diff --test-cmd "python3 -m pytest -q"
refactron preflight ./my-sqlalchemy-app
refactron analyze .
refactron run --apply
```

`verify-diff` exits `1` on `UNSAFE`, `2` on bad input, `7` when
unauthenticated, and `0` on both `SAFE` and `UNPROVEN`. `UNPROVEN` is a
warning, not a rejection: read the `verdict` field from `--json` if you want CI
to fail on it.

Coverage attestation is Python-only, via `coverage.py`. A TypeScript, mixed, or
otherwise non-Python diff caps at `UNPROVEN`; it never returns a false `SAFE`.

## MCP server

The npm package also ships a `refactron-mcp` binary, a stdio MCP server
exposing a `verify_change` tool your agent calls before it lands a change. It
is not routed through this wrapper: point your MCP client at `refactron-mcp`
directly. See the [MCP docs](https://docs.refactron.dev/verification/mcp-server).

## Environment variables

| Variable                       | Effect                                                    |
| ------------------------------ | --------------------------------------------------------- |
| `REFACTRON_TOKEN`              | Authenticates non-interactive runs (CI).                  |
| `REFACTRON_SKIP_VERSION_CHECK` | Set to `1` to silence the wrapper's version-skew warning. |

## License

Apache-2.0. See `LICENSE` and `NOTICE`.

Full docs: https://docs.refactron.dev
