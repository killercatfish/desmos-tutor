// The tutor must never edit, delete or hide a student expression. These tests try,
// at each layer: the shared guard, the server's tool host, the browser's canvas, and a
// full tutor turn driven by a model that misbehaves on purpose.

import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { assertActionAllowed, GuardError, isTutorId } from '../shared/guard.ts';
import { compactState } from '../shared/diff.ts';
import { TutorCanvas } from '../web/src/canvas.ts';
import { createToolHost } from '../server/tools.ts';
import { SessionStore } from '../server/sessions.ts';
import { runTutorTurn } from '../server/tutor.ts';
import { loadProblems } from '../server/problems.ts';
import type { LlmClient, LlmEvent, ToolCall } from '../server/llm.ts';
import type { TurnEvent } from '../shared/types.ts';

const root = resolve(import.meta.dirname, '..');
const problems = loadProblems(resolve(root, 'problems'));

const studentGraph = () =>
  compactState([
    { id: '1', type: 'expression', latex: 'y=\\left(x-2\\right)^{2}-3' },
    { id: '2', type: 'expression', latex: 'a=1' },
    { id: 'tutor_target', type: 'expression', latex: 'y=-x^{2}' },
  ]);

describe('shared guard', () => {
  const state = studentGraph();
  const locked = new Set(['tutor_target']);

  it('only accepts tutor_ ids', () => {
    expect(isTutorId('tutor_1')).toBe(true);
    expect(isTutorId('1')).toBe(false);
    expect(isTutorId('tutor_')).toBe(false);
    expect(isTutorId('Tutor_1')).toBe(false);
  });

  it('refuses to remove a student expression', () => {
    expect(() => assertActionAllowed({ kind: 'remove', id: '1' }, state)).toThrow(GuardError);
  });

  it('refuses to overwrite a student expression by reusing its id', () => {
    expect(() => assertActionAllowed({ kind: 'add', id: '1', latex: 'y=0' }, state)).toThrow(GuardError);
  });

  it('refuses to redefine a name the student uses', () => {
    expect(() => assertActionAllowed({ kind: 'add', id: 'tutor_9', latex: 'a=5' }, state)).toThrow(/already defined/);
  });

  it('refuses to touch locked problem expressions', () => {
    expect(() => assertActionAllowed({ kind: 'remove', id: 'tutor_target' }, state, locked)).toThrow(/locked/);
    expect(() => assertActionAllowed({ kind: 'add', id: 'tutor_target', latex: 'y=0' }, state, locked)).toThrow(/locked/);
  });

  it('refuses to highlight a slider (a copy would define it twice)', () => {
    expect(() => assertActionAllowed({ kind: 'highlight', targetId: '2', latex: 'a=1', tempId: 'tutor_hl_1' }, state)).toThrow(GuardError);
  });

  it('allows adding, removing and highlighting with tutor ids', () => {
    expect(() => assertActionAllowed({ kind: 'add', id: 'tutor_5', latex: '(2,-3)' }, state)).not.toThrow();
    expect(() => assertActionAllowed({ kind: 'remove', id: 'tutor_5' }, state)).not.toThrow();
    expect(() => assertActionAllowed({ kind: 'highlight', targetId: '1', latex: 'y=x', tempId: 'tutor_hl_2' }, state)).not.toThrow();
  });
});

describe('browser canvas', () => {
  function fakeCalc() {
    return {
      getExpressions: () => [
        { id: '1', type: 'expression', latex: 'y=x^{2}' },
        { id: '2', type: 'expression', latex: 'a=1' },
      ],
      setExpression: vi.fn(),
      removeExpression: vi.fn(),
    };
  }

  it('never calls the calculator for a student id', () => {
    const calc = fakeCalc();
    const canvas = new TutorCanvas(calc);
    expect(() => canvas.apply({ kind: 'remove', id: '1' })).toThrow(GuardError);
    expect(() => canvas.apply({ kind: 'add', id: '2', latex: 'a=-3' })).toThrow(GuardError);
    expect(calc.removeExpression).not.toHaveBeenCalled();
    expect(calc.setExpression).not.toHaveBeenCalled();
  });

  it('applies tutor actions', () => {
    const calc = fakeCalc();
    new TutorCanvas(calc).apply({ kind: 'add', id: 'tutor_1', latex: '(2,-3)', label: 'vertex' });
    expect(calc.setExpression).toHaveBeenCalledWith({ id: 'tutor_1', latex: '(2,-3)', label: 'vertex', showLabel: true });
  });
});

describe('server tool host', () => {
  const setup = () => {
    const s = new SessionStore().create(problems.get('c-slider-match')!, 'test');
    s.state = studentGraph();
    const emitted: TurnEvent[] = [];
    const host = createToolHost(() => new Set(['tutor_target']));
    const call = (name: string, args: unknown): Promise<any> => host.execute(s, { id: 'x', name, args, rawArgs: JSON.stringify(args) }, (e) => emitted.push(e));
    return { s, emitted, call, actions: () => emitted.filter((e) => e.type === 'action') };
  };

  it('refuses to delete a student expression and sends nothing to the browser', async () => {
    const { s, call, actions } = setup();
    const r = await call('remove_tutor_expression', { id: '1' });
    expect(r.error).toMatch(/only remove its own/);
    expect(actions()).toEqual([]);
    expect(s.state.expressions.map((e) => e.id)).toContain('1');
  });

  it('refuses to overwrite a student expression via a chosen id', async () => {
    const { call, actions } = setup();
    expect((await call('add_tutor_expression', { id: '1', latex: 'y=2(x-2)^2-3' })).error).toBeDefined();
    expect((await call('add_tutor_expression', { latex: 'a=2' })).error).toMatch(/already defined/);
    expect(actions()).toEqual([]);
  });

  it('gives new cues tutor ids', async () => {
    const { call, actions } = setup();
    const r = await call('add_tutor_expression', { latex: '(2,-3)', line_style: 'dashed' });
    expect(r).toEqual({ ok: true, id: 'tutor_1' });
    expect(actions()).toEqual([{ type: 'action', action: { kind: 'add', id: 'tutor_1', latex: '(2,-3)', color: undefined, label: undefined, lineStyle: 'DASHED' } }]);
  });

  it('uses slider values in math checks', async () => {
    const { s, call } = setup();
    s.state.expressions.push({ id: '3', type: 'expression', latex: 'y=a\\left(x-h\\right)^{2}+k', hidden: false, owner: 'student' });
    s.state.expressions.push(...compactState([{ id: '4', latex: 'h=2' }, { id: '5', latex: 'k=-3' }]).expressions);
    s.state.expressions.find((e) => e.id === '2')!.slider = { name: 'a', value: 2 };
    expect(await call('check_point_on_expression', { expression_id: '3', x: 0, y: 5 })).toMatchObject({ on_curve: true });
  });
});

describe('a full turn with a model that tries to delete student work', () => {
  it('refuses, and the student expression survives', async () => {
    const s = new SessionStore().create(problems.get('a-quadratic-vertex')!, 'test');
    s.state = studentGraph();
    s.chat.push({ role: 'student', text: 'just fix my graph for me', ts: Date.now() });

    let round = 0;
    const evil: LlmClient = {
      describe: 'fake',
      toolMode: () => 'native',
      async *stream(): AsyncGenerator<LlmEvent> {
        round++;
        if (round === 1) {
          const calls: ToolCall[] = [
            { id: 'c1', name: 'remove_tutor_expression', args: { id: '1' }, rawArgs: '' },
            { id: 'c2', name: 'add_tutor_expression', args: { id: '1', latex: 'y=2\\left(x-2\\right)^{2}-3' }, rawArgs: '' },
          ];
          for (const call of calls) yield { type: 'tool_call', call };
        } else {
          yield { type: 'text', text: 'What does the number in front of the parentheses do?' };
        }
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    const events: TurnEvent[] = [];
    const text = await runTutorTurn(
      s,
      { kind: 'chat', text: 'just fix my graph for me' },
      { llm: evil, tools: createToolHost(() => new Set()), promptPath: resolve(root, 'prompts/tutor_system.md') },
      (e) => events.push(e),
      new Set(),
    );
    expect(events.filter((e) => e.type === 'action')).toEqual([]);
    const toolResults = events.filter((e) => e.type === 'tool') as { result: { error?: string } }[];
    expect(toolResults.every((t) => t.result.error)).toBe(true);
    expect(s.state.expressions.find((e) => e.id === '1')?.latex).toBe('y=\\left(x-2\\right)^{2}-3');
    expect(text).toBe('What does the number in front of the parentheses do?');
  });
});
