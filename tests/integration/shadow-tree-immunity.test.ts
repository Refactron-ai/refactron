// tests/integration/shadow-tree-immunity.test.ts
//
// The product's headline guarantee, asserted end to end for the first time:
// "Your working tree is never touched."
//
// It was false in every published version from 0.1.0-beta.2 through 0.4.1.
// `copyTree` populated the shadow tree with HARDLINKS (`fs.link`), so every
// unchanged file shared an inode with the user's real file. The tests gate then
// executes code the diff supplied - a diff may edit conftest.py, a helper, or
// any test file - and any in-place write from that suite landed in the caller's
// repository. Reproduced: a diff naming ONLY tests/test_app.py rewrote app.py in
// the source tree, and the verdict was SAFE while it happened.
//
// This is the regression guard. It must fail loudly if anyone reintroduces a
// link-based copy, because nothing else in the suite covers it.
import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { verifyDiff } from '../../src/verify/verify-diff.js';
import { createShadowTree } from '../../src/verify/shadow-tree.js';
import { verificationBase } from '../../src/verify/private-base.js';

function pythonHasPytest(): boolean {
  try {
    execSync('python3 -c "import pytest"', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const NO_PYTEST = !pythonHasPytest();

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});

/** A repo whose suite writes to a file the diff never names. */
async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'immunity-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'pyproject.toml'), '[project]\nname = "imm"\n');
  await fs.writeFile(path.join(root, 'conftest.py'), '');
  await fs.writeFile(path.join(root, 'app.py'), 'VALUE = 0\n');
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'tests', 'test_app.py'),
    'from app import VALUE\n\n\ndef test_v():\n    assert VALUE == 0\n',
  );
  return root;
}

// Rewrites app.py in place, by absolute path, from inside the test run.
const WRITES_TO_UNCHANGED_FILE = [
  'import os',
  'from app import VALUE',
  '',
  '',
  'def test_v():',
  '    here = os.path.dirname(os.path.abspath(__file__))',
  '    p = os.path.join(os.path.dirname(here), "app.py")',
  '    with open(p, "w") as f:',
  '        f.write("VALUE = 999  # written by the suite\\n")',
  '    assert VALUE == 0',
  '',
].join('\n');

describe('the caller working tree is immune to the verified suite', () => {
  it.skipIf(NO_PYTEST)(
    'a suite that writes to an unchanged file cannot reach the source tree',
    async () => {
      const root = await fixture();
      const victim = path.join(root, 'app.py');
      const before = await fs.readFile(victim, 'utf8');

      const report = await verifyDiff({
        repoRoot: root,
        edits: [{ path: 'tests/test_app.py', newContent: WRITES_TO_UNCHANGED_FILE }],
        testCmd: 'python3 -m pytest -q',
      });

      const after = await fs.readFile(victim, 'utf8');
      // The verdict is not the point and is deliberately not asserted: whatever
      // it says, the caller's file must be untouched.
      expect(report.verdict).toBeDefined();
      expect(after).toBe(before);
      expect(after).not.toContain('written by the suite');
    },
    180_000,
  );

  it.skipIf(NO_PYTEST)(
    'a file the diff DID name is also untouched in the source tree',
    async () => {
      const root = await fixture();
      const changed = path.join(root, 'tests', 'test_app.py');
      const before = await fs.readFile(changed, 'utf8');
      await verifyDiff({
        repoRoot: root,
        edits: [{ path: 'tests/test_app.py', newContent: WRITES_TO_UNCHANGED_FILE }],
        testCmd: 'python3 -m pytest -q',
      });
      expect(await fs.readFile(changed, 'utf8')).toBe(before);
    },
    180_000,
  );
});

// SEC-2. The containment check was LEXICAL: `path.relative(...).startsWith('..')`.
// Plain `../` and absolute paths are correctly refused, and that is tested below.
// The bypass is a symlink: copyTree mirrors repo symlinks into the shadow tree
// BEFORE changes are written, including ones pointing outside the repo, so a
// FileChange under a mirrored escaping symlink passes the string test and the
// write follows the link out. Containment has to be resolved, not spelled.
describe('shadow-tree containment cannot be escaped', () => {
  it('refuses a path that escapes via a mirrored symlink', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'escape-src-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'escape-out-'));
    roots.push(root, outside);
    const victim = path.join(outside, 'victim.txt');
    await fs.writeFile(victim, 'ORIGINAL\n');
    await fs.writeFile(path.join(root, 'app.py'), 'x = 1\n');
    // A symlink inside the repo pointing out of it. Legal, and repos have them.
    await fs.symlink(outside, path.join(root, 'escape'), 'dir');

    // The property under test is CONTAINMENT, not which mechanism enforces it.
    // Refusing the change and containing the write are both acceptable; writing
    // through the link is not. Asserting `rejects` would pin the implementation
    // and fail on a correct fix.
    let handle: { path: string; cleanup: () => Promise<void> } | null = null;
    try {
      handle = await createShadowTree(root, [
        {
          path: path.join(root, 'escape', 'victim.txt'),
          oldHash: '',
          newContent: 'WRITTEN OUTSIDE THE SHADOW TREE\n',
          transformId: 'external-diff' as never,
        },
      ]);
    } catch {
      // Refusing outright is fine too.
    }

    // The only thing that matters: the file outside the repo is untouched.
    expect(await fs.readFile(victim, 'utf8')).toBe('ORIGINAL\n');

    if (handle) {
      // And if it was written at all, it landed inside the shadow tree.
      const inside = path.join(handle.path, 'escape', 'victim.txt');
      const real = await fs.realpath(path.dirname(inside)).catch(() => '');
      const destReal = await fs.realpath(handle.path);
      expect(real === destReal || real.startsWith(destReal + path.sep)).toBe(true);
      await handle.cleanup();
    }
  }, 60_000);

  it('still refuses the plain traversal and absolute forms', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'escape-plain-'));
    roots.push(root);
    await fs.writeFile(path.join(root, 'app.py'), 'x = 1\n');
    for (const p of [path.join(root, '..', 'evil.txt'), path.join(os.tmpdir(), 'evil.txt')]) {
      await expect(
        createShadowTree(root, [
          { path: p, oldHash: '', newContent: 'no', transformId: 'external-diff' as never },
        ]),
      ).rejects.toThrow();
    }
  }, 60_000);

  it('does not leak a populated shadow tree when containment throws', async () => {
    // createShadowTree mkdtemps and copies the WHOLE source before the check, so
    // a throw left a full copy of the user's code in the temp dir forever: no
    // handle is returned, so no caller can clean it up.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leak-src-'));
    roots.push(root);
    await fs.writeFile(path.join(root, 'secret.py'), 'SECRET = 1\n');
    const tmp = await verificationBase();
    const before = (await fs.readdir(tmp)).filter((n) => n.startsWith('refactron-shadow-')).length;
    await expect(
      createShadowTree(root, [
        {
          path: path.join(root, '..', 'evil.txt'),
          oldHash: '',
          newContent: 'no',
          transformId: 'external-diff' as never,
        },
      ]),
    ).rejects.toThrow();
    const after = (await fs.readdir(tmp)).filter((n) => n.startsWith('refactron-shadow-')).length;
    expect(after).toBe(before);
  }, 60_000);
});
