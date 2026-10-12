import { describe, it, expect, vi } from 'vitest';
import type { GateResult, RefactorPlan } from '../../../src/contracts.js';
import { PrivateBaseError } from '../../../src/verify/private-base.js';
import { RefactronVerifier, type GateName } from '../../../src/verify/engine.js';
import { fuseVerdict } from '../../../src/verify/verdict-fuse.js';

vi.mock('../../../src/verify/shadow-tree.js', () => ({
  createShadowTree: async () => {
    throw new PrivateBaseError('test');
  },
}));

const plan: RefactorPlan = { changes: [], preconditions: [] };

describe('RefactronVerifier when the copy cannot be created', () => {
  it('reports every gate as not run, notifies all three, and fuses to UNPROVEN', async () => {
    const seen: Array<[GateName, GateResult]> = [];
    const verifier = new RefactronVerifier({
      projectRoot: '/nonexistent',
      onGateComplete: (gate, result) => seen.push([gate, result]),
    });
    const result = await verifier.verify(plan);

    expect(result.passed).toBe(false);
    expect(seen.map(([g]) => g)).toEqual(['syntax', 'imports', 'tests']);
    for (const gate of ['syntax', 'imports'] as const) {
      expect(result.gates[gate].blockingReason).toBe(
        'not run: the verification copy could not be created',
      );
    }
    expect(result.gates.tests.blockingReason).toMatch(
      /^could not create a private directory for the verification copy/,
    );

    const report = fuseVerdict(
      result,
      ['a.py'],
      { tool: 'none', changedLinesCovered: 'unknown', uncovered: [] },
      { scope: 'full', source: 'override', signals: [] },
      true,
      [],
    );
    expect(report.verdict).toBe('UNPROVEN');
    expect(report.testScope.scope).toBe('unknown');
  });
});
