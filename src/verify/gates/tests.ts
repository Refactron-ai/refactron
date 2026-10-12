import type { GateResult } from '../../contracts.js';
import type { CheckContext } from '../types.js';
import { detectRunner } from '../runners/detect.js';
import { runRunner, type RunResult } from '../runners/run.js';
import { summarizeVitestFailures } from '../summarize-vitest.js';
import { extractFailureIds } from '../failure-ids.js';
import { CopyIsolationError } from '../private-base.js';
import { createShadowTree } from '../shadow-tree.js';

const BASELINE_RETRIES = 2; // total attempts = retries + 1 = 3
const TAIL_BYTES = 4000;

export interface TestsGateOptions {
  testCmd?: string;
  timeoutMs?: number;
  skipBaseline?: boolean;
}

// The tests gate returns a GateResult plus, optionally, the ids of tests that
// failed once and healed on retry. `flakySuspects` is a verify-land extension:
// GateResult lives in the LOCKED contracts surface, so we widen the RETURN type
// here instead of touching contracts.ts. The extra field rides on the same
// object the verifier stores in `VerificationResult.gates.tests`, where the
// verdict fuser reads it back structurally without any contract change.
export interface TestsGateResult extends GateResult {
  flakySuspects?: string[];
}

export function baselineFailReason(stdout: string, stderr: string): string {
  const detail = `${stdout}\n${stderr}`.slice(-TAIL_BYTES);
  return `baseline tests already fail before refactoring; fix them first.\n${detail}`;
}

function formatVitestFailureBlock(stdout: string, stderr: string): string {
  const combined = `${stdout}\n${stderr}`;
  const summary = summarizeVitestFailures(combined);
  const tail = combined.slice(-TAIL_BYTES);
  if (summary.failures.length === 0) {
    return `tests fail after refactoring:\n${tail}`;
  }
  const lines: string[] = ['tests fail after refactoring:', '', 'Failing tests:'];
  for (const f of summary.failures) {
    lines.push(`  ✗ ${f.file} > ${f.testName}`);
    for (const ml of f.message.split('\n')) {
      lines.push(`      ${ml}`);
    }
  }
  lines.push('', 'Raw tail:', tail);
  return lines.join('\n');
}

export async function testsGate(
  ctx: CheckContext,
  projectRoot: string,
  opts: TestsGateOptions,
): Promise<TestsGateResult> {
  const t0 = Date.now();
  try {
    return await runTestsGate(ctx, projectRoot, opts, t0);
  } catch (err) {
    if (err instanceof CopyIsolationError) {
      return { passed: false, durationMs: Date.now() - t0, blockingReason: err.message };
    }
    throw err;
  }
}

async function runTestsGate(
  ctx: CheckContext,
  projectRoot: string,
  opts: TestsGateOptions,
  t0: number,
): Promise<TestsGateResult> {
  const detectOpts: { override?: string; timeoutMs?: number } = {};
  if (opts.testCmd !== undefined) detectOpts.override = opts.testCmd;
  if (opts.timeoutMs !== undefined) detectOpts.timeoutMs = opts.timeoutMs;
  const runner = await detectRunner(projectRoot, detectOpts);
  if (!runner) {
    return {
      passed: false,
      durationMs: Date.now() - t0,
      blockingReason: 'no test runner detected (pytest, vitest, jest); pass testCmd to override',
    };
  }
  if (!opts.skipBaseline) {
    // Baseline: run against an unmodified shadow tree. A red baseline is the
    // repo's pre-existing state, not this diff's fault, so it short-circuits
    // here with a distinct reason (fused to UNPROVEN, never UNSAFE). This
    // contract is unchanged by the flake-aware delta below, which only runs
    // once the baseline is proven green (empty failure set).
    const h = await createShadowTree(projectRoot, []);
    let baseline: RunResult;
    try {
      baseline = await runRunner({ ...runner, cwd: h.path }, { retries: BASELINE_RETRIES });
    } finally {
      await h.cleanup();
    }
    if (baseline.exitCode !== 0) {
      return {
        passed: false,
        durationMs: Date.now() - t0,
        blockingReason: baselineFailReason(baseline.stdout, baseline.stderr),
      };
    }
  }

  const done = (): number => Date.now() - t0;

  const after = await runRunner({ ...runner, cwd: ctx.shadowRoot }, { retries: 0 });
  // Fast path: a green after-run needs no delta and no retry (the retry only
  // doubles wall time when a new failure actually appears).
  if (after.exitCode === 0) {
    return { passed: true, durationMs: done() };
  }

  // The after-run failed. Reaching here means the baseline was green (or
  // skipped), so every after-failure id is a NEW failure relative to baseline.
  // Empty by construction: the baseline is proven green before the delta path runs.
  const baselineFailures = new Set<string>();
  const afterFailures = extractFailureIds(after.stdout, after.stderr);
  const newFailures = [...afterFailures].filter((id) => !baselineFailures.has(id));

  // Cannot compare sets: a non-zero run whose output yields no failure ids
  // (crash, timeout, unrecognized reporter) must fall back to today's behavior
  // (any failure fails the gate). Parse gaps never make the gate lenient.
  if (newFailures.length === 0) {
    return {
      passed: false,
      durationMs: done(),
      blockingReason: formatVitestFailureBlock(after.stdout, after.stderr),
    };
  }

  // New failures exist: rerun once on a FRESH shadow tree to shake out flakes.
  // Reusing ctx.shadowRoot (the already-run tree) would let a regression that
  // heals via first-run state mutation — an idempotency break that writes files
  // or DB state INTO the tree — masquerade as a flake: the second run would see
  // the mutated tree and pass. A genuine timing/race flake heals on a pristine
  // tree; a state-dependent heal fails again on the fresh tree and correctly
  // stays a gate failure with the failing tail. The gate already has projectRoot
  // and ctx.changes, so the fresh tree is built exactly like the engine's.
  const freshHandle = await createShadowTree(projectRoot, ctx.changes);
  let retry: RunResult;
  try {
    retry = await runRunner({ ...runner, cwd: freshHandle.path }, { retries: 0 });
  } finally {
    await freshHandle.cleanup();
  }

  // The retry is authoritative. Because the baseline is green here, ANY red on
  // the retry is a new failure that survived the rerun: a genuine regression,
  // never flaky. Keying off the exit code (not a parsed id set) means a retry
  // that crashes with unparseable output still fails the gate, so the fallback
  // is never more lenient than today. Failing tail + truncation preserved.
  if (retry.exitCode !== 0) {
    return {
      passed: false,
      durationMs: done(),
      blockingReason: formatVitestFailureBlock(retry.stdout, retry.stderr),
    };
  }

  // Green on retry: every new failure from the first run vanished. Treat them as
  // flaky, pass the gate, and surface the suspects so the report can note them.
  return { passed: true, durationMs: done(), flakySuspects: newFailures };
}
