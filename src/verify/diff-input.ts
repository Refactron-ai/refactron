// src/verify/diff-input.ts
// Turn a change (given as {path,newContent}[] or a unified/git diff) into the
// FileEdit[] the verify pipeline consumes, and derive which new-file lines
// changed (for coverage fusion). Uses the `diff` package — no hand-rolled hunks.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { applyPatch, parsePatch, structuredPatch, type ParsedDiff } from 'diff';

export interface FileEdit {
  path: string; // repo-relative
  newContent: string; // full file content
}

export interface ChangedRange {
  path: string;
  lines: number[]; // 1-indexed new-file line numbers that were added/changed
}

export class DiffApplyError extends Error {}

type Hunk = ParsedDiff['hunks'][number];

// A git submodule pointer bump renders as a hunk whose content lines are exactly
// `Subproject commit <sha>` (with the unified-diff +/-/space prefix). Requiring
// the hex sha after the literal keeps prose that merely mentions the phrase
// (e.g. a markdown line `+Subproject commit is a gitlink`) from false-matching.
// BUT the phrase alone is NOT proof: a docs file editing `+Subproject commit
// deadbeef...` produces this exact line too (I1). The load-bearing signal is the
// gitlink mode 160000 on the enclosing entry (see GITLINK_MODE_RE) — only when
// that has been seen do we trust a Subproject line as a real pointer change.
const SUBPROJECT_RE = /^[-+ ]Subproject commit [0-9a-f]{7,40}(-dirty)?$/;

// A gitlink (submodule) entry always carries mode 160000 on one of its git
// metadata lines: `index <a>..<b> 160000` for a pointer bump, `new file mode
// 160000` for an add, or `deleted file mode 160000` for a removal. These
// metadata lines have no +/-/space prefix, so a diff's CONTENT can never forge
// one — which is exactly why the mode, not the `Subproject commit` content, is
// the trustworthy submodule signal.
const GITLINK_MODE_RE =
  /^index [0-9a-f]+\.\.[0-9a-f]+ 160000$|^(?:new file |deleted file |old |new )?mode 160000$/;

/** Strip a leading `a/` or `b/` git prefix. */
function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, '');
}

/** True when a diff-supplied path stays inside the repository.
 *
 *  The path here comes from the diff's own `---`/`+++` headers, which are
 *  attacker-controlled in every deployment this tool is built for: a contributor's
 *  pull request, an agent's proposed change. Without this check
 *  `readUtf8Base` opened whatever the header named, so a diff could read
 *  `../../.ssh/id_rsa`.
 *
 *  The shadow tree blocks the resulting WRITE, but by then the read has already
 *  happened - and whether the patch applies is an oracle, since context lines
 *  only match when the attacker already guessed the contents. Containment has to
 *  be enforced at intake, not only at the write. */
function isInsideRepo(rel: string): boolean {
  if (rel === '') return false;
  if (path.isAbsolute(rel)) return false;
  const normalized = path.normalize(rel);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) return false;
  // Windows-style separators survive normalize() on POSIX, so check both forms.
  return !normalized.startsWith('../');
}

/** Lexical containment is necessary but NOT sufficient: `fs.readFile` follows
 *  symlinks, so a link planted in the repository (`repo/link -> /etc`) makes
 *  `link/passwd` pass `isInsideRepo` and still read outside. In the deployment
 *  this product is sold for - a CI gate checking out an untrusted pull request
 *  - the attacker controls the tree, so planting that link is part of the diff
 *  they are asking us to verify.
 *
 *  Reproduced before this existed, as a content-disclosure ORACLE rather than a
 *  theoretical read: with `repo/link` pointing at a secrets directory, a diff
 *  whose removal line GUESSED the file's contents was accepted, while a wrong
 *  guess reported "diff did not apply". The difference between those two
 *  messages leaks the file one guess at a time.
 *
 *  Resolves the deepest ancestor that actually exists, because a file the diff
 *  CREATES has no realpath of its own while every directory it would be created
 *  through does - and an escaping directory is the whole attack.
 *
 *  Exported so the direct-`edits` intake (verify-diff.ts, #163 pre-diff test
 *  read) can enforce the SAME symlink-aware boundary the unified-diff intake
 *  does, rather than reading an attacker-shaped path with a lexical check only. */
export async function resolvesInsideRepo(repoRoot: string, rel: string): Promise<boolean> {
  let root: string;
  try {
    root = await fs.realpath(repoRoot);
  } catch {
    return false; // boundary cannot be established -> refuse rather than guess
  }
  let candidate = path.resolve(root, rel);
  for (;;) {
    try {
      const real = await fs.realpath(candidate);
      return real === root || real.startsWith(root + path.sep);
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return false; // walked past the filesystem root
      candidate = parent;
    }
  }
}

// v1 verify models CONTENT edits only. Deletions, renames, and binary changes
// are not verifiable through the shadow-tree + coverage pipeline, so they must
// be REJECTED loudly rather than silently dropped: a diff that deletes a module
// yet also makes one benign edit once verified SAFE while `git apply` of the
// same diff ImportError'd the whole package. Full deletion/rename support is a
// later feature; until then honesty beats a partial verdict.
//
// Detection is belt-and-braces on purpose. parsePatch models a deletion as
// newFileName `/dev/null` and a content-carrying rename as old !== new, but it
// DROPS a pure 100%-similarity rename (no hunks) and can elide metadata-only
// entries entirely. So we also raw-scan the diff text for the git headers
// `deleted file mode`, `rename from `/`rename to `, and the binary markers —
// either source firing is enough to refuse.

interface RawDiffSignals {
  deletions: string[]; // repo-relative paths of deleted files
  renames: Array<{ from: string; to: string }>;
  copies: Array<{ from: string; to: string }>;
  submodules: string[]; // repo-relative paths of bumped git submodules
  hasBinary: boolean;
}

function scanRawDiff(diffStr: string): RawDiffSignals {
  const deletions: string[] = [];
  const renames: Array<{ from: string; to: string }> = [];
  const copies: Array<{ from: string; to: string }> = [];
  const submodules: string[] = [];
  let hasBinary = false;
  let headerOldPath: string | null = null;
  let pendingRenameFrom: string | null = null;
  let pendingCopyFrom: string | null = null;
  // Whether the current `diff --git` entry has declared gitlink mode 160000.
  // A `Subproject commit` content line is only trusted as a real submodule
  // pointer change once this is set — otherwise it is ordinary file content.
  let sawGitlinkMode = false;

  for (const line of diffStr.split('\n')) {
    // git quotes header paths containing spaces/tabs/non-ASCII; match both forms.
    const gitHeader =
      /^diff --git a\/(.+?) b\/(.+)$/.exec(line) ?? /^diff --git "a\/(.+?)" "b\/(.+)"$/.exec(line);
    if (gitHeader) {
      headerOldPath = gitHeader[1] ?? null;
      pendingRenameFrom = null;
      pendingCopyFrom = null;
      sawGitlinkMode = false;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      // The marker alone is proof of a deletion. Never gate the refusal on
      // having parsed the header path: an EMPTY-file deletion has no hunks and
      // no `+++ /dev/null`, so this line may be the only signal there is.
      deletions.push(headerOldPath ?? '(path unresolved)');
      continue;
    }
    const renameFrom = /^rename from (.+)$/.exec(line);
    if (renameFrom) {
      pendingRenameFrom = renameFrom[1] ?? null;
      continue;
    }
    const renameTo = /^rename to (.+)$/.exec(line);
    if (renameTo && pendingRenameFrom) {
      renames.push({ from: pendingRenameFrom, to: renameTo[1] ?? '' });
      pendingRenameFrom = null;
      continue;
    }
    const copyFrom = /^copy from (.+)$/.exec(line);
    if (copyFrom) {
      pendingCopyFrom = copyFrom[1] ?? null;
      continue;
    }
    const copyTo = /^copy to (.+)$/.exec(line);
    if (copyTo && pendingCopyFrom) {
      copies.push({ from: pendingCopyFrom, to: copyTo[1] ?? '' });
      pendingCopyFrom = null;
      continue;
    }
    if (GITLINK_MODE_RE.test(line)) {
      // The enclosing entry is a gitlink (submodule). This mode line precedes the
      // `Subproject commit` content, so the flag is already set by the time we
      // reach it below.
      sawGitlinkMode = true;
      continue;
    }
    if (sawGitlinkMode && SUBPROJECT_RE.test(line)) {
      // A `Subproject commit` line is only a real pointer change once we have
      // seen the 160000 gitlink mode; otherwise it is ordinary content (I1). The
      // submodule's path lives in the enclosing `diff --git` header (headerOldPath).
      submodules.push(headerOldPath ?? '(path unresolved)');
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      hasBinary = true;
    }
  }
  return { deletions, renames, copies, submodules, hasBinary };
}

/** The deleted path if this diff deletes a file (parsePatch or raw), else null. */
function findDeletion(patches: ParsedDiff[], raw: RawDiffSignals): string | null {
  for (const p of patches) {
    const oldRel = stripPrefix(p.oldFileName ?? '');
    const newRel = stripPrefix(p.newFileName ?? '');
    if (newRel === '/dev/null' && oldRel && oldRel !== '/dev/null') return oldRel;
  }
  return raw.deletions[0] ?? null;
}

/** The {from,to} if this diff renames a file (parsePatch or raw), else null. */
function findRename(
  patches: ParsedDiff[],
  raw: RawDiffSignals,
): { from: string; to: string } | null {
  for (const p of patches) {
    const oldRel = stripPrefix(p.oldFileName ?? '');
    const newRel = stripPrefix(p.newFileName ?? '');
    if (oldRel && newRel && oldRel !== '/dev/null' && newRel !== '/dev/null' && oldRel !== newRel) {
      return { from: oldRel, to: newRel };
    }
  }
  return raw.renames[0] ?? null;
}

/** The submodule path if this diff bumps a git submodule pointer, else null.
 *  Sourced ONLY from the raw scan, which pairs a `Subproject commit` content line
 *  with the enclosing entry's 160000 gitlink mode. The former parsePatch-hunk
 *  fallback was dropped: a parsed hunk cannot see the mode, so it false-rejected
 *  any content line reading `Subproject commit <hex>` (e.g. a docs edit, I1). */
function findSubmodule(raw: RawDiffSignals): string | null {
  return raw.submodules[0] ?? null;
}

/** A hunk with neither a context line nor a deletion has nothing to match
 *  against the base: applyPatch inserts it at the header's line number even when
 *  the base has drifted, silently fabricating content with no error. Such hunks
 *  are only legitimate when creating a brand-new file (handled by the caller). */
function isAnchorlessHunk(hunk: Hunk): boolean {
  let hasContext = false;
  let hasDeletion = false;
  for (const l of hunk.lines) {
    if (l.startsWith(' ')) hasContext = true;
    else if (l.startsWith('-')) hasDeletion = true;
    // '+' insertions and '\ No newline' markers do not anchor to the base.
  }
  return !hasContext && !hasDeletion;
}

/** Read a repo file as a UTF-8 string, or null if it is absent (a new file).
 *  A single fatal TextDecoder pass rejects byte sequences that are not valid
 *  UTF-8 (e.g. a lone latin-1 0xE9): decoding those non-fatally would substitute
 *  U+FFFD replacement characters that never round-trip, so writing the "base"
 *  into the shadow would corrupt the unchanged bytes.
 *
 *  Scope, stated honestly: this gate only catches INVALID UTF-8 bytes. Content
 *  that is byte-valid UTF-8 yet is really another encoding — e.g. UTF-16 that is
 *  all ASCII+NUL — passes here and instead fails loudly downstream when
 *  applyPatch cannot match its hunks. `ignoreBOM` keeps a leading BOM in the
 *  string so the returned base still round-trips byte-for-byte. */
async function readUtf8Base(repoRoot: string, rel: string): Promise<string | null> {
  // Refuse before touching the filesystem. Returning null here makes the diff
  // look like it targets a file that does not exist, which the caller already
  // handles, so an escaping path is rejected on the same well-trodden path as a
  // stale one rather than through a new error branch.
  if (!isInsideRepo(rel)) return null;
  // Second gate, and the one that survives a symlink. Same `null` return as
  // above, so an escaping path is refused on the well-trodden "absent base"
  // branch rather than through a new error path.
  if (!(await resolvesInsideRepo(repoRoot, rel))) return null;
  let buf: Buffer;
  try {
    buf = await fs.readFile(path.join(repoRoot, rel));
  } catch {
    return null; // absent → new file
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    throw new DiffApplyError(
      `base file ${rel} is not valid UTF-8; only UTF-8 sources are supported yet`,
    );
  }
}

/** Normalize CRLF to LF for line comparison. A CRLF base (Windows autocrlf
 *  checkout) diffed against an LF-authored edit — or vice versa — must not
 *  read as every-line-changed: that inflates the changed-line set into
 *  covered territory, and an uncovered edit can then fuse to a false SAFE. */
function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

export async function editsFromUnifiedDiff(repoRoot: string, diffStr: string): Promise<FileEdit[]> {
  const patches = parsePatch(diffStr);
  const raw = scanRawDiff(diffStr);

  // Refuse unsupported operations before building any edits, so a diff that also
  // does one of these never verifies on the strength of its benign hunks alone.
  const deleted = findDeletion(patches, raw);
  if (deleted) {
    throw new DiffApplyError(
      `diff deletes ${deleted}; file deletions are not supported yet, verify that change manually`,
    );
  }
  // Copies first: parsePatch models a copy-with-edit as old !== new, exactly
  // like a rename, so without this order the copy would be mislabeled.
  const copied = raw.copies[0];
  if (copied) {
    throw new DiffApplyError(
      `diff copies ${copied.from} to ${copied.to}; copies are not supported yet`,
    );
  }
  const renamed = findRename(patches, raw);
  if (renamed) {
    throw new DiffApplyError(
      `diff renames ${renamed.from} to ${renamed.to}; renames are not supported yet`,
    );
  }
  // A submodule pointer is a gitlink, not a file: it cannot be applied to a
  // shadow tree or covered by tests, so a bump must be refused rather than fall
  // through to a confusing "did not apply".
  const submodule = findSubmodule(raw);
  if (submodule) {
    throw new DiffApplyError(
      `diff changes a git submodule pointer (${submodule}); submodules are not supported yet`,
    );
  }

  const edits: FileEdit[] = [];
  for (const p of patches) {
    const rel = stripPrefix(p.newFileName ?? p.oldFileName ?? '');
    if (!rel || rel === '/dev/null') continue;
    if (p.hunks.length === 0) continue; // metadata/binary-only entry: no content
    const base = await readUtf8Base(repoRoot, rel);
    const oldRel = stripPrefix(p.oldFileName ?? '');
    // Trust the DISK, not the diff's `--- /dev/null` claim. A diff can assert
    // "new file" on the old side while the victim path already exists: trusting
    // that claim would let an anchorless hunk skip the guard below and splice
    // content in at a raw line number onto the live file (C1). A file is "new"
    // only when its base is genuinely absent. The one safe relaxation is a
    // recreate-into-empty: the diff claims /dev/null AND the on-disk base is
    // empty, where an all-insertion hunk cannot misapply onto drift because
    // there is no base content to drift from.
    const isNewFile = base === null || (oldRel === '/dev/null' && base === '');
    // Anchorless hunks (no context, no deletions) cannot validate against the
    // base, so they silently misapply onto a drifted base. Creating a new file
    // is the one legitimately context-free case; everything else must carry an
    // anchor. Reject rather than fabricate a wrong-location insertion.
    if (!isNewFile) {
      for (const h of p.hunks) {
        if (isAnchorlessHunk(h)) {
          throw new DiffApplyError(
            `diff has a zero-context hunk in ${rel}; regenerate the diff with context (e.g. git diff -U3)`,
          );
        }
      }
    }
    const applied = applyPatch(base ?? '', p);
    if (applied === false) {
      throw new DiffApplyError(`diff did not apply to ${rel} (stale base?)`);
    }
    edits.push({ path: rel, newContent: applied });
  }

  // Binary changes are unverifiable. Alone → the diff has nothing to verify;
  // alongside text edits → still refuse, so a partial verdict on the text half
  // never reads as a verdict on the whole diff.
  if (raw.hasBinary) {
    if (edits.length === 0) {
      throw new DiffApplyError('diff contains only binary changes; nothing verifiable');
    }
    throw new DiffApplyError(
      'diff contains binary changes alongside text edits; binary changes cannot be verified',
    );
  }

  return edits;
}

export async function changedLinesForEdits(
  repoRoot: string,
  edits: FileEdit[],
): Promise<ChangedRange[]> {
  const out: ChangedRange[] = [];
  for (const e of edits) {
    // Reject a non-UTF-8 base here too: a caller may pass pre-built edits and
    // skip editsFromUnifiedDiff, and diffing against a U+FFFD-mangled base would
    // inflate the changed-line set (potentially into a false SAFE).
    const base = (await readUtf8Base(repoRoot, e.path)) ?? '';
    const patch = structuredPatch(e.path, e.path, normalizeEol(base), normalizeEol(e.newContent));
    const lines: number[] = [];
    for (const hunk of patch.hunks) {
      let newLineNo = hunk.newStart;
      for (const l of hunk.lines) {
        if (l.startsWith('+')) {
          lines.push(newLineNo);
          newLineNo += 1;
        } else if (l.startsWith('-')) {
          // old-only line; does not advance the new-file counter
        } else if (l.startsWith('\\')) {
          // "\ No newline at end of file" marker — not a real line; do not advance
        } else {
          newLineNo += 1; // context line
        }
      }
    }
    out.push({ path: e.path, lines });
  }
  return out;
}
