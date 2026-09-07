"""Python wrapper around the Refactron npm CLI.

Refactron is the verification layer for AI code change: it applies a diff in
an isolated shadow tree, runs your real test suite, and returns a `SAFE`,
`UNSAFE`, or `UNPROVEN` verdict.

This package is a thin shim. All real work happens in the npm `refactron`
package, so Node.js 18+ must be on your PATH. Installing this gives Python-first
toolchains the `refactron` command without adding a Node dependency to their
project manifest.

`__version__` is the single source of truth for this package's version:
pyproject.toml reads it statically via `[tool.setuptools.dynamic]`, so the
distribution metadata and the runtime value cannot drift apart.
"""

__version__ = "0.4.6"

__all__ = ["__version__"]
