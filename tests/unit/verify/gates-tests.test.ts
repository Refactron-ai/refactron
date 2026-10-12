import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { testsGate, baselineFailReason } from '../../../src/verify/gates/tests.js';
import { createShadowTree } from '../../../src/verify/shadow-tree.js';
import { verificationBase } from '../../../src/verify/private-base.js';

// The suites here write a marker outside their copy, so each test gets its own
// verification base and temp dir rather than sharing the real ones.
const ISOLATED_KEYS = ['REFACTRON_VERIFY_BASE', 'TMPDIR'] as const;
const savedIsolated = Object.fromEntries(ISOLATED_KEYS.map((k) => [k, process.env[k]]));
let isolatedBase = '';
beforeEach(async () => {
  isolatedBase = await fs.mkdtemp(path.join(await verificationBase(), 'iso-'));
  for (const k of ISOLATED_KEYS) process.env[k] = isolatedBase;
});
afterEach(async () => {
  for (const k of ISOLATED_KEYS) {
    if (savedIsolated[k] === undefined) delete process.env[k];
    else process.env[k] = savedIsolated[k];
  }
  await fs.rm(isolatedBase, { recursive: true, force: true });
});

async function fixtureWithPassingTest(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-'));
  await fs.writeFile(
    path.join(root, 'pyproject.toml'),
    '[tool.pytest.ini_options]\ntestpaths = ["."]\npythonpath = ["."]\n',
  );
  await fs.writeFile(path.join(root, 'lib.py'), 'def x(): return 1\n');
  await fs.writeFile(
    path.join(root, 'test_lib.py'),
    'from lib import x\ndef test_ok(): assert x() == 1\n',
  );
  return root;
}

// A cross-tree deterministic flake. The marker lives OUTSIDE the shadow tree —
// in the system temp dir, at an absolute path the TEST injects via env — so it
// PERSISTS across shadow trees. First execution (any tree) finds it absent,
// creates it, and fails; every later execution finds it present and passes.
// Because the gate's retry now runs on a FRESH shadow, this models a real
// environment-dependent flake: the failure heals on a pristine tree, exactly
// what a timing/race flake does. The marker path is unique-per-run so reruns of
// our own suite stay deterministic, and the caller removes it in a finally.
function flakeMarkerPath(): string {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return path.join(os.tmpdir(), `refactron-flake-marker-${unique}`);
}
async function fixtureWithCrossTreeFlake(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-flaky-'));
  await fs.writeFile(
    path.join(root, 'pyproject.toml'),
    '[tool.pytest.ini_options]\ntestpaths = ["."]\npythonpath = ["."]\n',
  );
  await fs.writeFile(
    path.join(root, 'test_flaky.py'),
    [
      'import os',
      '',
      'def test_flaky():',
      '    marker = os.environ["REFACTRON_FLAKE_MARKER"]',
      '    if not os.path.exists(marker):',
      '        open(marker, "w").close()',
      '        raise AssertionError("flaky: first run fails until the shared marker exists")',
      '    assert True',
      '',
    ].join('\n'),
  );
  return root;
}

// An IDEMPOTENCY-BREAKING test (NOT a flake): the marker is cwd-relative, so it
// is written INSIDE the shadow tree. A first-run "heal" here is pure state
// leakage into the tree, indistinguishable from a real flake ONLY if the retry
// reuses the same mutated tree. On a FRESH shadow the marker is absent again, so
// the test fails twice and the gate must correctly refuse to excuse it as flaky.
async function fixtureWithIdempotencyBreak(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-idem-'));
  await fs.writeFile(
    path.join(root, 'pyproject.toml'),
    '[tool.pytest.ini_options]\ntestpaths = ["."]\npythonpath = ["."]\n',
  );
  await fs.writeFile(
    path.join(root, 'test_idempotent.py'),
    [
      'import os',
      '',
      'def test_idempotent():',
      '    marker = os.path.join(os.getcwd(), ".idem_marker")',
      '    if not os.path.exists(marker):',
      '        open(marker, "w").close()',
      '        raise AssertionError("not idempotent: first run in this tree fails")',
      '    assert True',
      '',
    ].join('\n'),
  );
  return root;
}

describe('testsGate', () => {
  it('passes when shadow tree tests pass', async () => {
    const root = await fixtureWithPassingTest();
    const h = await createShadowTree(root, []);
    const r = await testsGate({ shadowRoot: h.path, changes: [] }, root, {});
    await h.cleanup();
    expect(r.passed).toBe(true);
  }, 60_000);

  it('fails when a change breaks behavior', async () => {
    const root = await fixtureWithPassingTest();
    const change = {
      path: path.join(root, 'lib.py'),
      oldHash: 'x',
      newContent: 'def x(): return 2\n',
      transformId: 'format_to_fstring' as const,
    };
    const h = await createShadowTree(root, [change]);
    const r = await testsGate({ shadowRoot: h.path, changes: [change] }, root, {});
    await h.cleanup();
    expect(r.passed).toBe(false);
    expect(r.blockingReason).toBeTruthy();
  }, 60_000);

  it('aborts with a clear message if baseline already fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-bf-'));
    await fs.writeFile(
      path.join(root, 'pyproject.toml'),
      '[tool.pytest.ini_options]\ntestpaths = ["."]\npythonpath = ["."]\n',
    );
    await fs.writeFile(path.join(root, 'test_x.py'), 'def test_fail(): assert False\n');
    const h = await createShadowTree(root, []);
    const r = await testsGate({ shadowRoot: h.path, changes: [] }, root, {});
    await h.cleanup();
    expect(r.passed).toBe(false);
    expect(r.blockingReason).toMatch(/baseline/i);
  }, 60_000);

  it('preserves the baseline-fail marker even with large output (no tail truncation of prefix)', () => {
    const reason = baselineFailReason('x'.repeat(10000), 'x'.repeat(10000));
    expect(reason).toContain('baseline tests already fail');
  });

  // (a) A new failure that vanishes when a FRESH shadow is rerun is flaky, not a
  // regression. The gate must pass and surface the id as a flaky suspect. The
  // marker persists in the system temp dir, so the fresh-tree retry heals.
  it('treats a cross-tree flake (heals on a fresh shadow) as flaky (id surfaced)', async () => {
    const root = await fixtureWithCrossTreeFlake();
    const marker = flakeMarkerPath();
    process.env.REFACTRON_FLAKE_MARKER = marker;
    const h = await createShadowTree(root, []);
    try {
      // skipBaseline isolates the delta+retry path: a genuinely flaky test would
      // otherwise heal (and be consumed) during the retried baseline run.
      const r = await testsGate({ shadowRoot: h.path, changes: [] }, root, { skipBaseline: true });
      expect(r.passed).toBe(true);
      expect(r.flakySuspects).toContain('test_flaky.py::test_flaky');
    } finally {
      await h.cleanup();
      await fs.rm(marker, { force: true });
      delete process.env.REFACTRON_FLAKE_MARKER;
    }
  }, 60_000);

  // (c) An idempotency break (first-run state leaked INTO the tree) must NOT be
  // excused as flaky. Under the FRESH-shadow retry the mutated state is gone, so
  // the test fails twice: the gate fails with the failing tail and no suspects.
  // This is RED under the old same-shadow retry (which reuses the mutated tree,
  // sees the marker, and wrongly heals) and GREEN once the retry runs fresh.
  it('does NOT excuse an idempotency break (cwd-marker heal) as flaky', async () => {
    const root = await fixtureWithIdempotencyBreak();
    const h = await createShadowTree(root, []);
    try {
      const r = await testsGate({ shadowRoot: h.path, changes: [] }, root, { skipBaseline: true });
      expect(r.passed).toBe(false);
      expect(r.blockingReason).toMatch(/tests fail after refactoring/);
      expect(r.flakySuspects ?? []).toEqual([]);
    } finally {
      await h.cleanup();
    }
  }, 60_000);

  // (b) A new failure that persists on retry is a genuine regression: the gate
  // must still fail, still surface the failing tail, and never flag it flaky.
  it('fails when a new failure persists on retry (genuine regression, not flaky)', async () => {
    const root = await fixtureWithPassingTest();
    const change = {
      path: path.join(root, 'lib.py'),
      oldHash: 'x',
      newContent: 'def x(): return 2\n',
      transformId: 'format_to_fstring' as const,
    };
    const h = await createShadowTree(root, [change]);
    const r = await testsGate({ shadowRoot: h.path, changes: [change] }, root, {});
    await h.cleanup();
    expect(r.passed).toBe(false);
    expect(r.blockingReason).toMatch(/tests fail after refactoring/);
    expect(r.flakySuspects ?? []).toEqual([]);
  }, 60_000);

  // (d) When a non-zero run yields output we cannot parse into a failure set, we
  // must NOT get lenient: behave exactly as today (any failure fails the gate).
  it('falls back to a plain failure when the runner output is unparseable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-unparseable-'));
    await fs.writeFile(path.join(root, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
    const h = await createShadowTree(root, []);
    const r = await testsGate({ shadowRoot: h.path, changes: [] }, root, {
      skipBaseline: true,
      testCmd: 'echo boom-unparseable-no-failed-lines; exit 1',
    });
    await h.cleanup();
    expect(r.passed).toBe(false);
    expect(r.blockingReason).toBeTruthy();
    expect(r.flakySuspects ?? []).toEqual([]);
  }, 60_000);
});
