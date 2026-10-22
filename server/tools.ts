// The tutor's tools: the definitions the model sees and the code that runs them.
// Graph actions pass through the shared tutor-id guard here on the server, and again in
// the browser before they reach the calculator.

import { assertActionAllowed, GuardError, isTutorId, TUTOR_PREFIX } from '../shared/guard.ts';
import { ownerOf } from '../shared/diff.ts';
import type { TurnEvent, TutorAction } from '../shared/types.ts';
import type { ToolCall, ToolSpec } from './llm.ts';
import { checkEquivalent, checkPoint, evaluateAt, LatexError, type Scope } from './math.ts';
import { symbolic, SYMBOLIC_OPS, type SymbolicOp } from './symbolic.ts';
import type { LiveSession } from './sessions.ts';
import type { ToolHost } from './tutor.ts';

export const SKILL_STATUSES = ['emerging', 'developing', 'secure'] as const;

const exprRef = {
  latex: { type: 'string', description: 'LaTeX of the curve, e.g. "y=2\\left(x-2\\right)^{2}-3"' },
  expression_id: { type: 'string', description: 'Or: the id of an expression on the graph (its slider values are used)' },
};

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'add_tutor_expression',
    description:
      'Draw a visual cue on the student\'s graph: a point like "(2,-3)", a dashed line, or a new slider. Never draw the answer curve. Returns the new id.',
    parameters: {
      type: 'object',
      properties: {
        latex: { type: 'string', description: 'Desmos LaTeX, e.g. "(2,-3)" or "x=2"' },
        color: { type: 'string', description: 'Hex color, e.g. "#2d70b3" (optional)' },
        label: { type: 'string', description: 'Short label shown next to a point (optional)' },
        line_style: { type: 'string', enum: ['solid', 'dashed', 'dotted'] },
        id: { type: 'string', description: `Optional id; must start with "${TUTOR_PREFIX}"` },
      },
      required: ['latex'],
    },
  },
  {
    name: 'highlight',
    description: "Briefly pulse one of the student's curves or points so they know which one you mean. Doesn't change it.",
    parameters: { type: 'object', properties: { expression_id: { type: 'string' } }, required: ['expression_id'] },
  },
  {
    name: 'remove_tutor_expression',
    description: `Remove a cue you added earlier (id starts with "${TUTOR_PREFIX}").`,
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'advance_hint_level',
    description: 'Unlock the next hint on the ladder. Only after the student has made a genuine attempt and is still stuck.',
    parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
  },
  {
    name: 'mark_progress',
    description: 'Record (silently, for the teacher) where the student is on a skill, with the evidence you saw.',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Short skill name, e.g. "vertex form: reading h and k"' },
        status: { type: 'string', enum: [...SKILL_STATUSES] },
        evidence: { type: 'string' },
      },
      required: ['skill', 'status', 'evidence'],
    },
  },
  {
    name: 'mark_solved',
    description: 'Record that the student has solved the problem AND explained why it works.',
    parameters: { type: 'object', properties: { evidence: { type: 'string' } }, required: ['evidence'] },
  },
  {
    name: 'check_point_on_expression',
    description: 'Check exactly whether the point (x, y) lies on a curve. Use before telling a student a point is or isn\'t on their graph.',
    parameters: {
      type: 'object',
      properties: { ...exprRef, x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y'],
    },
  },
  {
    name: 'evaluate',
    description: 'Evaluate y at a given x for a curve y = f(x). Use instead of doing arithmetic yourself.',
    parameters: { type: 'object', properties: { ...exprRef, x: { type: 'number' } }, required: ['x'] },
  },
  {
    name: 'check_equivalent',
    description:
      "Check whether a student's algebra step is valid. Give two expressions (\"2\\left(x+3\\right)\" and \"2x+6\"), two equations (same solutions?), or one equation to test as an identity. Use this before telling a student a step is right or wrong; never judge a step yourself.",
    parameters: {
      type: 'object',
      properties: {
        before: { type: 'string', description: 'LaTeX: the expression or equation before the step (or one equation alone)' },
        after: { type: 'string', description: 'LaTeX: the expression or equation after the step (optional)' },
      },
      required: ['before'],
    },
  },
];

const SYMBOLIC_SPEC: ToolSpec = {
  name: 'symbolic',
  description:
    'Exact symbolic math for YOUR reasoning only: solve, factor, expand, simplify, derivative, integral, limit. Never paste the result to the student; use it to decide which question to ask next.',
  parameters: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: [...SYMBOLIC_OPS] },
      latex: { type: 'string', description: 'LaTeX expression, or an equation for solve, e.g. "2x^{2}-8x+5=0"' },
      variable: { type: 'string', description: 'Variable to solve for / differentiate by (default x)' },
      at: { type: 'string', description: 'For limit: the value approached, e.g. "0" or "infinity"' },
      from: { type: 'string', description: 'For a definite integral: lower bound' },
      to: { type: 'string', description: 'For a definite integral: upper bound' },
    },
    required: ['op', 'latex'],
  },
};

/** Hooks for recording what happened (the event log, skill marks, solved status). */
export interface ToolRecorder {
  toolCall?(s: LiveSession, name: string, args: unknown, result: unknown): void;
  hint?(s: LiveSession, level: number, reason: string): void;
  skill?(s: LiveSession, skill: string, status: string, evidence: string): void;
  solved?(s: LiveSession, evidence: string): void;
}

const LINE_STYLES = { solid: 'SOLID', dashed: 'DASHED', dotted: 'DOTTED' } as const;

function str(v: unknown, max = 500): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

function numArg(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** Slider values on the graph, e.g. { a: 2, h: 2, k: -3 }. */
export function sliderScope(s: LiveSession): Scope {
  const scope: Scope = {};
  for (const e of s.state.expressions) if (e.slider) scope[e.slider.name] = e.slider.value;
  return scope;
}

export interface ToolOptions {
  /** SymPy sidecar URL; when empty the `symbolic` tool is not offered. */
  sympyUrl?: string;
}

export function createToolHost(locked: (s: LiveSession) => Set<string>, rec: ToolRecorder = {}, opts: ToolOptions = {}): ToolHost {
  const specs = opts.sympyUrl ? [...TOOL_SPECS, SYMBOLIC_SPEC] : TOOL_SPECS;

  async function run(s: LiveSession, call: ToolCall, emit: (e: TurnEvent) => void): Promise<unknown> {
    const a = (call.args ?? {}) as Record<string, unknown>;
    if (call.args === undefined) return { error: 'Arguments were not valid JSON' };

    const act = (action: TutorAction): unknown => {
      try {
        assertActionAllowed(action, s.state, locked(s));
      } catch (e) {
        if (e instanceof GuardError) return { error: e.message };
        throw e;
      }
      emit({ type: 'action', action });
      // Keep the server's picture current until the browser's next snapshot arrives.
      if (action.kind === 'add') {
        s.state.expressions = s.state.expressions.filter((e) => e.id !== action.id);
        s.state.expressions.push({ id: action.id, type: 'expression', latex: action.latex, hidden: false, owner: ownerOf(action.id) });
      } else if (action.kind === 'remove') {
        s.state.expressions = s.state.expressions.filter((e) => e.id !== action.id);
      }
      return { ok: true, ...(action.kind === 'add' ? { id: action.id } : {}) };
    };

    const resolveLatex = (): string => {
      const id = str(a.expression_id, 100);
      if (id) {
        const e = s.state.expressions.find((x) => x.id === id);
        if (!e) throw new LatexError(`No expression "${id}" on the graph`);
        return e.latex;
      }
      const latex = str(a.latex);
      if (!latex) throw new LatexError('Give latex or expression_id');
      return latex;
    };

    switch (call.name) {
      case 'add_tutor_expression': {
        const latex = str(a.latex, 300);
        if (!latex) return { error: 'latex is required' };
        let id = str(a.id, 60);
        if (id === undefined) {
          do id = `${TUTOR_PREFIX}${s.nextTutorId++}`;
          while (s.state.expressions.some((e) => e.id === id));
        }
        const style = str(a.line_style)?.toLowerCase() as keyof typeof LINE_STYLES | undefined;
        return act({
          kind: 'add',
          id,
          latex,
          color: str(a.color, 20)?.match(/^#[0-9a-fA-F]{3,8}$/) ? str(a.color, 20) : undefined,
          label: str(a.label, 60),
          lineStyle: style ? LINE_STYLES[style] : undefined,
        });
      }
      case 'remove_tutor_expression': {
        const id = str(a.id, 60) ?? '';
        if (!isTutorId(id)) return act({ kind: 'remove', id }); // the guard produces the refusal
        if (!s.state.expressions.some((e) => e.id === id)) return { error: `No tutor expression "${id}" on the graph` };
        return act({ kind: 'remove', id });
      }
      case 'highlight': {
        const targetId = str(a.expression_id, 100) ?? '';
        const target = s.state.expressions.find((e) => e.id === targetId);
        return act({ kind: 'highlight', targetId, latex: target?.latex ?? '', tempId: `${TUTOR_PREFIX}hl_${s.nextTutorId++}` });
      }
      case 'advance_hint_level': {
        const reason = str(a.reason) ?? '(no reason given)';
        if (s.hintLevel >= s.problem.hint_ladder.length) return { error: 'Already at the last hint', level: s.hintLevel };
        s.hintLevel++;
        rec.hint?.(s, s.hintLevel, reason);
        emit({ type: 'hint', level: s.hintLevel, reason });
        return { ok: true, level: s.hintLevel, hint: s.problem.hint_ladder[s.hintLevel - 1] };
      }
      case 'mark_progress': {
        const skill = str(a.skill, 120);
        const status = str(a.status)?.toLowerCase();
        const evidence = str(a.evidence) ?? '';
        if (!skill || !SKILL_STATUSES.includes(status as (typeof SKILL_STATUSES)[number])) {
          return { error: `skill and status (${SKILL_STATUSES.join('|')}) are required` };
        }
        rec.skill?.(s, skill, status!, evidence);
        emit({ type: 'progress', skill, status: status!, evidence });
        return { ok: true };
      }
      case 'mark_solved': {
        const evidence = str(a.evidence) ?? '';
        s.solved = true;
        rec.solved?.(s, evidence);
        emit({ type: 'solved', evidence });
        return { ok: true };
      }
      case 'check_point_on_expression':
      case 'evaluate': {
        const x = numArg(a.x);
        const y = numArg(a.y);
        if (x === undefined || (call.name === 'check_point_on_expression' && y === undefined)) return { error: 'x (and y) must be numbers' };
        try {
          const latex = resolveLatex();
          return call.name === 'evaluate'
            ? { latex, x, y: evaluateAt(latex, x, sliderScope(s)).value }
            : { latex, x, y, ...checkPoint(latex, x, y!, sliderScope(s)) };
        } catch (e) {
          if (e instanceof LatexError) return { error: e.message };
          throw e;
        }
      }
      case 'check_equivalent': {
        const before = str(a.before);
        if (!before) return { error: 'before is required' };
        try {
          return checkEquivalent(before, str(a.after));
        } catch (e) {
          if (e instanceof LatexError) return { error: e.message };
          throw e;
        }
      }
      case 'symbolic': {
        if (!opts.sympyUrl) return { error: `Unknown tool "${call.name}"` };
        const op = str(a.op)?.toLowerCase() as SymbolicOp | undefined;
        const latex = str(a.latex);
        if (!op || !SYMBOLIC_OPS.includes(op) || !latex) return { error: `op (${SYMBOLIC_OPS.join('|')}) and latex are required` };
        try {
          return await symbolic(opts.sympyUrl, { op, latex, variable: str(a.variable, 20), at: str(a.at, 60), from: str(a.from, 60), to: str(a.to, 60) });
        } catch (e) {
          if (e instanceof LatexError) return { error: e.message };
          throw e;
        }
      }
      default:
        return { error: `Unknown tool "${call.name}"` };
    }
  }

  return {
    specs: () => specs,
    async execute(s, call, emit) {
      let result: unknown;
      try {
        result = await run(s, call, emit);
      } catch (e) {
        result = { error: `Tool failed: ${(e as Error).message}` };
      }
      rec.toolCall?.(s, call.name, call.args, result);
      emit({ type: 'tool', name: call.name, args: call.args, result });
      return result;
    },
  };
}
