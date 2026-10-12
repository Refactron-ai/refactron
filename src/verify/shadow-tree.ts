import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import type { FileChange } from '../contracts.js';
import type { ShadowTreeHandle } from './types.js';
import { CopyFailedError, mkdtempPrivate } from './private-base.js';

// Dirs we never copy/walk into the shadow tree. Build outputs, caches, and
// VCS state are pure noise. Source dirs to mutate are NOT here.
const SKIP_DIRS = new Set([
  '.git',
  'dist',
  'build',
  '__pycache__',
  '.pytest_cache',
  '.refactron',
  'coverage',
  '.next',
  '.cache',
]);

// Dirs we symlink rather than copy/hardlink. These contain installed
// dependencies the test runner needs — copying them is wasteful (hundreds of
// MB) and hardlinking them is fragile (npm/pip frequently mutate state inside).
// A symlink gives the shadow tree's test command everything it needs while
// keeping the dest dir cheap.
const SYMLINK_DIRS = new Set(['node_modules', '.venv', 'venv']);

export async function createShadowTree(
  sourceRoot: string,
  changes: FileChange[],
): Promise<ShadowTreeHandle> {
  const dest = await mkdtempPrivate('refactron-shadow-');
  // Everything after mkdtemp must clean up on the way out. The copy below runs
  // BEFORE the containment check, so a rejected change used to leave a full
  // copy of the caller's source in the temp dir forever: no handle is returned
  // on the throw path, so no caller has anything to clean.
  try {
    const changedPaths = new Set(changes.map((c) => path.resolve(c.path)));

    // A copy that cannot be completed (ENOSPC, an unreadable file) is a
    // verification that never ran, not a broken change.
    await copyTree(sourceRoot, dest, changedPaths).catch((err: unknown) => {
      throw new CopyFailedError(err);
    });

    // Containment is RESOLVED, not spelled. `path.relative(...).startsWith('..')`
    // catches `../` and absolute paths - both still refused, both still tested -
    // but not a symlink: copyTree mirrors repo symlinks into the shadow tree,
    // including ones pointing outside the repo, so a write under a mirrored
    // escaping link passed the string test and followed the link out of the
    // tree. Resolving the parent with realpath is the only check that holds.
    const destReal = await fs.realpath(dest);
    for (const change of changes) {
      const rel = path.relative(sourceRoot, change.path);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`FileChange path escapes source root: ${change.path}`);
      }
      const target = path.join(dest, rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const parentReal = await fs.realpath(path.dirname(target));
      if (parentReal !== destReal && !parentReal.startsWith(destReal + path.sep)) {
        throw new Error(`FileChange path escapes the shadow tree: ${change.path}`);
      }
      await fs.writeFile(target, change.newContent, 'utf8').catch((err: unknown) => {
        throw new CopyFailedError(err);
      });
    }
  } catch (err) {
    await fs.rm(dest, { recursive: true, force: true });
    throw err;
  }

  return {
    path: dest,
    cleanup: () => fs.rm(dest, { recursive: true, force: true }),
  };
}

async function copyTree(
  src: string,
  dest: string,
  skipChanged: Set<string>,
  rootReal?: string,
): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  // Resolved once at the top level and threaded down, so a nested directory
  // compares against the REPO root rather than against itself.
  const root = rootReal ?? (await fs.realpath(src));
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (SYMLINK_DIRS.has(entry.name)) {
        // Symlink installed-dependency dirs (node_modules, .venv, venv). The
        // test gate's runner (vitest, jest, pytest) needs these to be reachable;
        // hardlinking thousands of files is wasteful and breaks npm bin symlinks.
        // CRITICAL: use the absolute path as the symlink target. A relative target
        // would resolve from the symlink's parent (the shadow tree) and loop back
        // to itself (ELOOP).
        const absoluteTarget = path.resolve(s);
        try {
          await fs.symlink(absoluteTarget, d, 'dir');
        } catch {
          // Fall back to recursive copy if the platform/FS rejects symlinks
          // (e.g. Windows without developer mode). Rare; degrades gracefully.
          await copyTree(s, d, skipChanged, root);
        }
        continue;
      }
      await copyTree(s, d, skipChanged, root);
    } else if (entry.isFile()) {
      if (skipChanged.has(path.resolve(s))) continue;
      // COPY, never hardlink. A hardlink shares the inode with the caller's real
      // file, and the tests gate executes code the DIFF supplied - a diff may
      // edit conftest.py, a fixture, or any test file. Any in-place write from
      // that suite then lands in the user's repository, silently, while the
      // verdict says SAFE. Reproduced: a diff naming only tests/test_app.py
      // rewrote app.py in the source tree. It also fires by accident, on any
      // suite with a snapshot updater or a test that writes a fixture.
      //
      // COPYFILE_FICLONE asks for a copy-on-write clone, so on APFS, Btrfs and
      // XFS this keeps the speed a hardlink was chosen for while giving each
      // tree its own inode on first write. On filesystems without reflink
      // support the flag is ignored and this degrades to a normal copy.
      await fs.copyFile(s, d, fsConstants.COPYFILE_FICLONE);
    } else if (entry.isSymbolicLink()) {
      // Mirror the symlink, but NEVER one that resolves outside the source root.
      // Such a link is a hole straight out of the shadow tree: any write beneath
      // it lands in the real filesystem. A dangling or repo-internal link is
      // fine and is still mirrored.
      try {
        const linkTarget = await fs.readlink(s);
        const resolved = path.resolve(path.dirname(s), linkTarget);
        const rel = path.relative(root, resolved);
        if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
        await fs.symlink(linkTarget, d);
      } catch {
        // Ignore — symlinks that can't be replicated aren't worth blocking on.
      }
    }
  }
}
