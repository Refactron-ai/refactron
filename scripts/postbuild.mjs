#!/usr/bin/env node
// Post-build: copy the Python sidecars into dist/ and prove they arrived.
//
// This used to be two npm scripts made of shell commands:
//
//   mkdir -p dist/verify/checks/_py && cp src/verify/checks/_py/*.py dist/...
//
// npm runs scripts through cmd.exe on Windows, where `mkdir` is a builtin that
// rejects `-p` ("The syntax of the command is incorrect"), so `npm run build`
// had never worked there. Nothing caught it because the only job that built was
// ubuntu-only; the Windows matrix ran tests without ever building. Adding a
// build step to the test job surfaced it.
//
// The sidecars are copied rather than emitted by tsc, so a regression here is
// silent at build time and fatal at runtime: every Python verdict fails against
// a missing sidecar. That is why this asserts rather than trusting the copy,
// and why the list is derived from the source directory instead of hardcoded —
// a fourth sidecar would otherwise ship unverified.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src/verify/checks/_py');
const OUT = join(ROOT, 'dist/verify/checks/_py');

// Named as well as discovered: deleting a source file must fail here too, not
// only a failed copy. A missing pytest_config.py floors every pytest verdict.
const REQUIRED = [
  'imports_check.py',
  'mutate.py',
  'pytest_config.py',
  'statement_map.py',
  'syntax_check.py',
];

const sidecars = readdirSync(SRC).filter((f) => f.endsWith('.py'));
const absent = REQUIRED.filter((name) => !sidecars.includes(name));
if (absent.length > 0) {
  console.error(`postbuild: required sidecars missing from ${SRC}: ${absent.join(', ')}`);
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
for (const name of sidecars) copyFileSync(join(SRC, name), join(OUT, name));

const missing = sidecars.filter((name) => !existsSync(join(OUT, name)));
if (missing.length > 0) {
  console.error(`postbuild: sidecars missing from dist: ${missing.join(', ')}`);
  process.exit(1);
}

// Executable bits for the two bins. A no-op on Windows, where npm generates its
// own shims and the mode is ignored.
for (const bin of ['dist/cli/index.js', 'dist/mcp/server.js']) {
  const p = join(ROOT, bin);
  if (!existsSync(p)) {
    console.error(`postbuild: expected bin not built: ${bin}`);
    process.exit(1);
  }
  if (process.platform !== 'win32') chmodSync(p, 0o755);
}

console.log(`postbuild: ${sidecars.length} sidecars copied and verified, 2 bins marked executable`);
