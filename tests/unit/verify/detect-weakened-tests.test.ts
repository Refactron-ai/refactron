// tests/unit/verify/detect-weakened-tests.test.ts
//
// The verify-diff intake layer for #163 (found in review, CodeRabbit on PR #166).
// detectWeakenedTests reads each changed test file's PRE-diff content from the base
// tree. The load-bearing property is that EVERY uncertainty fails SAFE-ward:
//   - a read failure that is NOT "file absent" must be treated as weakening, never
//     as "no weakening" — the latter would let a gutted test ride a trusted SAFE
//     (the cardinal false-SAFE sin);
//   - a path that escapes the repo must be refused before the read (no traversal /
//     content-disclosure oracle), and still recorded so the verdict degrades;
//   - a genuinely-absent base file (ENOENT) is a NEW test → strengthening → skipped.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectWeakenedTests } from '../../../src/verify/verify-diff.js';

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});
async function repo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weaken-intake-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'tests'));
  return root;
}

describe('detectWeakenedTests — fail-safe base-tree read (#163)', () => {
  it('records a non-ENOENT read error as weakening (must not read as SAFE)', async () => {
    const root = await repo();
    // A DIRECTORY where a test file is expected → readFile throws EISDIR. This is
    // the regression for the false-SAFE hole: `.catch(() => "")` used to swallow
    // this and skip the file, so a weakened test went unflagged.
    await fs.mkdir(path.join(root, 'tests', 'test_dir.py'));
    const out = await detectWeakenedTests(root, [
      { path: 'tests/test_dir.py', newContent: 'def test_x():\n    pass\n' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.file).toBe('tests/test_dir.py');
    expect(out[0]!.reasons.join(' ')).toMatch(/could not read pre-diff/i);
  });

  it('refuses an escaping edit path and records it, without reading outside', async () => {
    const root = await repo();
    const out = await detectWeakenedTests(root, [
      { path: '../test_escape.py', newContent: 'def test_x():\n    pass\n' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.reasons.join(' ')).toMatch(/escapes the repository/i);
  });

  it('treats a genuinely-absent base file (ENOENT) as a new test — not weakening', async () => {
    const root = await repo();
    const out = await detectWeakenedTests(root, [
      { path: 'tests/test_new.py', newContent: 'def test_x():\n    assert f() == 1\n' },
    ]);
    expect(out).toEqual([]);
  });

  it('delegates to the detector when the base file reads normally', async () => {
    const root = await repo();
    await fs.writeFile(
      path.join(root, 'tests', 'test_calc.py'),
      'def test_x():\n    assert f() == 1\n',
    );
    const out = await detectWeakenedTests(root, [
      { path: 'tests/test_calc.py', newContent: 'def test_x():\n    f()\n' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.reasons.join(' ')).toContain('assertion');
  });

  it('ignores non-test edits entirely', async () => {
    const root = await repo();
    const out = await detectWeakenedTests(root, [
      { path: 'src/module.py', newContent: 'def f():\n    return 2\n' },
    ]);
    expect(out).toEqual([]);
  });
});
