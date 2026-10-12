// Private base selection. POSIX-only: Windows takes the per-user %TEMP% path.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import type * as Os from 'node:os';
import * as path from 'node:path';
import {
  verificationBase,
  mkdtempPrivate,
  PrivateBaseError,
  CopyFailedError,
} from '../../../src/verify/private-base.js';

// The account's home from the user database, which HOME does not change.
const passwd = vi.hoisted(() => ({ home: undefined as string | undefined, throws: false }));
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof Os>();
  const userInfo = (): ReturnType<typeof real.userInfo> => {
    if (passwd.throws) throw new Error('no passwd entry');
    const u = real.userInfo();
    return passwd.home === undefined ? u : { ...u, homedir: passwd.home };
  };
  return { ...real, default: { ...real, userInfo }, userInfo };
});

const WIN = process.platform === 'win32';
const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0;
const ENV_KEYS = ['REFACTRON_VERIFY_BASE', 'TMPDIR', 'XDG_RUNTIME_DIR', 'XDG_CACHE_HOME', 'HOME'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let scratch: string;

function stickyTmp(): boolean {
  try {
    const st = statSync('/tmp');
    return (st.mode & 0o1002) === 0o1002;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  delete process.env.REFACTRON_VERIFY_BASE;
  // A qualifying root to build fixtures under: on Linux os.tmpdir() is /tmp,
  // which (correctly) never qualifies.
  scratch = await fs.mkdtemp(path.join(await verificationBase(), 'pb-'));
});

afterEach(async () => {
  passwd.home = undefined;
  passwd.throws = false;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await fs.chmod(scratch, 0o700).catch(() => {});
  await fs.rm(scratch, { recursive: true, force: true });
});

async function dir(name: string, mode: number, parent = scratch): Promise<string> {
  const d = path.join(parent, name);
  await fs.mkdir(d);
  await fs.chmod(d, mode);
  return d;
}

describe.skipIf(WIN)('verificationBase', () => {
  it('accepts a 0700 directory owned by this user', async () => {
    const base = await dir('ok', 0o700);
    process.env.REFACTRON_VERIFY_BASE = base;
    expect(await verificationBase()).toBe(base);
    expect(path.dirname(await mkdtempPrivate('run-'))).toBe(base);
  });

  it.skipIf(ROOT_USER)('rejects a directory this user does not own', async () => {
    process.env.REFACTRON_VERIFY_BASE = '/';
    await expect(verificationBase()).rejects.toBeInstanceOf(PrivateBaseError);
  });

  it('rejects a group-writable directory', async () => {
    process.env.REFACTRON_VERIFY_BASE = await dir('g', 0o770);
    await expect(verificationBase()).rejects.toBeInstanceOf(PrivateBaseError);
  });

  it('rejects a world-writable directory', async () => {
    process.env.REFACTRON_VERIFY_BASE = await dir('o', 0o707);
    await expect(verificationBase()).rejects.toBeInstanceOf(PrivateBaseError);
  });

  it('rejects a private directory under a world-writable ancestor', async () => {
    const shared = await dir('shared', 0o777);
    process.env.REFACTRON_VERIFY_BASE = await dir('leaf', 0o700, shared);
    await expect(verificationBase()).rejects.toBeInstanceOf(PrivateBaseError);
  });

  it.skipIf(!stickyTmp())('rejects a private directory under the sticky /tmp', async () => {
    const leaf = await fs.mkdtemp('/tmp/pb-sticky-');
    try {
      process.env.REFACTRON_VERIFY_BASE = leaf;
      await expect(verificationBase()).rejects.toBeInstanceOf(PrivateBaseError);
    } finally {
      await fs.rm(leaf, { recursive: true, force: true });
    }
  });

  it('creates a missing override directory with mode 0700', async () => {
    const base = path.join(scratch, 'made');
    process.env.REFACTRON_VERIFY_BASE = base;
    expect(await verificationBase()).toBe(base);
    expect((await fs.stat(base)).mode & 0o777).toBe(0o700);
  });

  it('fails closed with a plain reason when nothing qualifies', async () => {
    process.env.REFACTRON_VERIFY_BASE = await dir('bad', 0o777);
    await expect(verificationBase()).rejects.toThrow(
      /could not create a private directory for the verification copy/,
    );
  });

  it('shows the home directory as ~ in the reason', async () => {
    process.env.HOME = scratch;
    const bad = await dir('bad', 0o777);
    process.env.REFACTRON_VERIFY_BASE = bad;
    const err = await verificationBase().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PrivateBaseError);
    expect(String(err)).toContain('~/bad');
    expect(String(err)).not.toContain(scratch);
  });
});

describe.skipIf(WIN)('mkdtempPrivate', () => {
  it.skipIf(ROOT_USER)('reports a failure to create the directory as a copy failure', async () => {
    const base = await dir('ro', 0o500);
    process.env.REFACTRON_VERIFY_BASE = base;
    await expect(mkdtempPrivate('run-')).rejects.toBeInstanceOf(CopyFailedError);
  });
});

describe.skipIf(WIN)('candidate order', () => {
  // Every later candidate is made unusable unless the test is about it.
  async function shutAll(): Promise<void> {
    process.env.TMPDIR = await dir('tmp', 0o777);
    process.env.XDG_CACHE_HOME = await dir('cache', 0o777);
    passwd.home = await dir('pwhome', 0o777);
    delete process.env.XDG_RUNTIME_DIR;
  }

  it('uses os.tmpdir() when it qualifies', async () => {
    await shutAll();
    process.env.TMPDIR = await dir('own-tmp', 0o700);
    process.env.XDG_RUNTIME_DIR = await dir('run', 0o700);
    expect(await verificationBase()).toBe(process.env.TMPDIR);
  });

  it('falls through an open tmpdir to XDG_CACHE_HOME/refactron, created 0700', async () => {
    await shutAll();
    process.env.XDG_CACHE_HOME = await dir('own-cache', 0o700);
    process.env.XDG_RUNTIME_DIR = await dir('run', 0o700);
    const base = await verificationBase();
    expect(base).toBe(path.join(process.env.XDG_CACHE_HOME, 'refactron'));
    expect((await fs.stat(base)).mode & 0o777).toBe(0o700);
  });

  it('uses ~/.cache/refactron when XDG_CACHE_HOME is unset', async () => {
    await shutAll();
    delete process.env.XDG_CACHE_HOME;
    process.env.HOME = await dir('home', 0o700);
    expect(await verificationBase()).toBe(path.join(process.env.HOME, '.cache', 'refactron'));
  });

  it('ignores a relative XDG_CACHE_HOME', async () => {
    await shutAll();
    process.env.XDG_CACHE_HOME = 'relative-cache';
    process.env.XDG_RUNTIME_DIR = await dir('run', 0o700);
    expect(await verificationBase()).toBe(process.env.XDG_RUNTIME_DIR);
  });

  it('falls through an open cache to <account home>/.refactron/verify, created 0700', async () => {
    await shutAll();
    process.env.HOME = await dir('env-home', 0o777);
    passwd.home = await dir('pw-home', 0o700);
    process.env.XDG_RUNTIME_DIR = await dir('run', 0o700);
    const base = await verificationBase();
    expect(base).toBe(path.join(passwd.home, '.refactron', 'verify'));
    expect((await fs.stat(base)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.dirname(base))).mode & 0o777).toBe(0o700);
  });

  it('uses XDG_RUNTIME_DIR only after every other candidate', async () => {
    await shutAll();
    process.env.XDG_RUNTIME_DIR = await dir('run', 0o700);
    expect(await verificationBase()).toBe(process.env.XDG_RUNTIME_DIR);
  });

  it('skips the account home when the user database has no entry', async () => {
    await shutAll();
    passwd.throws = true;
    process.env.XDG_RUNTIME_DIR = await dir('run', 0o700);
    expect(await verificationBase()).toBe(process.env.XDG_RUNTIME_DIR);
  });

  it('fails closed when no candidate qualifies', async () => {
    await shutAll();
    process.env.XDG_RUNTIME_DIR = await dir('run', 0o777);
    await expect(verificationBase()).rejects.toBeInstanceOf(PrivateBaseError);
  });

  it('uses REFACTRON_VERIFY_BASE as the only candidate', async () => {
    process.env.TMPDIR = await dir('own-tmp', 0o700);
    process.env.REFACTRON_VERIFY_BASE = await dir('open', 0o777);
    await expect(verificationBase()).rejects.toBeInstanceOf(PrivateBaseError);
  });
});
