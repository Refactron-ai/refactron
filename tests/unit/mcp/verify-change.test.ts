import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  handleVerifyChange,
  verifyChangeInputSchema,
} from '../../../src/mcp/tools/verify-change.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, '../../fixtures/verify-diff-mini');

function pythonHasCoverage(): boolean {
  try {
    execSync('python3 -c "import coverage, pytest"', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Silent, and guarding the ONLY assertion that the MCP tool can produce SAFE.
// On any image without coverage.py this reported PASSED while proving nothing
// about the surface every agent actually calls.
const NO_COVERAGE = !pythonHasCoverage();

// Issue #119. The schema description is the ONLY place an agent learns the
// narrowing rule before spending a verification run; the mdx docs are for humans
// who already went looking. Asserted so a future edit cannot silently drop it.
describe('verify_change schema', () => {
  const desc = verifyChangeInputSchema.testCmd.description ?? '';

  it('tells the caller a narrowed command caps the verdict', () => {
    expect(desc).toMatch(/whole suite/i);
    expect(desc).toContain('UNPROVEN');
  });

  it('names the flags that count as narrowing', () => {
    for (const flag of ['-k', '-t', '--collect-only']) expect(desc).toContain(flag);
  });

  it('states the PYTHONPATH exemption, which #95/#98 made the documented remedy', () => {
    expect(desc).toContain('PYTHONPATH');
  });

  it('stays short enough to be worth its place in an agent context window', () => {
    // Not arbitrary: this string ships on every tool listing, so it competes
    // with the tool's own description. Two sentences is the budget.
    expect(desc.length).toBeLessThan(260);
  });
});

describe('handleVerifyChange', () => {
  it.skipIf(NO_COVERAGE)(
    'returns a structured verdict for a SAFE change',
    async () => {
      const res = await handleVerifyChange({
        repoRoot: FIXTURE,
        trusted: true,
        edits: [
          {
            path: 'calc.py',
            newContent:
              'def add(a, b):\n    return b + a\n\n\ndef unused_helper(a, b):\n    return a - b\n',
          },
        ],
        testCmd: 'python3 -m pytest -q',
      });
      const report = JSON.parse(res.content[0]!.text);
      expect(report.verdict).toBe('SAFE');
      expect(report.trustMode).toBe('trusted');
      expect(res.isError).toBeFalsy();
      // testScope is a VERDICT INPUT (#112), and this is the surface every agent
      // calls. The report is serialized verbatim so the field is carried
      // structurally, but "structurally carried" is an argument, not a test:
      // nothing here asserted it, so a regression that dropped it would be
      // invisible exactly where it matters most.
      expect(report.testScope).toEqual({
        scope: 'full',
        source: 'override',
        signals: [],
      });
      // Shape, not literal: a release bump must not break this. reportVersion
      // says which SHAPE the consumer holds; engineVersion says which RULES
      // produced the verdict, which is what two SAFE-semantics changes in one
      // release line made necessary.
      expect(report.engineVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(report.reportVersion).toBe(1);
    },
    180_000,
  );

  it.skipIf(NO_COVERAGE)(
    'defaults to UNTRUSTED on the MCP surface: a would-be-SAFE is withheld',
    async () => {
      // The MCP tool is the agent-facing, untrusted-by-default surface: an agent
      // verifying a change it did not author (or one it did) cannot self-certify
      // trust in-band. The same edit that is SAFE with trusted:true must return
      // UNPROVEN here, because the in-process measurement is forgeable (ADR-19).
      const res = await handleVerifyChange({
        repoRoot: FIXTURE,
        edits: [
          {
            path: 'calc.py',
            newContent:
              'def add(a, b):\n    return b + a\n\n\ndef unused_helper(a, b):\n    return a - b\n',
          },
        ],
        testCmd: 'python3 -m pytest -q',
      });
      const report = JSON.parse(res.content[0]!.text);
      expect(report.trustMode).toBe('untrusted');
      expect(report.verdict).toBe('UNPROVEN');
      expect(report.reason).toContain('SAFE is withheld');
    },
    180_000,
  );

  it.skipIf(NO_COVERAGE)(
    'reports a narrowed scope on the MCP surface, and floors the verdict',
    async () => {
      // An agent narrowing to the tests it just wrote is the threat model
      // ADR-12 exists for, and the MCP server applies no authentication, so
      // this is the realistic caller rather than an edge case. trusted:true so the
      // NARROWED floor is what's under test, not the untrusted trust gate.
      const res = await handleVerifyChange({
        repoRoot: FIXTURE,
        trusted: true,
        edits: [
          {
            path: 'calc.py',
            newContent:
              'def add(a, b):\n    return b + a\n\n\ndef unused_helper(a, b):\n    return a - b\n',
          },
        ],
        testCmd: 'python3 -m pytest -q test_calc.py',
      });
      const report = JSON.parse(res.content[0]!.text);
      expect(report.testScope.scope).toBe('narrowed');
      expect(report.testScope.source).toBe('override');
      expect(report.testScope.signals.join(' ')).toContain('test_calc.py');
      expect(report.verdict).not.toBe('SAFE');
    },
    180_000,
  );

  it('reports a diff-apply error as an error result, not a throw', async () => {
    const res = await handleVerifyChange({ repoRoot: FIXTURE });
    expect(res.isError).toBe(true);
  });
});
