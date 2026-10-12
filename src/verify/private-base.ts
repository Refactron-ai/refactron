// The base directory every verification copy is created in (shadow, baseline,
// stability reruns, mutation, coverage). Test runners read files from the
// directories above where they run, so the base must be one only this user can
// write to, all the way up to the filesystem root.
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const OVERRIDE_ENV = 'REFACTRON_VERIFY_BASE';

/** How every PrivateBaseError message begins; verdict fusion matches on it. */
export const PRIVATE_BASE_REASON = 'could not create a private directory for the verification copy';
/** How every CopyFailedError message begins; verdict fusion matches on it. */
export const COPY_FAILED_REASON = 'could not create the verification copy';

/** A run that could not be isolated in its own copy. Nothing was verified, so
 *  every catcher maps it to UNPROVEN or inconclusive, never to a failure. */
export class CopyIsolationError extends Error {}

export class PrivateBaseError extends CopyIsolationError {
  constructor(detail: string) {
    super(`${PRIVATE_BASE_REASON}: ${detail}`);
    this.name = 'PrivateBaseError';
  }
}

function errorCode(err: unknown): string {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
    ? err.code
    : 'unknown error';
}

/** Only the error code is kept: an fs message names host paths. */
export class CopyFailedError extends CopyIsolationError {
  constructor(cause: unknown) {
    super(`${COPY_FAILED_REASON} (${errorCode(cause)})`);
    this.name = 'CopyFailedError';
  }
}

function accountHome(): string | null {
  try {
    return os.userInfo().homedir;
  } catch {
    return null;
  }
}

function homes(): string[] {
  return [os.homedir(), accountHome() ?? ''].filter(
    (h) => path.isAbsolute(h) && path.dirname(h) !== h,
  );
}

/** `p` with the home directory shown as `~`, for reasons a report carries. */
export function displayPath(p: string): string {
  for (const h of homes()) {
    if (p === h) return '~';
    if (p.startsWith(h + path.sep)) return `~${p.slice(h.length)}`;
  }
  return p;
}

const GROUP_OR_OTHER_WRITE = 0o022;

async function dirQualifies(dir: string, leaf: boolean, uid: number): Promise<boolean> {
  const st = await fs.stat(dir).catch(() => null);
  if (st === null || !st.isDirectory() || st.mode & GROUP_OR_OTHER_WRITE) return false;
  return st.uid === uid || (!leaf && st.uid === 0);
}

/** `dir` is ours, and it and every ancestor are owned by us or root and not
 *  group- or world-writable (sshd StrictModes). A sticky /tmp does not pass. */
async function chainQualifies(dir: string, uid: number): Promise<boolean> {
  const real = await fs.realpath(dir).catch(() => null);
  if (real === null || !(await dirQualifies(real, true, uid))) return false;
  for (let d = real; path.dirname(d) !== d; d = path.dirname(d)) {
    if (!(await dirQualifies(path.dirname(d), false, uid))) return false;
  }
  return true;
}

interface Candidate {
  dir: string;
  create: boolean;
}

function candidates(): Candidate[] {
  const cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  const home = accountHome();
  // The account's own home, not $HOME: a CI container can set HOME to a
  // directory another uid owns, and some distros make ~/.cache group-writable.
  // XDG_RUNTIME_DIR is last because it is a small tmpfs.
  const list: Candidate[] = [
    { dir: os.tmpdir(), create: false },
    { dir: path.join(cacheHome, 'refactron'), create: true },
    ...(home ? [{ dir: path.join(home, '.refactron', 'verify'), create: true }] : []),
    { dir: process.env.XDG_RUNTIME_DIR ?? '', create: false },
  ];
  return list.filter((c) => path.isAbsolute(c.dir));
}

/** The verified base directory. REFACTRON_VERIFY_BASE, when set, is the only
 *  candidate and passes the same checks. Throws PrivateBaseError when none
 *  qualifies, so callers fail closed. */
export async function verificationBase(): Promise<string> {
  const override = process.env[OVERRIDE_ENV]?.trim();
  if (typeof process.getuid !== 'function') {
    // Windows: no POSIX ownership to check; %TEMP% is per-user by default.
    const base = override ? path.resolve(override) : os.tmpdir();
    await fs.mkdir(base, { recursive: true }).catch((err: unknown) => {
      throw new PrivateBaseError(`${displayPath(base)} could not be created (${errorCode(err)})`);
    });
    return base;
  }
  const uid = process.getuid();
  const tried: string[] = [];
  const list = override ? [{ dir: path.resolve(override), create: true }] : candidates();
  for (const { dir, create } of list) {
    const made = create
      ? await fs.mkdir(dir, { recursive: true, mode: 0o700 }).then(
          () => true,
          () => false,
        )
      : true;
    if (made && (await chainQualifies(dir, uid))) return dir;
    tried.push(displayPath(dir));
  }
  throw new PrivateBaseError(
    `none of ${tried.join(', ')} is owned by this user with no group- or world-writable ` +
      `directory above it. Set ${OVERRIDE_ENV} to a directory only you can write to.`,
  );
}

/** A fresh per-run directory inside the verified base. */
export async function mkdtempPrivate(prefix: string): Promise<string> {
  const base = await verificationBase();
  return fs.mkdtemp(path.join(base, prefix)).catch((err: unknown) => {
    throw new CopyFailedError(err);
  });
}
