// src/verify/mutation.ts
// Opt-in, downgrade-only mutation of the changed statements (ADR-15, #116).
//
// SAFE proves a changed line executed, not that any test asserts on it. This
// perturbs each changed conditional/arithmetic/boolean operator in the shadow
// tree and reruns the suite: a mutant the suite still passes (SURVIVES) is a
// changed statement no test would notice, so the verdict cannot be SAFE.
//
// The only verdict move this can cause is SAFE -> UNPROVEN. A killed mutant, an
// inconclusive one, and mutation-not-requested all strengthen nothing.
import { execa } from 'execa';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRunner, type RunResult } from './runners/run.js';
import { CopyIsolationError } from './private-base.js';
import { detectRunner } from './runners/detect.js';
import type { ChangedRange } from './diff-input.js';

const SIDECAR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'checks/_py/mutate.py');

export interface SurvivingMutant {
  file: string;
  line: number;
  // The original source token, paired with `mutatedTo` as an orig->repl pair. An
  // operator (`<=`), a boolean name (`and`), OR a constant literal (`2`, `"hi"`,
  // `None`) since #149 — the field name predates constants but the slot has always
  // held the original token. Structured, not "+->-": statement-deletion (the
  // ADR-15 roadmap) has no orig->repl target and will add a `kind` discriminator
  // additively then, which a constant does not need.
  operator: string;
  mutatedTo: string;
}

// The mutation half of the verdict evidence, a sibling of CoverageAssessment on
// the report — a distinct tool (mutate.py + suite reruns), not coverage.py, so
// it does not live under `tool: 'coverage.py'`. `ran` false with a skippedReason
// means the deep check did not conclude; a clean SAFE must disclose that rather
// than read as a full sweep.
export interface MutationResult {
  ran: boolean;
  survivors: SurvivingMutant[];
  tested: number;
  killed: number;
  inconclusive: number;
  truncated?: { tested: number; total: number };
  skippedReason?: string;
}

export interface Mutant {
  line: number;
  col: number;
  endCol: number;
  orig: string;
  repl: string;
  op: string;
  // "operator" or "constant" (#149). The budget is filled operators-first so a
  // constant never evicts a higher-signal operator mutant past the cap. Absent
  // (older sidecar / unrecognised) is treated as non-constant, i.e. kept first.
  kind?: string;
}

export interface MutationInput {
  shadowRoot: string;
  ranges: ChangedRange[];
  testCmd?: string;
  pythonBin?: string;
  timeoutMs?: number;
  budget?: number;
}

const DEFAULT_BUDGET = 40;

/** Recursively delete `__pycache__` directories so no run reads a stale .pyc.
 *  Best-effort: a failure to remove one only risks a fail-safe false UNPROVEN. */
async function removePycache(root: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const child = path.join(root, e.name);
    if (e.name === '__pycache__') {
      await fs.rm(child, { recursive: true, force: true }).catch(() => {});
    } else if (e.name !== '.git' && e.name !== 'node_modules') {
      await removePycache(child);
    }
  }
}

async function mutantsFor(file: string, lines: number[], pythonBin: string): Promise<Mutant[]> {
  try {
    const r = await execa(pythonBin, [SIDECAR], {
      input: JSON.stringify({ path: file, changed_lines: lines }),
      timeout: 30_000,
      reject: false,
    });
    if (r.exitCode !== 0) return [];
    const parsed = JSON.parse(r.stdout) as Mutant[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Replace the mutant's operator in `content`, or null if the source at that
 *  span no longer matches — a guard against mutating a file the numbers do not
 *  describe, which would produce a meaningless survivor. Exported for the guard
 *  test; a regression here could manufacture a bogus survivor (false UNPROVEN). */
export function applyMutant(content: string, m: Mutant): string | null {
  const lines = content.split('\n');
  const idx = m.line - 1;
  if (idx < 0 || idx >= lines.length) return null;
  const line = lines[idx]!;
  if (line.slice(m.col, m.endCol) !== m.orig) return null;
  lines[idx] = line.slice(0, m.col) + m.repl + line.slice(m.endCol);
  return lines.join('\n');
}

export async function runMutation(input: MutationInput): Promise<MutationResult> {
  const empty: MutationResult = {
    ran: false,
    survivors: [],
    tested: 0,
    killed: 0,
    inconclusive: 0,
  };
  const pythonBin = input.pythonBin ?? 'python3';
  const budget = input.budget ?? DEFAULT_BUDGET;

  const spec = await detectRunner(input.shadowRoot, {
    ...(input.testCmd ? { override: input.testCmd } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });
  if (spec === null) return { ...empty, skippedReason: 'no test runner to mutate against' };

  // Every run compiles from source, not a stale .pyc. The gates and coverage
  // runs already wrote __pycache__ into the shadow; without this a mutant
  // re-imported within the same second reads the ORIGINAL cached bytecode, the
  // mutation vanishes, and it is misread as a survivor (a false UNPROVEN).
  // DONTWRITEBYTECODE stops new caches; the sweep removes the pre-existing ones.
  await removePycache(input.shadowRoot);
  const runOpts = { envAdd: { PYTHONDONTWRITEBYTECODE: '1' } };

  // A mutant is only meaningful against a GREEN baseline: kill vs survive is
  // defined by whether a mutant BREAKS a passing suite. If the plain suite is
  // not green here, mutation is inconclusive and must not downgrade.
  let baseline: RunResult;
  try {
    baseline = await runRunner(spec, runOpts);
  } catch (err) {
    if (err instanceof CopyIsolationError) return { ...empty, skippedReason: err.message };
    throw err;
  }
  if (baseline.exitCode !== 0) {
    return { ...empty, skippedReason: 'baseline suite is not green under the plain test command' };
  }

  const all: Array<{ file: string; m: Mutant }> = [];
  for (const range of input.ranges) {
    if (range.lines.length === 0 || !range.path.endsWith('.py')) continue;
    const abs = path.resolve(input.shadowRoot, range.path);
    for (const m of await mutantsFor(abs, range.lines, pythonBin)) {
      all.push({ file: range.path, m });
    }
  }
  if (all.length === 0)
    return {
      ...empty,
      ran: true,
      skippedReason: 'no mutable operators or constants in the changed statements',
    };

  // Operators before constants (#149): constants are far more numerous and have a
  // higher equivalent-mutant rate, so a flat positional cap would let a constant
  // evict a higher-signal operator mutant a smaller diff would have tested. A
  // stable partition keeps token order within each group.
  const ordered = [
    ...all.filter((x) => x.m.kind !== 'constant'),
    ...all.filter((x) => x.m.kind === 'constant'),
  ];
  const chosen = ordered.slice(0, budget);
  const survivors: SurvivingMutant[] = [];
  let killed = 0;
  let inconclusive = 0;

  for (const { file, m } of chosen) {
    const abs = path.resolve(input.shadowRoot, file);
    let original: string;
    try {
      original = await fs.readFile(abs, 'utf8');
    } catch {
      inconclusive += 1;
      continue;
    }
    const mutated = applyMutant(original, m);
    if (mutated === null) {
      inconclusive += 1;
      continue;
    }
    try {
      await fs.writeFile(abs, mutated);
      const r = await runRunner(spec, runOpts);
      if (r.timedOut) inconclusive += 1;
      else if (r.exitCode === 0)
        survivors.push({ file, line: m.line, operator: m.orig, mutatedTo: m.repl });
      else killed += 1;
    } catch {
      inconclusive += 1;
    } finally {
      await fs.writeFile(abs, original);
    }
  }

  const result: MutationResult = {
    ran: true,
    survivors,
    tested: chosen.length,
    killed,
    inconclusive,
  };
  if (all.length > budget) result.truncated = { tested: budget, total: all.length };
  return result;
}
