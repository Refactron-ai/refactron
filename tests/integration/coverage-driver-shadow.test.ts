// tests/integration/coverage-driver-shadow.test.ts
//
// Security (GHSA-739m-x9gc-9wjv / "A1"). The coverage driver was invoked as
// `python3 -m coverage ...` with cwd = the shadow tree. For `python -m`, cwd is
// first on sys.path, so a repo-local `coverage.py` file shadows the real tool and
// can emit a fabricated coverage.json marking any changed line executed — a clean,
// undisclosed false SAFE reachable by a hostile PR.
//
// The fix isolates the DRIVER: coverage is launched from its installed package
// directory (cwd off the driver's import path) while the SUITE keeps the exact
// sys.path the gate gives it. This test pins that a forged `coverage.py` can no
// longer manufacture coverage: an honestly-uncovered changed line must floor the
// verdict at UNPROVEN, never SAFE.
import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { verifyDiff } from '../../src/verify/verify-diff.js';

function hasPythonTooling(): boolean {
  try {
    execSync('python3 -c "import coverage, pytest"', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const NO_PYTHON = !hasPythonTooling();

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});

// The exploit: a repo-root coverage.py that fabricates a report. On `run` it just
// creates the data file; on `json` it writes a report marking app.py fully
// executed; on `--version` it looks like coverage so the probe passes.
const FORGED_COVERAGE_PY = [
  'import sys, json',
  'a = sys.argv[1:]',
  'def after(flag):',
  '    return a[a.index(flag) + 1] if flag in a else None',
  "if not a or a[0] == '--version':",
  "    print('Coverage.py, version 9.9.9')",
  '    sys.exit(0)',
  "if a[0] == 'run':",
  "    df = after('--data-file')",
  '    if df:',
  "        open(df, 'w').write('forged')",
  '    sys.exit(0)',
  "if a[0] == 'json':",
  "    out = after('-o')",
  "    payload = {'files': {'app.py': {'executed_lines': list(range(1, 100)), 'missing_lines': [], 'excluded_lines': []}}}",
  '    if out:',
  "        json.dump(payload, open(out, 'w'))",
  '    else:',
  '        json.dump(payload, sys.stdout)',
  '    sys.exit(0)',
  'sys.exit(0)',
  '',
].join('\n');

describe('a forged coverage.py cannot earn SAFE (GHSA A1)', () => {
  it.skipIf(NO_PYTHON)(
    'a hostile repo-root coverage.py cannot fabricate coverage for an untested change',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'a1-'));
      roots.push(root);
      // `used` is tested; the change lands inside `sneaky`, which no test calls,
      // so honest coverage leaves the changed line uncovered.
      await fs.writeFile(
        path.join(root, 'app.py'),
        'def used(x):\n    return x + 1\n\n\ndef sneaky(token):\n    return token == "expected"\n',
      );
      await fs.writeFile(path.join(root, 'coverage.py'), FORGED_COVERAGE_PY);
      await fs.mkdir(path.join(root, 'tests'));
      await fs.writeFile(
        path.join(root, 'tests', 'test_app.py'),
        'from app import used\n\n\ndef test_used():\n    assert used(1) == 2\n',
      );
      const diff = [
        '--- a/app.py',
        '+++ b/app.py',
        '@@ -5,2 +5,2 @@ def sneaky(token):',
        ' def sneaky(token):',
        '-    return token == "expected"',
        '+    return token == "expected" or token == "__backdoor__"',
        '',
      ].join('\n');
      const report = await verifyDiff({
        repoRoot: root,
        // trusted: the A1 launcher (not the untrusted trust gate) must be what
        // refuses the forge, so this pins the mechanism, not the blanket withhold.
        trusted: true,
        unifiedDiff: diff,
        testCmd: 'python3 -m pytest -q',
      });
      // The security invariant: coverage evidence must come from the real tool
      // measuring the real suite, not from a repo-local module. The changed line
      // is genuinely uncovered, so the verdict cannot be SAFE. (Red on main:
      // returns SAFE from the fabricated report.)
      expect(report.verdict).not.toBe('SAFE');
      // Pin the MECHANISM, not just the verdict string: the launcher ran the REAL
      // coverage (tool present) and honestly measured the changed line as
      // uncovered. Without these, a future launcher that silently measured NOTHING
      // (degrading to unknown → UNPROVEN) would also satisfy not.toBe('SAFE') while
      // the forge quietly won on any trusted run.
      expect(report.coverage.tool).toBe('coverage.py');
      expect(report.coverage.changedLinesCovered).toBe(false);
    },
    240_000,
  );

  it.skipIf(NO_PYTHON)(
    'the forge is still refused under PYTHONPATH=. (the documented shadow-bypass remedy)',
    async () => {
      // The load-bearing regression. Launching coverage by absolute package path
      // ALONE does not close this: `PYTHONPATH=.` puts the shadow ahead of
      // site-packages, so the driver's `import coverage` still resolves the
      // repo-local `coverage.py`. The fix must load coverage from real
      // site-packages FIRST. A future "simplification" back to the abs-path form
      // (or `-m coverage`) re-forges here.
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'a1pp-'));
      roots.push(root);
      await fs.writeFile(
        path.join(root, 'app.py'),
        'def used(x):\n    return x + 1\n\n\ndef sneaky(token):\n    return token == "expected"\n',
      );
      await fs.writeFile(path.join(root, 'coverage.py'), FORGED_COVERAGE_PY);
      await fs.mkdir(path.join(root, 'tests'));
      await fs.writeFile(
        path.join(root, 'tests', 'test_app.py'),
        'from app import used\n\n\ndef test_used():\n    assert used(1) == 2\n',
      );
      const diff = [
        '--- a/app.py',
        '+++ b/app.py',
        '@@ -5,2 +5,2 @@ def sneaky(token):',
        ' def sneaky(token):',
        '-    return token == "expected"',
        '+    return token == "expected" or token == "__backdoor__"',
        '',
      ].join('\n');
      const report = await verifyDiff({
        repoRoot: root,
        // trusted: pins the A1 launcher mechanism (see the plain case), not the gate.
        trusted: true,
        unifiedDiff: diff,
        testCmd: 'PYTHONPATH=. python3 -m pytest -q',
      });
      expect(report.verdict).not.toBe('SAFE');
      // Same mechanism pin as the plain case: real coverage ran and honestly
      // measured the changed line uncovered, so this proves the launcher, not a
      // silent measurement failure.
      expect(report.coverage.tool).toBe('coverage.py');
      expect(report.coverage.changedLinesCovered).toBe(false);
    },
    240_000,
  );

  it.skipIf(NO_PYTHON)(
    'an untrusted sitecustomize sys.modules forge does not earn SAFE (withheld by the trust gate)',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'a1sc-'));
      roots.push(root);
      await fs.writeFile(
        path.join(root, 'app.py'),
        'def used(x):\n    return x + 1\n\n\ndef sneaky(token):\n    return token == "expected"\n',
      );
      // sitecustomize runs at interpreter startup (site imports it off
      // PYTHONPATH=.), BEFORE the -c launcher, and pre-seeds sys.modules['coverage']
      // with a fake: sys.path.insert cannot dislodge an already-cached module. The
      // A1 launcher does NOT close this (proven: -S re-exposes stdlib shadowing;
      // purge is defeated by a meta_path finder). The mitigation is the trust gate
      // (ADR-19): for an untrusted diff the forgeable measurement is not trusted, so
      // the would-be-SAFE is withheld regardless of whether the tool was substituted.
      await fs.writeFile(
        path.join(root, 'sitecustomize.py'),
        [
          'import sys, types, json',
          'def _main():',
          '    a = sys.argv[1:]',
          '    def after(f): return a[a.index(f)+1] if f in a else None',
          "    if a and a[0] == 'run':",
          "        df = after('--data-file')",
          "        if df: open(df,'w').write('forged')",
          '        return 0',
          "    if a and a[0] == 'json':",
          "        out = after('-o')",
          "        p = {'files': {'app.py': {'executed_lines': list(range(1,100)), 'missing_lines': [], 'excluded_lines': []}}}",
          "        if out: json.dump(p, open(out,'w'))",
          '        return 0',
          '    return 0',
          "cov = types.ModuleType('coverage'); cmd = types.ModuleType('coverage.cmdline')",
          'cmd.main = _main; cov.cmdline = cmd',
          "sys.modules['coverage'] = cov; sys.modules['coverage.cmdline'] = cmd",
          '',
        ].join('\n'),
      );
      await fs.mkdir(path.join(root, 'tests'));
      await fs.writeFile(
        path.join(root, 'tests', 'test_app.py'),
        'from app import used\n\n\ndef test_used():\n    assert used(1) == 2\n',
      );
      const diff = [
        '--- a/app.py',
        '+++ b/app.py',
        '@@ -5,2 +5,2 @@ def sneaky(token):',
        ' def sneaky(token):',
        '-    return token == "expected"',
        '+    return token == "expected" or token == "__backdoor__"',
        '',
      ].join('\n');
      // Untrusted (default): the trust gate is the mitigation for this vector.
      const report = await verifyDiff({
        repoRoot: root,
        unifiedDiff: diff,
        testCmd: 'PYTHONPATH=. python3 -m pytest -q',
      });
      // Robust invariant: not SAFE. Where the sitecustomize forge lands (fabricated
      // coverage marks the line covered), prove the TRUST GATE withheld it; where it
      // fails to match coverage's file key (e.g. Windows), the coverage gap catches
      // it instead — still UNPROVEN, never SAFE.
      expect(report.verdict).toBe('UNPROVEN');
      if (report.coverage.changedLinesCovered === true) {
        expect(report.reason).toContain('SAFE is withheld');
      }
    },
    240_000,
  );
});
