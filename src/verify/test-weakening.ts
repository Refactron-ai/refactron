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

/** pytest bare `assert` (line-anchored, so `assert` inside a string/comment is not
 *  counted) plus unittest `self.assertX(...)` / `self.fail(`. */
function assertCount(src: string): number {
  const pytest = src.match(/^[ \t]*assert\b/gm)?.length ?? 0;
  const unittest = src.match(/\bself\.(assert\w+|fail)\s*\(/g)?.length ?? 0;
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

    const oldA = assertCount(oldContent);
    const newA = assertCount(newContent);
    if (newA < oldA) reasons.push(`${oldA - newA} assertion(s) removed`);

    const oldNames = testFnNames(oldContent);
    const newNames = testFnNames(newContent);
    const deleted = [...oldNames].filter((n) => !newNames.has(n));
    if (deleted.length > 0)
      reasons.push(`test(s) deleted or renamed: ${deleted.slice(0, 5).join(', ')}`);

    const oldSkips = skipCount(oldContent);
    const newSkips = skipCount(newContent);
    if (newSkips > oldSkips) reasons.push(`${newSkips - oldSkips} skip/xfail marker(s) added`);

    if (reasons.length > 0) out.push({ file, reasons });
  }
  return out;
}
