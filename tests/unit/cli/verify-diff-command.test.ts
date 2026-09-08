import { describe, it, expect } from 'vitest';
import {
  parseVerifyDiffFlags,
  VerifyDiffFlagError,
  formatTestFilesNote,
  formatFlakyNote,
  formatUncoveredLines,
  formatCoverageSummary,
  formatTestScopeNote,
  formatStabilityNote,
} from '../../../src/cli/verify-diff-command.js';
import type { StabilityResult } from '../../../src/verify/stability.js';

describe('formatUncoveredLines', () => {
  it('prints one line per uncovered statement', () => {
    expect(
      formatUncoveredLines({
        tool: 'coverage.py',
        changedLinesCovered: false,
        uncovered: [
          { file: 'a.py', line: 16 },
          { file: 'b.py', line: 4 },
        ],
      }),
    ).toEqual(['  uncovered: a.py:16', '  uncovered: b.py:4']);
  });

  it('discloses truncation instead of shipping a short list that looks complete', () => {
    const lines = formatUncoveredLines({
      tool: 'coverage.py',
      changedLinesCovered: false,
      uncovered: [{ file: 'a.py', line: 1 }],
      uncoveredTruncated: { shown: 1, total: 412 },
    });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('  ... and 411 more uncovered statement(s) (412 total)');
  });

  it('emits nothing when the change is fully covered', () => {
    expect(
      formatUncoveredLines({ tool: 'coverage.py', changedLinesCovered: true, uncovered: [] }),
    ).toEqual([]);
  });

  it('marks an excluded statement so nobody is told to write an impossible test', () => {
    expect(
      formatUncoveredLines({
        tool: 'coverage.py',
        changedLinesCovered: false,
        uncovered: [{ file: 'gated.py', line: 6, excluded: true }],
      }),
    ).toEqual(['  uncovered: gated.py:6 (excluded from coverage; no test can reach it)']);
  });

  it('says how many files a truncated list spans, not just how many entries', () => {
    const lines = formatUncoveredLines({
      tool: 'coverage.py',
      changedLinesCovered: false,
      uncovered: [{ file: 'a.py', line: 1 }],
      uncoveredTruncated: { shown: 1, total: 412 },
      filesWithUncovered: 37,
    });
    expect(lines[1]).toBe('  ... and 411 more uncovered statement(s) (412 total across 37 files)');
  });
});

describe('formatCoverageSummary', () => {
  // SAFE clears on ONE exercised statement per changed file, so a SAFE change can
  // still hold statements no test ran. The terminal gets the ratio; `--json` keeps
  // the full list. What it must never do is imply everything was proven.
  it('states the shortfall behind a SAFE verdict', () => {
    // Since ADR-11 the only shortfall a SAFE can carry is statements coverage.py
    // EXCLUDED, so the note names that cause rather than the old per-file rule.
    expect(
      formatCoverageSummary({
        tool: 'coverage.py',
        changedLinesCovered: true,
        uncovered: [{ file: 'a.py', line: 31, excluded: true }],
        changedStatements: { total: 40, covered: 12 },
        filesWithUncovered: 3,
      }),
    ).toBe(
      '  note: 12 of 40 changed statements were exercised; 28 could not be across 3 files ' +
        '(excluded from coverage). See --json for the list.',
    );
  });

  it('stays silent when every changed statement really did run', () => {
    expect(
      formatCoverageSummary({
        tool: 'coverage.py',
        changedLinesCovered: true,
        uncovered: [],
        changedStatements: { total: 2, covered: 2 },
      }),
    ).toBeNull();
  });

  it('stays silent when there is no ratio to report', () => {
    expect(
      formatCoverageSummary({ tool: 'none', changedLinesCovered: 'unknown', uncovered: [] }),
    ).toBeNull();
  });
});

describe('parseVerifyDiffFlags', () => {
  it('defaults repoRoot to "." with no flags', () => {
    expect(parseVerifyDiffFlags([])).toEqual({
      repoRoot: '.',
      diffPath: null,
      json: false,
      testCmd: null,
      mutate: false,
      flakyCheck: false,
      trusted: false,
    });
  });
  it('parses repoRoot + --diff + --json + --test-cmd', () => {
    expect(
      parseVerifyDiffFlags(['proj/', '--diff', 'c.patch', '--json', '--test-cmd', 'pytest -q']),
    ).toEqual({
      repoRoot: 'proj/',
      diffPath: 'c.patch',
      json: true,
      testCmd: 'pytest -q',
      mutate: false,
      flakyCheck: false,
      trusted: false,
    });
  });
  it('parses --diff= and --test-cmd= equals form', () => {
    expect(parseVerifyDiffFlags(['proj/', '--diff=c.patch', '--test-cmd=pytest -q'])).toEqual({
      repoRoot: 'proj/',
      diffPath: 'c.patch',
      json: false,
      testCmd: 'pytest -q',
      mutate: false,
      flakyCheck: false,
      trusted: false,
    });
  });
  it('parses --mutate', () => {
    expect(parseVerifyDiffFlags(['--mutate']).mutate).toBe(true);
  });
  it('parses --flaky-check', () => {
    expect(parseVerifyDiffFlags(['--flaky-check']).flakyCheck).toBe(true);
  });
  it('parses --trusted, and defaults it to false', () => {
    expect(parseVerifyDiffFlags(['--trusted']).trusted).toBe(true);
    expect(parseVerifyDiffFlags([]).trusted).toBe(false);
  });
  it('throws on unknown flag', () => {
    expect(() => parseVerifyDiffFlags(['--nope'])).toThrow(VerifyDiffFlagError);
  });
  it('throws on a second positional', () => {
    expect(() => parseVerifyDiffFlags(['a', 'b'])).toThrow(VerifyDiffFlagError);
  });
});

describe('formatTestFilesNote', () => {
  it('returns null when no test files changed', () => {
    expect(formatTestFilesNote([])).toBeNull();
  });
  it('names the count and the changed test files', () => {
    expect(formatTestFilesNote(['tests/test_make.py', 'foo.spec.ts'])).toBe(
      'note: this diff modifies test files (2): tests/test_make.py, foo.spec.ts',
    );
  });
  it('previews the first few and elides the rest', () => {
    expect(formatTestFilesNote(['a_test.py', 'b_test.py', 'c_test.py', 'd_test.py'])).toBe(
      'note: this diff modifies test files (4): a_test.py, b_test.py, c_test.py, ...',
    );
  });
});

describe('formatFlakyNote', () => {
  it('returns null when no tests flipped on retry', () => {
    expect(formatFlakyNote([])).toBeNull();
  });
  it('names the count and the flaky test ids', () => {
    expect(formatFlakyNote(['test_a.py::test_x', 'test_b.py::test_y'])).toBe(
      'note: 2 test(s) flipped on retry and were treated as flaky: test_a.py::test_x, test_b.py::test_y',
    );
  });
  it('previews the first few and elides the rest', () => {
    expect(formatFlakyNote(['t1::a', 't2::b', 't3::c', 't4::d'])).toBe(
      'note: 4 test(s) flipped on retry and were treated as flaky: t1::a, t2::b, t3::c, ...',
    );
  });
});

// Issue #110. Unlike the other notes, this one explains a VERDICT, so it has to
// name the signal that cost the reader their SAFE and tell them what to do.
describe('formatTestScopeNote', () => {
  it('is silent when the scope is absent or full', () => {
    expect(formatTestScopeNote(undefined)).toBeNull();
    expect(formatTestScopeNote({ scope: 'full', source: 'detected', signals: [] })).toBeNull();
    expect(formatTestScopeNote({ scope: 'full', source: 'override', signals: [] })).toBeNull();
  });

  it('is silent for a detected runner even if unknown: the engine chose it', () => {
    expect(formatTestScopeNote({ scope: 'unknown', source: 'detected', signals: [] })).toBeNull();
  });

  it('speaks up on an unparsed override rather than letting SAFE read as clean', () => {
    // `unknown` does not floor the verdict, so a SAFE here rests on a command we
    // could not parse. Silence would be the same mistake `coverage.unknownReason`
    // exists to prevent: a failed measurement reading as a clean one.
    const note = formatTestScopeNote({
      scope: 'unknown',
      source: 'override',
      signals: ['make is not a recognised test runner, so the scope is unknown'],
    });
    expect(note).toContain('could not determine');
    expect(note).toContain('make');
    expect(note).toContain('assumes it does');
  });

  it('names the signal and says the run cannot be SAFE', () => {
    const note = formatTestScopeNote({
      scope: 'narrowed',
      source: 'override',
      signals: ['selects specific paths: tests/test_scale.py'],
    });
    expect(note).toContain('tests/test_scale.py');
    expect(note).toContain('cannot be SAFE');
    expect(note).toContain('Re-run without the filter');
  });
});

describe('formatStabilityNote', () => {
  const base: StabilityResult = { ran: true, runs: 3, varied: [], inconclusive: 0 };
  it('returns null when the check was not requested', () => {
    expect(formatStabilityNote(undefined)).toBeNull();
  });
  it('returns null for a clean conclusive run (a confirmed varied test is in the reason)', () => {
    expect(formatStabilityNote(base)).toBeNull();
    expect(formatStabilityNote({ ...base, varied: ['tests/x.py::t'] })).toBeNull();
  });
  it('discloses when the check did not run', () => {
    const note = formatStabilityNote({
      ran: false,
      runs: 0,
      varied: [],
      inconclusive: 0,
      skippedReason: 'no test runner to rerun',
    });
    expect(note).toContain('did not run');
    expect(note).toContain('no test runner to rerun');
  });
  it('discloses when every rerun was inconclusive', () => {
    const note = formatStabilityNote({ ran: true, runs: 0, varied: [], inconclusive: 3 });
    expect(note).toContain('every rerun was inconclusive');
    expect(note).toContain('could have been missed');
  });
});
