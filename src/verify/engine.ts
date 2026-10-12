import type { Verifier, RefactorPlan, VerificationResult, GateResult } from '../contracts.js';
import { createShadowTree } from './shadow-tree.js';
import { syntaxGate } from './gates/syntax.js';
import { importsGate } from './gates/imports.js';
import { testsGate, type TestsGateOptions } from './gates/tests.js';
import { CopyIsolationError } from './private-base.js';
import type { ShadowTreeHandle } from './types.js';

export type GateName = 'syntax' | 'imports' | 'tests';

const NOT_RUN_REASON = 'not run: the verification copy could not be created';

export interface RefactronVerifierOptions {
  projectRoot: string;
  testCmd?: string;
  timeoutMs?: number;
  /**
   * Streaming hook: invoked once per gate as it finishes (including skipped
   * gates produced after an earlier gate fails). Lets the CLI render
   * per-gate progress without changing the locked Verifier surface.
   */
  onGateComplete?: (gate: GateName, result: GateResult) => void;
  /**
   * Streaming hook: invoked immediately BEFORE a gate begins. Lets the CLI
   * render live "verifying …" progress. Not part of the locked Verifier
   * surface. Never fires for a gate skipped because an earlier gate failed.
   */
  onGateStart?: (gate: GateName) => void;
  /**
   * Fires exactly once with the absolute path of the shadow tree, immediately
   * after creation. The CLI uses this for the "reproduce locally" hint.
   */
  onShadowRoot?: (path: string) => void;
  /**
   * Forwarded to the tests gate — skips its baseline (unmodified-tree) run.
   * Used by the per-file apply fallback, where the batch run has already
   * proven the baseline is green.
   */
  skipBaseline?: boolean;
}

export class RefactronVerifier implements Verifier {
  constructor(private readonly opts: RefactronVerifierOptions) {}

  async verify(plan: RefactorPlan): Promise<VerificationResult> {
    let handle: ShadowTreeHandle;
    try {
      handle = await createShadowTree(this.opts.projectRoot, plan.changes);
    } catch (err) {
      if (err instanceof CopyIsolationError) return this.notRun(err.message);
      throw err;
    }
    this.opts.onShadowRoot?.(handle.path);
    try {
      const ctx = { shadowRoot: handle.path, changes: plan.changes };

      this.opts.onGateStart?.('syntax');
      const syntax = await syntaxGate(ctx, this.opts.projectRoot);
      this.opts.onGateComplete?.('syntax', syntax);
      if (!syntax.passed) return this.fail({ syntax });

      this.opts.onGateStart?.('imports');
      const imports = await importsGate(ctx, this.opts.projectRoot);
      this.opts.onGateComplete?.('imports', imports);
      if (!imports.passed) return this.fail({ syntax, imports });

      const testsOpts: TestsGateOptions = {
        ...(this.opts.testCmd !== undefined ? { testCmd: this.opts.testCmd } : {}),
        ...(this.opts.timeoutMs !== undefined ? { timeoutMs: this.opts.timeoutMs } : {}),
        ...(this.opts.skipBaseline !== undefined ? { skipBaseline: this.opts.skipBaseline } : {}),
      };
      this.opts.onGateStart?.('tests');
      const tests = await testsGate(ctx, this.opts.projectRoot, testsOpts);
      this.opts.onGateComplete?.('tests', tests);
      if (!tests.passed) return this.fail({ syntax, imports, tests });

      return {
        passed: true,
        gates: { syntax, imports, tests },
        writableChanges: plan.changes,
      };
    } finally {
      await handle.cleanup();
    }
  }

  /** No copy, so no gate ran. The tests gate carries the cause, which fusion
   *  maps to UNPROVEN. */
  private notRun(cause: string): VerificationResult {
    const notRun: GateResult = { passed: false, durationMs: 0, blockingReason: NOT_RUN_REASON };
    const gates = {
      syntax: notRun,
      imports: notRun,
      tests: { passed: false, durationMs: 0, blockingReason: cause },
    };
    for (const gate of ['syntax', 'imports', 'tests'] as const) {
      this.opts.onGateComplete?.(gate, gates[gate]);
    }
    return { passed: false, gates, writableChanges: [] };
  }

  private fail(gates: Partial<VerificationResult['gates']>): VerificationResult {
    const skipped: GateResult = {
      passed: false,
      durationMs: 0,
      blockingReason: 'skipped (earlier gate failed)',
    };
    const resolved = {
      syntax: gates.syntax ?? skipped,
      imports: gates.imports ?? skipped,
      tests: gates.tests ?? skipped,
    };
    // Emit a synthetic onGateComplete for any gates that were skipped because
    // a previous gate failed — the caller expects exactly three notifications
    // (syntax → imports → tests) regardless of where failure happened.
    if (!gates.imports) this.opts.onGateComplete?.('imports', resolved.imports);
    if (!gates.tests) this.opts.onGateComplete?.('tests', resolved.tests);
    return {
      passed: false,
      gates: resolved,
      writableChanges: [],
    };
  }
}
