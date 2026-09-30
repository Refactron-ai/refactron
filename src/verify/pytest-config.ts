// src/verify/pytest-config.ts
// Ask pytest which config file a run uses and what it says, via the
// checks/_py/pytest_config.py sidecar (#174). A line reader cannot reproduce
// pytest's parsing: it missed narrowing shapes (false SAFE) and misread
// neighbouring tables (a lost SAFE).
//
// Never throws. Every failure comes back as `ok: false` with a reason, which the
// scope check turns into `narrowed`: an empty answer must not read as "no
// narrowing".
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { redactEnvForRunner } from './runners/run.js';

const SIDECAR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'checks/_py');
const SIDECAR = path.join(SIDECAR_DIR, 'pytest_config.py');

export interface PytestInvocation {
  /** The argv pytest receives, after `pytest` or `-m pytest`. */
  args: readonly string[];
  /** PYTEST_ADDOPTS as the run sees it; pytest prepends it to `args`. */
  envAddopts: string | null;
}

export type PytestConfigRead =
  | {
      ok: true;
      /** Repo-relative path of the file pytest reads, or null when none applies. */
      file: string | null;
      addopts: string[] | null;
      testpaths: string[] | null;
      pythonFiles: string[] | null;
    }
  | { ok: false; file: string | null; reason: string };

export interface ReadPytestConfigOptions {
  pythonBin?: string;
  timeoutMs?: number;
}

function stringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function optionalList(v: unknown): v is string[] | null {
  return v === null || stringList(v);
}

function optionalString(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

/** Validate the sidecar's JSON. Anything off-contract is a failure, never a
 *  partial answer. */
export function parsePytestConfigOutput(stdout: string): PytestConfigRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, file: null, reason: 'the config reader produced unparseable output' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, file: null, reason: 'the config reader produced unexpected output' };
  }
  const o = parsed as Record<string, unknown>;
  const file = optionalString(o.config_file) ? o.config_file : null;
  if (o.ok === false) {
    const reason = typeof o.error === 'string' && o.error !== '' ? o.error : 'unknown error';
    return { ok: false, file, reason };
  }
  if (
    o.ok === true &&
    optionalString(o.config_file) &&
    optionalList(o.addopts) &&
    optionalList(o.testpaths) &&
    optionalList(o.python_files)
  ) {
    return {
      ok: true,
      file: o.config_file,
      addopts: o.addopts,
      testpaths: o.testpaths,
      pythonFiles: o.python_files,
    };
  }
  return { ok: false, file, reason: 'the config reader produced unexpected output' };
}

export async function readPytestConfig(
  root: string,
  invocation: PytestInvocation,
  opts: ReadPytestConfigOptions = {},
): Promise<PytestConfigRead> {
  const input = JSON.stringify({
    root,
    args: invocation.args,
    env_addopts: invocation.envAddopts,
  });
  try {
    // Neutral cwd, base environment and -E (ADR-17): nothing in the repository
    // may shadow pytest's modules, and -E also refuses a PYTHONPATH sitecustomize.
    const result = await execa(opts.pythonBin ?? 'python3', ['-E', SIDECAR], {
      input,
      cwd: SIDECAR_DIR,
      env: redactEnvForRunner(process.env),
      extendEnv: false,
      reject: false,
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.timedOut) {
      return { ok: false, file: null, reason: 'the config reader timed out' };
    }
    if (result.failed && result.exitCode === undefined) {
      // A spawn failure (no such interpreter) carries its reason only on the error shape.
      const why = 'shortMessage' in result ? String(result.shortMessage).split('\n')[0] : '';
      return {
        ok: false,
        file: null,
        reason: `the config reader could not run${why ? `: ${why}` : ''}`,
      };
    }
    const read = parsePytestConfigOutput(result.stdout);
    if (result.exitCode !== 0 && read.ok) {
      return { ok: false, file: read.file, reason: `the config reader exited ${result.exitCode}` };
    }
    if (!read.ok && read.reason.includes('produced') && result.stderr.trim() !== '') {
      return { ...read, reason: `${read.reason}: ${result.stderr.trim().slice(0, 200)}` };
    }
    return read;
  } catch (err) {
    return {
      ok: false,
      file: null,
      reason: `the config reader could not run: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
