// The check of directories above a copy, scoped to the runner in use so a stray
// ~/node_modules does not floor a Python project and a stray pyproject.toml does
// not floor a JS one.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  scanAncestorsForRunner,
  refuseRunnerFilesAbove,
  runnerFamiliesOf,
  ancestorRefusalReason,
  isAncestorRefusal,
  AncestorRefusalError,
} from '../../../src/verify/ancestor-scan.js';
import { displayPath, verificationBase } from '../../../src/verify/private-base.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

// The copy sits one level below a directory the test controls, under the
// verification base so nothing above the parent is a stray runner file.
async function nestedCopy(): Promise<{ parent: string; copy: string }> {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(await verificationBase(), 'anc-')));
  dirs.push(parent);
  const copy = path.join(parent, 'tree');
  await fs.mkdir(copy);
  return { parent, copy };
}

const PYTEST = 'sh -c python3 -m pytest -q';
const VITEST = 'npx vitest run';

describe('runnerFamiliesOf', () => {
  it('recognises Python runners', () => {
    expect(runnerFamiliesOf(PYTEST)).toEqual(['python']);
    expect(runnerFamiliesOf('sh -c python3 tests/runtests.py')).toEqual(['python']);
  });
  it('recognises JS runners', () => {
    expect(runnerFamiliesOf(VITEST)).toEqual(['js']);
    expect(runnerFamiliesOf('npx jest')).toEqual(['js']);
  });
  it('checks both when the runner cannot be told', () => {
    expect(runnerFamiliesOf('sh -c make test')).toEqual(['python', 'js']);
  });
});

describe('scanAncestorsForRunner', () => {
  it('finds a pytest config above the copy for a pytest run', async () => {
    const { parent, copy } = await nestedCopy();
    await fs.writeFile(path.join(parent, 'pytest.ini'), '[pytest]\n');
    expect(await scanAncestorsForRunner(copy, PYTEST)).toEqual({ name: 'pytest.ini', dir: parent });
  });

  it('finds a setup.py above the copy for a pytest run', async () => {
    const { parent, copy } = await nestedCopy();
    await fs.writeFile(path.join(parent, 'setup.py'), '');
    expect(await scanAncestorsForRunner(copy, PYTEST)).toEqual({ name: 'setup.py', dir: parent });
  });

  it('finds a file two levels above the copy', async () => {
    const { parent, copy } = await nestedCopy();
    const deep = path.join(copy, 'sub');
    await fs.mkdir(deep);
    await fs.writeFile(path.join(parent, 'conftest.py'), '');
    expect(await scanAncestorsForRunner(deep, PYTEST)).toEqual({
      name: 'conftest.py',
      dir: parent,
    });
  });

  it('checks the spelled path as well as the resolved one', async () => {
    const { parent, copy } = await nestedCopy();
    const outside = path.join(parent, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'conftest.py'), '');
    const link = path.join(outside, 'link');
    await fs.symlink(copy, link);
    expect(await scanAncestorsForRunner(link, PYTEST)).toEqual({
      name: 'conftest.py',
      dir: outside,
    });
  });

  it('finds a conftest.py above the copy for a pytest run', async () => {
    const { parent, copy } = await nestedCopy();
    await fs.writeFile(path.join(parent, 'conftest.py'), '');
    expect(await scanAncestorsForRunner(copy, PYTEST)).toEqual({
      name: 'conftest.py',
      dir: parent,
    });
  });

  it('ignores a node_modules above the copy for a pytest run', async () => {
    const { parent, copy } = await nestedCopy();
    await fs.mkdir(path.join(parent, 'node_modules'));
    expect(await scanAncestorsForRunner(copy, PYTEST)).toBeNull();
  });

  it('finds a node_modules above the copy for a JS run', async () => {
    const { parent, copy } = await nestedCopy();
    await fs.mkdir(path.join(parent, 'node_modules'));
    expect(await scanAncestorsForRunner(copy, VITEST)).toEqual({
      name: 'node_modules',
      dir: parent,
    });
  });

  it('finds a tsconfig.json above the copy for a JS run', async () => {
    const { parent, copy } = await nestedCopy();
    await fs.writeFile(path.join(parent, 'tsconfig.json'), '{}');
    expect(await scanAncestorsForRunner(copy, VITEST)).toEqual({
      name: 'tsconfig.json',
      dir: parent,
    });
  });

  it('ignores a pytest.ini above the copy for a JS run', async () => {
    const { parent, copy } = await nestedCopy();
    await fs.writeFile(path.join(parent, 'pytest.ini'), '[pytest]\n');
    expect(await scanAncestorsForRunner(copy, VITEST)).toBeNull();
  });

  it('checks both families for an unrecognised command', async () => {
    const { parent, copy } = await nestedCopy();
    await fs.mkdir(path.join(parent, 'node_modules'));
    expect(await scanAncestorsForRunner(copy, 'sh -c make test')).toEqual({
      name: 'node_modules',
      dir: parent,
    });
  });

  it('is null when the directories above are clean', async () => {
    const { copy } = await nestedCopy();
    expect(await scanAncestorsForRunner(copy, PYTEST)).toBeNull();
  });

  it('does not flag the copy’s own files', async () => {
    const { copy } = await nestedCopy();
    await fs.writeFile(path.join(copy, 'pytest.ini'), '[pytest]\n');
    await fs.mkdir(path.join(copy, 'node_modules'));
    expect(await scanAncestorsForRunner(copy, PYTEST)).toBeNull();
    expect(await scanAncestorsForRunner(copy, VITEST)).toBeNull();
  });
});

describe('refuseRunnerFilesAbove', () => {
  it('throws a refusal naming the kind and the directory', async () => {
    const { parent, copy } = await nestedCopy();
    await fs.writeFile(path.join(parent, 'pyproject.toml'), '');
    const err = await refuseRunnerFilesAbove(copy, PYTEST).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AncestorRefusalError);
    expect(String(err)).toContain(`a pyproject.toml above the verification copy`);
    expect(String(err)).toContain(`(found in ${displayPath(parent)})`);
  });

  it('resolves when nothing is found', async () => {
    const { copy } = await nestedCopy();
    await expect(refuseRunnerFilesAbove(copy, PYTEST)).resolves.toBeUndefined();
  });
});

describe('refusal reason', () => {
  it('names the kind, and only a reason that starts with it is recognised', () => {
    const reason = ancestorRefusalReason('conftest.py', '/somewhere');
    expect(reason).toMatch(/^a conftest\.py above the verification copy/);
    expect(reason).toContain('(found in /somewhere)');
    expect(isAncestorRefusal(reason)).toBe(true);
    expect(isAncestorRefusal(`tests fail after refactoring:\n${reason}`)).toBe(false);
  });
});
