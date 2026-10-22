// Client for the SymPy sidecar (sidecar/sympy_server.py). The sidecar never sees LaTeX: it is
// converted to mathjs syntax here, which only contains characters the sidecar also allows.

import { LatexError, latexToMathjs } from './math.ts';

export const SYMBOLIC_OPS = ['solve', 'factor', 'expand', 'simplify', 'derivative', 'integral', 'limit'] as const;
export type SymbolicOp = (typeof SYMBOLIC_OPS)[number];

export interface SymbolicRequest {
  op: SymbolicOp;
  latex: string;
  variable?: string;
  /** For limit: the value the variable approaches. For a definite integral: the bounds. */
  at?: string;
  from?: string;
  to?: string;
}

/** LaTeX bound or limit point -> mathjs text; also accepts "infinity" / "-infinity". */
function point(v: string | undefined): string | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const t = v.trim().replace(/\\infty|infinity|∞/gi, 'oo');
  return t === 'oo' || t === '-oo' || t === '+oo' ? t.replace('+', '') : latexToMathjs(t);
}

export async function symbolic(baseUrl: string, req: SymbolicRequest, timeoutMs = 8000): Promise<Record<string, unknown>> {
  const parts = req.latex.split('=');
  if (parts.length > 2) throw new LatexError('More than one "=" in the expression');
  const body = {
    op: req.op,
    expr: latexToMathjs(parts[0].trim()),
    rhs: parts.length === 2 ? latexToMathjs(parts[1].trim()) : undefined,
    var: req.variable,
    at: point(req.at),
    from: point(req.from),
    to: point(req.to),
  };
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, '')}/symbolic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { error: 'The symbolic engine is not running. Use check_equivalent or evaluate instead.' };
  }
  const out = (await res.json()) as Record<string, unknown>;
  return out.ok ? { result: out.latex, plain: out.result, variable: out.variable } : { error: out.error ?? `HTTP ${res.status}` };
}
