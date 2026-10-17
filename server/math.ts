// Server-side math checks the tutor calls instead of doing arithmetic in its head.
// Converts the LaTeX Desmos produces into a mathjs expression with explicit
// multiplication, then evaluates it with the graph's slider values in scope.

import { create, all, type MathNode } from 'mathjs';

const math = create(all, {});

const FUNCTIONS: Record<string, string> = {
  sin: 'sin', cos: 'cos', tan: 'tan', sec: 'sec', csc: 'csc', cot: 'cot',
  arcsin: 'asin', arccos: 'acos', arctan: 'atan',
  sinh: 'sinh', cosh: 'cosh', tanh: 'tanh',
  ln: 'log', log: 'log10', exp: 'exp', abs: 'abs', sqrt: 'sqrt',
  floor: 'floor', ceil: 'ceil', round: 'round', sign: 'sign', min: 'min', max: 'max',
};
const CONSTANTS: Record<string, string> = { pi: 'pi', theta: 'theta', tau: 'tau', e: 'e' };

export class LatexError extends Error {}

type Tok =
  | { t: 'num'; v: string }
  | { t: 'id'; v: string }
  | { t: 'fn'; v: string }
  | { t: 'cmd'; v: 'frac' | 'sqrt' }
  | { t: 'op'; v: string }
  | { t: '{' | '}' | '(' | ')' | '[' | ']' | '^' | ',' | 'abs(' | 'abs)' };

function tokenize(latex: string): Tok[] {
  let s = latex
    .replace(/\\\\/g, '\\') // a doubled backslash from over-escaped JSON
    .replace(/\\left\|/g, '\u0001')
    .replace(/\\right\|/g, '\u0002')
    .replace(/\\left|\\right/g, '')
    .replace(/\\cdot|\\times/g, '*')
    .replace(/\\div/g, '/')
    .replace(/\\[,;: !]|\\ /g, ' ')
    .replace(/\\operatorname\{([a-zA-Z]+)\}/g, '\\$1');
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') { i++; continue; }
    if (c === '\u0001') { out.push({ t: 'abs(' }); i++; continue; }
    if (c === '\u0002') { out.push({ t: 'abs)' }); i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = s.slice(i).match(/^(\d+\.?\d*|\.\d+)/)!;
      out.push({ t: 'num', v: m[1] });
      i += m[1].length;
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      // A single letter, optionally with a subscript: a_{1} -> a_1, a_b -> a_b
      const m = s.slice(i).match(/^([a-zA-Z])(?:_\{([a-zA-Z0-9]+)\}|_([a-zA-Z0-9]))?/)!;
      const sub = m[2] ?? m[3];
      out.push({ t: 'id', v: sub ? `${m[1]}_${sub}` : m[1] });
      i += m[0].length;
      continue;
    }
    if (c === '\\') {
      const m = s.slice(i + 1).match(/^[a-zA-Z]+/);
      if (!m) throw new LatexError(`Unexpected "\\" at ${i}`);
      const name = m[0];
      i += 1 + name.length;
      if (name === 'frac' || name === 'sqrt') out.push({ t: 'cmd', v: name });
      else if (FUNCTIONS[name]) out.push({ t: 'fn', v: FUNCTIONS[name] });
      else if (CONSTANTS[name]) out.push({ t: 'id', v: CONSTANTS[name] });
      else if (name === 'le' || name === 'ge' || name === 'lt' || name === 'gt') throw new LatexError('Inequalities are not supported');
      else throw new LatexError(`Unsupported LaTeX command \\${name}`);
      continue;
    }
    if ('{}()[]^,'.includes(c)) { out.push({ t: c as '{' }); i++; continue; }
    if ('+-*/'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    if (c === '=' || c === '<' || c === '>') throw new LatexError('Split equations before converting');
    throw new LatexError(`Unexpected character "${c}"`);
  }
  return out;
}

/** Recursive converter: returns mathjs source with every multiplication written out. */
class Converter {
  private i = 0;
  constructor(private toks: Tok[]) {}

  run(): string {
    const s = this.seq(null);
    if (this.i < this.toks.length) throw new LatexError('Unbalanced brackets');
    return s;
  }

  private peek(): Tok | undefined {
    return this.toks[this.i];
  }

  /** A sequence up to a closing token. Inserts `*` between adjacent operands. */
  private seq(close: Tok['t'] | null): string {
    let out = '';
    let prevOperand = false;
    while (this.i < this.toks.length) {
      const tok = this.peek()!;
      if (close && tok.t === close) {
        this.i++;
        return out;
      }
      if (tok.t === '}' || tok.t === ')' || tok.t === ']' || tok.t === 'abs)') throw new LatexError('Unbalanced brackets');
      if (tok.t === 'op') {
        out += tok.v;
        this.i++;
        prevOperand = false;
        continue;
      }
      if (tok.t === ',') {
        out += ',';
        this.i++;
        prevOperand = false;
        continue;
      }
      if (tok.t === '^') {
        this.i++;
        out += '^' + this.atom();
        prevOperand = true;
        continue;
      }
      const a = this.atom();
      out += (prevOperand ? '*' : '') + a;
      prevOperand = true;
    }
    if (close) throw new LatexError('Unbalanced brackets');
    return out;
  }

  /** One operand: number, variable, bracketed group, fraction, root or function call. */
  private atom(): string {
    const tok = this.toks[this.i++];
    if (!tok) throw new LatexError('Expression ends too early');
    switch (tok.t) {
      case 'num':
      case 'id':
        return tok.v;
      case '{':
      case '(':
        return `(${this.seq(tok.t === '{' ? '}' : ')')})`;
      case '[':
        return `(${this.seq(']')})`;
      case 'abs(':
        return `abs(${this.seq('abs)')})`;
      case 'cmd':
        if (tok.v === 'frac') {
          const num = this.atom();
          const den = this.atom();
          return `(${num}/${den})`;
        }
        if (this.peek()?.t === '[') {
          this.i++;
          const n = this.seq(']');
          return `nthRoot(${this.atom()},${n})`;
        }
        return `sqrt(${this.atom()})`;
      case 'fn': {
        // \sin^{2}x is rare in student work; not supported.
        const next = this.peek();
        if (next?.t === '(') {
          this.i++;
          return `${tok.v}(${this.seq(')')})`;
        }
        return `${tok.v}(${this.atom()})`;
      }
      case 'op':
        if (tok.v === '-' || tok.v === '+') return `(${tok.v}${this.atom()})`;
        throw new LatexError(`Unexpected "${tok.v}"`);
      default:
        throw new LatexError(`Unexpected "${tok.t}"`);
    }
  }
}

export function latexToMathjs(latex: string): string {
  if (latex.length > 500) throw new LatexError('Expression too long');
  return new Converter(tokenize(latex)).run();
}

/** Split at a single top-level `=`. */
function splitEquation(latex: string): [string, string] | null {
  const parts = latex.split('=');
  if (parts.length === 1) return null;
  if (parts.length > 2) throw new LatexError('More than one "=" in the expression');
  return [parts[0].trim(), parts[1].trim()];
}

const FUNC_LHS = /^[a-zA-Z](?:_\{?[a-zA-Z0-9]+\}?)?(?:\\left)?\(\s*x\s*(?:\\right)?\)$/;

/** Normalizes `y=…`, `f(x)=…`, `…=y` and bare expressions to "y as a function of x", if it is one. */
function asFunctionOfX(latex: string): string | null {
  const eq = splitEquation(latex);
  if (!eq) return latex;
  const [l, r] = eq;
  if (l === 'y' || FUNC_LHS.test(l)) return r;
  if (r === 'y') return l;
  return null;
}

export type Scope = Record<string, number>;

function compile(src: string): (scope: Scope) => number {
  let node: MathNode;
  try {
    node = math.parse(src);
  } catch (e) {
    throw new LatexError(`Could not parse: ${(e as Error).message}`);
  }
  const code = node.compile();
  return (scope) => {
    let v: unknown;
    try {
      v = code.evaluate({ ...scope });
    } catch (e) {
      const msg = (e as Error).message;
      const m = msg.match(/Undefined symbol (\w+)/);
      throw new LatexError(m ? `"${m[1]}" has no value on the graph` : msg);
    }
    if (typeof v !== 'number') throw new LatexError('Result is not a real number');
    return v;
  };
}

const round = (n: number) => (Number.isFinite(n) ? Math.round(n * 1e9) / 1e9 : n);

export function evaluateAt(latex: string, x: number, scope: Scope = {}): { value: number; mathjs: string } {
  const f = asFunctionOfX(latex);
  if (f === null) throw new LatexError('Not a function of x (expected y = ..., f(x) = ..., or an expression in x)');
  const src = latexToMathjs(f);
  return { value: round(compile(src)({ ...scope, x })), mathjs: src };
}

export interface PointCheck {
  on_curve: boolean;
  /** For curves y = f(x): f(x) at the given x, to compare with the given y. */
  y_on_curve_at_x?: number;
  left_side?: number;
  right_side?: number;
}

export function checkPoint(latex: string, x: number, y: number, scope: Scope = {}): PointCheck {
  const point = latex.match(/^\s*(?:\\left)?\(([^,]+),([^)]+?)(?:\\right)?\)\s*$/);
  if (point) {
    const px = compile(latexToMathjs(point[1]))(scope);
    const py = compile(latexToMathjs(point[2]))(scope);
    return { on_curve: close(px, x) && close(py, y), left_side: round(px), right_side: round(py) };
  }
  const f = asFunctionOfX(latex);
  if (f !== null) {
    const v = compile(latexToMathjs(f))({ ...scope, x });
    return { on_curve: close(v, y), y_on_curve_at_x: round(v) };
  }
  const [l, r] = splitEquation(latex)!;
  const s = { ...scope, x, y };
  const lv = compile(latexToMathjs(l))(s);
  const rv = compile(latexToMathjs(r))(s);
  return { on_curve: close(lv, rv), left_side: round(lv), right_side: round(rv) };
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}
