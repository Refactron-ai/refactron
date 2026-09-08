// tests/unit/verify/test-weakening.test.ts
// Unit coverage for the pure weakening detector (#163). Conservative by design:
// only clear weakening flags; anything net-additive or ambiguous does not.
import { describe, it, expect } from 'vitest';
import { detectTestWeakening } from '../../../src/verify/test-weakening.js';

const one = (file: string, oldContent: string, newContent: string) =>
  detectTestWeakening([{ file, oldContent, newContent }]);

describe('detectTestWeakening', () => {
  it('flags a removed assertion', () => {
    const r = one('test_a.py', 'def test_x():\n    assert f() == 1\n', 'def test_x():\n    f()\n');
    expect(r).toHaveLength(1);
    expect(r[0]!.reasons.join(' ')).toContain('assertion');
  });

  it('flags a deleted test function', () => {
    const r = one(
      'test_a.py',
      'def test_x():\n    assert f() == 1\n\n\ndef test_y():\n    assert g() == 2\n',
      'def test_x():\n    assert f() == 1\n',
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.reasons.join(' ')).toContain('test_y');
  });

  it('flags a renamed test function (the old identity is gone)', () => {
    const r = one(
      'test_a.py',
      'def test_login_denies_bad_pw():\n    assert login("x") is False\n',
      'def test_login():\n    assert login("x") is False\n',
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.reasons.join(' ')).toContain('test_login_denies_bad_pw');
  });

  it('flags an added skip/xfail marker', () => {
    const r = one(
      'test_a.py',
      'def test_x():\n    assert f() == 1\n',
      'import pytest\n\n\n@pytest.mark.skip\ndef test_x():\n    assert f() == 1\n',
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.reasons.join(' ')).toContain('skip');
  });

  it('counts unittest self.assertX as assertions', () => {
    const r = one(
      'test_a.py',
      'class T(TestCase):\n    def test_x(self):\n        self.assertEqual(f(), 1)\n',
      'class T(TestCase):\n    def test_x(self):\n        f()\n',
    );
    expect(r).toHaveLength(1);
  });

  it('does NOT flag a net-additive change (strengthening)', () => {
    const r = one(
      'test_a.py',
      'def test_x():\n    assert f() == 1\n',
      'def test_x():\n    assert f() == 1\n    assert g() == 2\n',
    );
    expect(r).toEqual([]);
  });

  it('does NOT flag a rewrite that keeps the assertion count', () => {
    const r = one(
      'test_a.py',
      'def test_x():\n    assert f() == 1\n',
      'def test_x():\n    result = f()\n    assert result == 1\n',
    );
    expect(r).toEqual([]);
  });

  it('does NOT flag a newly-added test file (no old content)', () => {
    const r = one('test_new.py', '', 'def test_x():\n    pass\n');
    expect(r).toEqual([]);
  });

  // Docstring-mask (test-eng Finding 1): removing the real assertion and parking an
  // `assert` line inside a docstring must NOT net to zero. Strings are stripped
  // before counting, so this is flagged.
  it('does not let a docstring assert line mask a removed real assertion', () => {
    const r = one(
      'test_a.py',
      'def test_x():\n    assert f() == 1\n',
      'def test_x():\n    """\n    assert f() == 1\n    """\n    f()\n',
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.reasons.join(' ')).toContain('assertion');
  });

  // Skip/xfail/fail marker families (test-eng Finding 4) — each is live in the
  // detector; pin one per family so a regex regression can't ship silently.
  it.each([
    ['xfail', '@pytest.mark.xfail\ndef test_x():\n    assert f() == 1\n'],
    ['skipif', '@pytest.mark.skipif(True, reason="x")\ndef test_x():\n    assert f() == 1\n'],
    ['imperative pytest.skip', 'def test_x():\n    pytest.skip("x")\n    assert f() == 1\n'],
    ['unittest @skip', '@unittest.skip("x")\ndef test_x(self):\n    self.assertTrue(f())\n'],
    ['self.skipTest', 'def test_x(self):\n    self.skipTest("x")\n    self.assertTrue(f())\n'],
  ])('flags an added %s marker', (_label, neutered) => {
    const original = neutered
      .replace(/@[^\n]+\n/, '')
      .replace(/^\s*(pytest\.skip|self\.skipTest)[^\n]+\n/m, '');
    const r = one('test_a.py', original, neutered);
    expect(r).toHaveLength(1);
  });

  it('flags a removed unittest self.fail (counts as an assertion)', () => {
    const r = one(
      'test_a.py',
      'def test_x(self):\n    if bad():\n        self.fail("boom")\n',
      'def test_x(self):\n    bad()\n',
    );
    expect(r).toHaveLength(1);
  });

  // KNOWN NEGATIVES (ADR-21): count-preserving evasions a line-count heuristic
  // cannot catch without per-test coverage / AST semantics. Pinned so the suite
  // does NOT imply coverage it lacks. These are degrade-MISSES (they leave the
  // pre-#163 SAFE), never new false SAFEs; the follow-up issues track closing them.
  it('KNOWN LIMIT: file-global compensation is not caught (see ADR-21)', () => {
    const r = one(
      'test_a.py',
      'def test_a():\n    assert f() == 1\n\n\ndef test_b():\n    assert g() == 2\n',
      // covering assert removed from test_a, an extra assert padded into test_b:
      'def test_a():\n    f()\n\n\ndef test_b():\n    assert g() == 2\n    assert g() == 2\n',
    );
    expect(r).toEqual([]); // documented gap, not a guarantee
  });

  it('KNOWN LIMIT: semantic loosening (== 5 -> >= 0) is not caught (see ADR-21)', () => {
    const r = one(
      'test_a.py',
      'def test_x():\n    assert f() == 5\n',
      'def test_x():\n    assert f() >= 0\n',
    );
    expect(r).toEqual([]); // same count, weaker meaning — out of scope for the v1 heuristic
  });
});
