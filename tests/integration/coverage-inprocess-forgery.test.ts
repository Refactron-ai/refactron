// tests/integration/coverage-inprocess-forgery.test.ts
//
// Security red-team reproduction (TARGET 2, "Finding 1"). pytest imports
// conftest.py IN THE SAME PROCESS as the running coverage collector, after
// tracing has started. A ~6-line conftest using only public coverage API
// (Coverage.current() + CoverageData.add_arcs) forges execution of a
// never-called changed line, so an untested backdoor earns SAFE. No sitecustomize,
// no PYTHONPATH shadow, no coverage-tool substitution: the attacker owns the
// process the real tool runs in. Launcher hardening (A1) does NOT touch this.
//
// The forge was a LIVE false SAFE in 0.3.1-0.4.5, and it still succeeds at the
// coverage level (no launcher can stop in-process tampering). What closes it is
// the trust-mode gate (ADR-19): for an untrusted diff the forgeable measurement
// is not trusted, so the would-be-SAFE is WITHHELD to UNPROVEN. This test is GREEN
// on this branch (the gate floors it) and RED on main (which returns SAFE) — it is
// the regression guard that no future change reopens the withhold.
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

// The whole forge: at session finish, reach the running coverage instance and
// inject arcs claiming pkg/auth.py:6 executed. --branch means add_arcs (add_lines
// raises on branch data). A no-op when no coverage instance is current, so the
// plain tests-gate run is unaffected.
const FORGE_CONFTEST = [
  'def pytest_sessionfinish(session, exitstatus):',
  '    try:',
  '        import coverage, os',
  '        cov = coverage.Coverage.current()',
  '        if cov is None:',
  '            return',
  '        data = cov.get_data()',
  '        target = os.path.join(os.getcwd(), "pkg", "auth.py")',
  '        data.add_arcs({target: {(-5, 6), (6, -5)}})',
  '    except Exception:',
  '        pass',
  '',
].join('\n');

describe('an in-process conftest.py cannot forge coverage into SAFE (red-team Finding 1)', () => {
  it.skipIf(NO_PYTHON)(
    'a conftest that injects arcs for a never-called changed line must not earn SAFE',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inproc-'));
      roots.push(root);
      await fs.mkdir(path.join(root, 'pkg'));
      await fs.writeFile(path.join(root, 'pkg', '__init__.py'), '');
      await fs.writeFile(
        path.join(root, 'pkg', 'auth.py'),
        'def login(user, pw):\n    return user == "admin"\n',
      );
      await fs.writeFile(path.join(root, 'conftest.py'), FORGE_CONFTEST);
      await fs.mkdir(path.join(root, 'tests'));
      await fs.writeFile(
        path.join(root, 'tests', 'test_auth.py'),
        'from pkg.auth import login\n\n\ndef test_login():\n    assert login("admin", "x") is True\n',
      );
      // The change lands in is_backdoor, which no test calls; line 6 is genuinely
      // uncovered. Only the conftest forge marks it executed.
      const diff = [
        '--- a/pkg/auth.py',
        '+++ b/pkg/auth.py',
        '@@ -1,2 +1,6 @@',
        ' def login(user, pw):',
        '     return user == "admin"',
        '+',
        '+',
        '+def is_backdoor(token):',
        '+    return token == "__backdoor__"',
        '',
      ].join('\n');
      const report = await verifyDiff({
        repoRoot: root,
        unifiedDiff: diff,
        testCmd: 'PYTHONPATH=. python3 -m pytest -q',
      });
      // Security invariant, robust across platforms: the forge cannot earn SAFE.
      expect(report.verdict).toBe('UNPROVEN');
      // Where the forge actually LANDS (coverage reports the changed line covered),
      // prove it was the TRUST GATE (ADR-19) that withheld the would-be-SAFE. On a
      // platform where the forge fails to match coverage's internal file key (e.g.
      // Windows path handling), coverage's own gap catches the untested line
      // instead — still UNPROVEN, never SAFE, but via a different reason.
      if (report.coverage.changedLinesCovered === true) {
        expect(report.reason).toContain('SAFE is withheld');
      }
    },
    240_000,
  );
});
