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

  it('flags a deleted (or renamed) test function', () => {
    const r = one(
      'test_a.py',
      'def test_x():\n    assert f() == 1\n\n\ndef test_y():\n    assert g() == 2\n',
      'def test_x():\n    assert f() == 1\n',
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.reasons.join(' ')).toContain('test_y');
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
});
