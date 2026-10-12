// Before every suite spawn in a copy, check the directories above it for files
// the runner would read from there. A hit ends the run UNPROVEN.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CopyIsolationError, displayPath } from './private-base.js';

export type RunnerFamily = 'python' | 'js';

const FILES: Readonly<Record<RunnerFamily, readonly string[]>> = {
  python: [
    'pytest.ini',
    '.pytest.ini',
    'pytest.toml',
    '.pytest.toml',
    'tox.ini',
    'setup.cfg',
    'setup.py',
    'pyproject.toml',
    'conftest.py',
  ],
  // Measured with vitest: a module missing from the copy resolves through a
  // node_modules above it, and esbuild reads a tsconfig.json above a copy that
  // has none.
  js: ['node_modules', 'tsconfig.json'],
};

/** Runner families a command belongs to; both when it cannot be told, so an
 *  unrecognised command is checked rather than skipped. */
export function runnerFamiliesOf(command: string): RunnerFamily[] {
  const out: RunnerFamily[] = [];
  if (/\b(pytest|py\.test|python[0-9.]*|unittest|tox|nox)\b/.test(command)) out.push('python');
  if (/\b(vitest|jest|mocha|node|npx|npm|pnpm|yarn|bun)\b/.test(command)) out.push('js');
  return out.length > 0 ? out : ['python', 'js'];
}

/** The reason for a file of `kind` found in `dir` above the copy. */
export function ancestorRefusalReason(kind: string, dir: string): string {
  return (
    `a ${kind} above the verification copy could change the test run, so it was not run ` +
    `(found in ${displayPath(dir)})`
  );
}

const REFUSAL_RE = /^a [\w.-]+ above the verification copy could change the test run/;

export function isAncestorRefusal(reason: string): boolean {
  return REFUSAL_RE.test(reason);
}

export class AncestorRefusalError extends CopyIsolationError {
  constructor(kind: string, dir: string) {
    super(ancestorRefusalReason(kind, dir));
    this.name = 'AncestorRefusalError';
  }
}

export interface AncestorFind {
  name: string;
  dir: string;
}

function above(start: string): string[] {
  const out: string[] = [];
  for (let d = start; path.dirname(d) !== d; d = path.dirname(d)) out.push(path.dirname(d));
  return out;
}

/** The first runner-relevant file found in a directory above `copyRoot`, or
 *  null. Both the resolved and the spelled chain are checked. Files inside the
 *  copy are the repository's own and are not checked. */
export async function scanAncestorsForRunner(
  copyRoot: string,
  command: string,
): Promise<AncestorFind | null> {
  const names = runnerFamiliesOf(command).flatMap((f) => FILES[f]);
  const spelled = path.resolve(copyRoot);
  const real = await fs.realpath(spelled).catch(() => spelled);
  const dirs = [...new Set([...above(real), ...above(spelled)])];
  for (const dir of dirs) {
    for (const name of names) {
      const hit = await fs.lstat(path.join(dir, name)).then(
        () => true,
        () => false,
      );
      if (hit) return { name, dir };
    }
  }
  return null;
}

/** Throws AncestorRefusalError when the scan finds anything. */
export async function refuseRunnerFilesAbove(copyRoot: string, command: string): Promise<void> {
  const find = await scanAncestorsForRunner(copyRoot, command);
  if (find !== null) throw new AncestorRefusalError(find.name, find.dir);
}
