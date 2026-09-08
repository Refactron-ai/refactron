// src/verify/test-weakening.ts
//
// Issue #163. A diff can make a behavior change "pass" by relaxing the very tests
// that would catch it — removing an assertion, deleting a test, adding a skip. If
// the engine only ever runs the POST-diff suite, that reads green and, on the
// trusted path, SAFE. This detects the pattern so fuseVerdict can withhold SAFE.
//
// It DEGRADES only (SAFE -> UNPROVEN); it can never grant SAFE. It also cannot
// know intent — a legitimate behavior change updates its tests legitimately — so
// the signals are deliberately CONSERVATIVE (only clear weakening) and a false
// positive costs a false UNPROVEN (fail-safe), never a false SAFE. Net-additive
// test changes (new tests, new assertions) are strengthening and never flagged.

export interface WeakenedTest {
  file: string;
  reasons: string[];
}

/** Remove triple-quoted strings (docstrings), single-line strings, and `#`
 *  comments before counting. Without this, an `assert`-line parked inside a new
 *  docstring is counted as an assertion, so removing the REAL assertion nets zero
 *  and the weakening goes undetected (a ~2-line false-negative). Triple-quoted
 *  first, since it contains single quotes. Heuristic (nested quotes/escapes are
 *  imperfect), but it closes the docstring-mask evasion. */
function stripStringsAndComments(src: string): string {
  return src
    .replace(/"""[\s\S]*?"""/g, '')
    .replace(/'''[\s\S]*?'''/g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, '')
    .replace(/#.*$/gm, '');
}

/** pytest bare `assert` (line-anchored) plus unittest `self.assertX(...)` /
 *  `self.fail(`. Operates on already-stripped source (see stripStringsAndComments)
 *  so an `assert` inside a docstring or string does not count. */
function assertCount(stripped: string): number {
  const pytest = stripped.match(/^[ \t]*assert\b/gm)?.length ?? 0;
  const unittest = stripped.match(/\bself\.(assert\w+|fail)\s*\(/g)?.length ?? 0;
  return pytest + unittest;
}

/** Names of `def test_*` / `def test*` functions (and unittest test methods). */
function testFnNames(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/^[ \t]*def\s+(test\w*)\s*\(/gm)) out.add(m[1]!);
  return out;
}

/** skip / xfail markers that neutralize a test without removing it. */
function skipCount(src: string): number {
  let n = 0;
  n += src.match(/@\s*(?:pytest\.mark\.)?(?:skip|skipif|xfail)\b/g)?.length ?? 0;
  n += src.match(/\bpytest\.(?:skip|xfail)\s*\(/g)?.length ?? 0;
  n += src.match(/@\s*unittest\.skip\w*\b/g)?.length ?? 0;
  n += src.match(/\bself\.skipTest\s*\(/g)?.length ?? 0;
  n += src.match(/\bunittest\.SkipTest\b/g)?.length ?? 0;
  return n;
}

/** Classify each changed test file as weakened or not. A file with no `oldContent`
 *  is newly added (pure strengthening) and never flagged. */
export function detectTestWeakening(
  changes: Array<{ file: string; oldContent: string; newContent: string }>,
): WeakenedTest[] {
  const out: WeakenedTest[] = [];
  for (const { file, oldContent, newContent } of changes) {
    if (!oldContent) continue; // added test file — strengthening, never weakening
    const reasons: string[] = [];
    // Strip strings/comments once so a docstring-parked assert can't mask a real
    // one, then run every count on the stripped source.
    const oldSrc = stripStringsAndComments(oldContent);
    const newSrc = stripStringsAndComments(newContent);

    const oldA = assertCount(oldSrc);
    const newA = assertCount(newSrc);
    if (newA < oldA) reasons.push(`${oldA - newA} assertion(s) removed`);

    const oldNames = testFnNames(oldSrc);
    const newNames = testFnNames(newSrc);
    const deleted = [...oldNames].filter((n) => !newNames.has(n));
    if (deleted.length > 0)
      reasons.push(`test(s) deleted or renamed: ${deleted.slice(0, 5).join(', ')}`);

    const oldSkips = skipCount(oldSrc);
    const newSkips = skipCount(newSrc);
    if (newSkips > oldSkips) reasons.push(`${newSkips - oldSkips} skip/xfail marker(s) added`);

    if (reasons.length > 0) out.push({ file, reasons });
  }
  return out;
}
