// A verification copy that cannot be made, at any point in a run, ends the
// verdict UNPROVEN with no coverage claimed. It never reads UNSAFE and never
// throws out of verifyDiff.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as PrivateBase from '../../src/verify/private-base.js';
import { verifyDiff } from '../../src/verify/verify-diff.js';
import type { VerdictReport } from '../../src/verify/verdict-fuse.js';

const fail = vi.hoisted(() => ({ prefix: '', nth: 0, seen: new Map<string, number>() }));

vi.mock('../../src/verify/private-base.js', async (importOriginal) => {
  const real = await importOriginal<typeof PrivateBase>();
  return {
    ...real,
    mkdtempPrivate: async (prefix: string): Promise<string> => {
      const n = (fail.seen.get(prefix) ?? 0) + 1;
      fail.seen.set(prefix, n);
      if (prefix === fail.prefix && n === fail.nth) throw new real.PrivateBaseError('test');
      return real.mkdtempPrivate(prefix);
    },
  };
});

function hasPythonTooling(): boolean {
  try {
    execSync('python3 -c "import coverage, pytest"', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const NO_PYTHON = !hasPythonTooling() || process.platform === 'win32';

const dirs: string[] = [];
afterEach(async () => {
  fail.prefix = '';
  fail.nth = 0;
  fail.seen.clear();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

const SAFE_DIFF = [
  '--- a/calc.py',
  '+++ b/calc.py',
  '@@ -1,2 +1,2 @@',
  ' def add(a, b):',
  '-    return a + b',
  '+    return b + a',
  '',
].join('\n');
const BREAKING_DIFF = SAFE_DIFF.replace('+    return b + a', '+    return a - b');

async function repo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copy-fail-'));
  dirs.push(root);
  await fs.writeFile(path.join(root, 'calc.py'), 'def add(a, b):\n    return a + b\n');
  await fs.writeFile(
    path.join(root, 'test_calc.py'),
    'from calc import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n',
  );
  return root;
}

async function verifyWithFailure(
  prefix: string,
  nth: number,
  diff: string,
  extra: { flakyCheck?: boolean } = {},
): Promise<VerdictReport> {
  const repoRoot = await repo();
  fail.prefix = prefix;
  fail.nth = nth;
  return verifyDiff({
    repoRoot,
    trusted: true,
    unifiedDiff: diff,
    testCmd: 'python3 -m pytest -q',
    ...extra,
  });
}

function expectUnprovenWithoutCoverage(r: VerdictReport): void {
  expect(r.verdict).toBe('UNPROVEN');
  expect(r.coverage.tool).toBe('none');
  expect(r.coverage.changedLinesCovered).toBe('unknown');
}

describe('a copy that cannot be made ends UNPROVEN', () => {
  it.skipIf(NO_PYTHON)(
    'control: the same run with every copy made is SAFE',
    async () => {
      const r = await verifyWithFailure('', 0, SAFE_DIFF);
      expect(r.verdict).toBe('SAFE');
    },
    120_000,
  );

  it.skipIf(NO_PYTHON)(
    'the copy under verification',
    async () => {
      const r = await verifyWithFailure('refactron-shadow-', 1, SAFE_DIFF);
      expectUnprovenWithoutCoverage(r);
      expect(r.testScope.scope).toBe('unknown');
      expect(r.reason).toMatch(/^could not create a private directory for the verification copy/);
      for (const gate of ['syntax', 'imports'] as const) {
        expect(r.gates[gate].blockingReason).toBe(
          'not run: the verification copy could not be created',
        );
      }
    },
    120_000,
  );

  it.skipIf(NO_PYTHON)(
    'the baseline copy',
    async () => {
      const r = await verifyWithFailure('refactron-shadow-', 2, SAFE_DIFF);
      expectUnprovenWithoutCoverage(r);
      expect(r.testScope.scope).toBe('unknown');
      expect(r.reason).toMatch(/^could not create a private directory for the verification copy/);
    },
    120_000,
  );

  it.skipIf(NO_PYTHON)(
    'the fresh copy for the retry of a failing run',
    async () => {
      const r = await verifyWithFailure('refactron-shadow-', 3, BREAKING_DIFF);
      expectUnprovenWithoutCoverage(r);
      expect(r.testScope.scope).toBe('unknown');
      expect(r.reason).toMatch(/^could not create a private directory for the verification copy/);
    },
    120_000,
  );

  it.skipIf(NO_PYTHON)(
    'the coverage copy',
    async () => {
      const r = await verifyWithFailure('refactron-shadow-', 3, SAFE_DIFF);
      expectUnprovenWithoutCoverage(r);
      expect(r.coverage.unknownReason).toMatch(/private directory for the verification copy/);
    },
    120_000,
  );

  it.skipIf(NO_PYTHON)(
    'the coverage probe directory',
    async () => {
      const r = await verifyWithFailure('refactron-cov-probe-', 1, SAFE_DIFF);
      expectUnprovenWithoutCoverage(r);
      expect(r.coverage.unknownReason).toMatch(/private directory for the verification copy/);
    },
    120_000,
  );

  it.skipIf(NO_PYTHON)(
    'the coverage data directory',
    async () => {
      const r = await verifyWithFailure('refactron-cov-', 1, SAFE_DIFF);
      expectUnprovenWithoutCoverage(r);
      expect(r.coverage.unknownReason).toMatch(/private directory for the verification copy/);
    },
    120_000,
  );

  it.skipIf(NO_PYTHON)(
    'a stability rerun copy counts as inconclusive',
    async () => {
      const r = await verifyWithFailure('refactron-shadow-', 4, SAFE_DIFF, { flakyCheck: true });
      expect(r.stability?.inconclusive).toBe(1);
      expect(r.stability?.varied).toEqual([]);
    },
    180_000,
  );

  it.skipIf(NO_PYTHON || process.getuid?.() === 0)(
    'a copy that fails partway (an unreadable file)',
    async () => {
      const repoRoot = await repo();
      const locked = path.join(repoRoot, 'locked.txt');
      await fs.writeFile(locked, 'x');
      await fs.chmod(locked, 0o000);
      try {
        const r = await verifyDiff({
          repoRoot,
          trusted: true,
          unifiedDiff: SAFE_DIFF,
          testCmd: 'python3 -m pytest -q',
        });
        expectUnprovenWithoutCoverage(r);
        expect(r.reason).toMatch(/^could not create the verification copy \(EACCES\)/);
      } finally {
        await fs.chmod(locked, 0o600);
      }
    },
    120_000,
  );
});
