import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runRunner } from '../../../src/verify/runners/run.js';
import { verificationBase } from '../../../src/verify/private-base.js';
import { AncestorRefusalError } from '../../../src/verify/ancestor-scan.js';

// runRunner runs in a verification copy; the repo checkout has runner files
// (node_modules, tsconfig.json) above it, which the copy check refuses.
let cwd: string;
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(await verificationBase(), 'run-'));
});
afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

describe('runRunner', () => {
  it('returns exit code 0 on success', async () => {
    const r = await runRunner({
      cmd: 'sh',
      args: ['-c', 'exit 0'],
      cwd,
      timeoutMs: 5_000,
    });
    expect(r.exitCode).toBe(0);
  });
  it('returns nonzero on failure', async () => {
    const r = await runRunner({
      cmd: 'sh',
      args: ['-c', 'exit 17'],
      cwd,
      timeoutMs: 5_000,
    });
    expect(r.exitCode).toBe(17);
  });
  // Per-test timeout 15s: this test deliberately exercises execa's timeout +
  // SIGKILL + cleanup wall-clock, which on a contended CI runner can exceed
  // vitest's default 5000ms long after the runner has reported timedOut=true.
  it('reports timeout', async () => {
    const r = await runRunner({
      cmd: 'sh',
      args: ['-c', 'sleep 5'],
      cwd,
      timeoutMs: 500,
    });
    expect(r.timedOut).toBe(true);
  }, 15_000);
  it('retries baseline on flake', async () => {
    let attempt = 0;
    const r = await runRunner(
      { cmd: 'sh', args: ['-c', 'exit 0'], cwd, timeoutMs: 5_000 },
      { retries: 2, onAttempt: () => attempt++ },
    );
    expect(r.exitCode).toBe(0);
    expect(attempt).toBeGreaterThanOrEqual(1);
  });

  it('refuses before the first attempt when a runner file is above the copy', async () => {
    const copy = path.join(cwd, 'tree');
    await fs.mkdir(copy);
    await fs.writeFile(path.join(cwd, 'conftest.py'), '');
    let attempts = 0;
    await expect(
      runRunner(
        { cmd: 'python3', args: ['-m', 'pytest'], cwd: copy, timeoutMs: 5_000 },
        { retries: 2, onAttempt: () => attempts++ },
      ),
    ).rejects.toBeInstanceOf(AncestorRefusalError);
    expect(attempts).toBe(1);
  });

  it('checks again before every retry', async () => {
    const copy = path.join(cwd, 'tree');
    await fs.mkdir(copy);
    const above = path.join(cwd, 'pytest.ini');
    await expect(
      runRunner(
        { cmd: 'sh', args: ['-c', `touch '${above}'; exit 1`], cwd: copy, timeoutMs: 5_000 },
        { retries: 2 },
      ),
    ).rejects.toBeInstanceOf(AncestorRefusalError);
  });
});
