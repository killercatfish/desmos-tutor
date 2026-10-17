import { describe, expect, it } from 'vitest';
import { LatexError, checkPoint, evaluateAt, latexToMathjs } from '../server/math.ts';

describe('latexToMathjs', () => {
  it.each([
    ['2x', '2*x'],
    ['x^{2}', 'x^(2)'],
    ['a\\left(x-h\\right)^{2}+k', 'a*(x-h)^(2)+k'],
    ['\\frac{1}{2}x', '((1)/(2))*x'],
    ['\\sqrt{x+1}', 'sqrt((x+1))'],
    ['2\\cdot3', '2*3'],
    ['\\left|x-2\\right|', 'abs(x-2)'],
    ['x\\left(x-1\\right)', 'x*(x-1)'],
    ['\\sin\\left(x\\right)', 'sin(x)'],
    ['a_{1}x', 'a_1*x'],
    ['-x^{2}', '-x^(2)'],
  ])('%s -> %s', (latex, expected) => {
    expect(latexToMathjs(latex)).toBe(expected);
  });

  it('rejects unknown commands', () => {
    expect(() => latexToMathjs('\\int x')).toThrow(LatexError);
  });

  it('rejects unbalanced brackets', () => {
    expect(() => latexToMathjs('\\left(x+1')).toThrow(LatexError);
  });
});

describe('evaluateAt', () => {
  it('evaluates y = ... forms', () => {
    expect(evaluateAt('y=2\\left(x-2\\right)^{2}-3', 0).value).toBe(5);
    expect(evaluateAt('y=-x^{2}+4', 3).value).toBe(-5);
  });

  it('uses slider values from the graph', () => {
    expect(evaluateAt('y=a\\left(x-h\\right)^{2}+k', 0, { a: 2, h: 2, k: -3 }).value).toBe(5);
  });

  it('handles f(x) =, = y and bare expressions', () => {
    expect(evaluateAt('f\\left(x\\right)=3x', 2).value).toBe(6);
    expect(evaluateAt('2x+1=y', 1).value).toBe(3);
    expect(evaluateAt('x^{2}', -3).value).toBe(9);
  });

  it('handles fractions and roots', () => {
    expect(evaluateAt('y=\\frac{1}{2}x+\\sqrt{9}', 4).value).toBe(5);
  });

  it('says which variable has no value', () => {
    expect(() => evaluateAt('y=ax^{2}', 1)).toThrow('"a" has no value');
  });

  it('refuses things that are not functions of x', () => {
    expect(() => evaluateAt('x^{2}+y^{2}=4', 1)).toThrow(LatexError);
  });
});

describe('checkPoint', () => {
  it('confirms (0,5) is on y = 2(x-2)^2 - 3 and not on y = (x-2)^2 - 3', () => {
    expect(checkPoint('y=2\\left(x-2\\right)^{2}-3', 0, 5)).toEqual({ on_curve: true, y_on_curve_at_x: 5 });
    expect(checkPoint('y=\\left(x-2\\right)^{2}-3', 0, 5)).toEqual({ on_curve: false, y_on_curve_at_x: 1 });
  });

  it('checks the vertex', () => {
    expect(checkPoint('y=2\\left(x-2\\right)^{2}-3', 2, -3).on_curve).toBe(true);
  });

  it('checks implicit equations', () => {
    expect(checkPoint('x^{2}+y^{2}=25', 3, 4).on_curve).toBe(true);
    expect(checkPoint('x^{2}+y^{2}=25', 3, 3).on_curve).toBe(false);
  });

  it('checks points against points', () => {
    expect(checkPoint('\\left(2,-3\\right)', 2, -3).on_curve).toBe(true);
    expect(checkPoint('(2,-3)', 2, 3).on_curve).toBe(false);
  });

  it('tolerates floating point', () => {
    expect(checkPoint('y=0.1x+0.2', 1, 0.3).on_curve).toBe(true);
  });

  it('checks a parallel line through (3, 4)', () => {
    expect(checkPoint('y=2x-2', 3, 4).on_curve).toBe(true);
    expect(checkPoint('y=2x+1', 3, 4).on_curve).toBe(false);
  });
});
