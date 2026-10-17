import { describe, expect, it } from 'vitest';
import { compactState, describeDiff, diffStates, parseSlider, studentDiffs } from '../shared/diff.ts';

const state = (...exprs: { id: string; latex: string; hidden?: boolean; type?: string }[]) =>
  compactState(exprs.map((e) => ({ type: 'expression', ...e })));

describe('compactState', () => {
  it('tags owners by id and skips empty rows', () => {
    const s = state({ id: '1', latex: 'y=x^2' }, { id: '2', latex: '' }, { id: 'tutor_1', latex: '(2,-3)' });
    expect(s.expressions.map((e) => [e.id, e.owner])).toEqual([
      ['1', 'student'],
      ['tutor_1', 'tutor'],
    ]);
  });

  it('reads slider values', () => {
    const s = compactState([{ id: '3', type: 'expression', latex: 'a=-2.5', sliderBounds: { min: '-5', max: '5' } }]);
    expect(s.expressions[0].slider).toMatchObject({ name: 'a', value: -2.5, min: '-5', max: '5' });
  });

  it('keeps text notes', () => {
    const s = compactState([{ id: '4', type: 'text', text: 'my guess' }]);
    expect(s.expressions[0]).toMatchObject({ type: 'text', latex: 'my guess' });
  });
});

describe('parseSlider', () => {
  it.each([
    ['a=1', { name: 'a', value: 1 }],
    ['k = -0.5', { name: 'k', value: -0.5 }],
    ['a_{1}=3', { name: 'a_1', value: 3 }],
    ['y=2x+1', null],
    ['a=b+1', null],
    ['x=3', { name: 'x', value: 3 }],
  ])('%s', (latex, expected) => {
    expect(parseSlider(latex)).toEqual(expected);
  });
});

describe('diffStates', () => {
  it('treats everything as added from nothing', () => {
    const d = diffStates(null, state({ id: '1', latex: 'y=-x^2+4' }));
    expect(d.map(describeDiff)).toEqual(['added y=-x^2+4']);
  });

  it('reports slider moves by name', () => {
    const d = diffStates(state({ id: '2', latex: 'a=1' }), state({ id: '2', latex: 'a=-2' }));
    expect(d).toEqual([{ kind: 'slider', id: '2', owner: 'student', name: 'a', from: 1, to: -2 }]);
    expect(describeDiff(d[0])).toBe('changed a: 1 -> -2');
  });

  it('reports edits, removals and visibility', () => {
    const before = state({ id: '1', latex: 'y=x^2' }, { id: '2', latex: 'y=3' }, { id: '3', latex: '(1,1)' });
    const after = state({ id: '1', latex: 'y=(x-2)^2' }, { id: '3', latex: '(1,1)', hidden: true });
    expect(diffStates(before, after).map(describeDiff)).toEqual(['changed y=x^2 -> y=(x-2)^2', 'hid (1,1)', 'removed y=3']);
  });

  it('a renamed assignment is an edit, not a slider move', () => {
    const d = diffStates(state({ id: '2', latex: 'a=1' }), state({ id: '2', latex: 'b=1' }));
    expect(d[0].kind).toBe('edited');
  });

  it('reports nothing when nothing changed', () => {
    const s = state({ id: '1', latex: 'y=x' });
    expect(diffStates(s, state({ id: '1', latex: 'y=x' }))).toEqual([]);
  });

  it('marks tutor changes and filters them out of student diffs', () => {
    const d = diffStates(state({ id: '1', latex: 'y=x' }), state({ id: '1', latex: 'y=x' }, { id: 'tutor_1', latex: '(2,-3)' }));
    expect(describeDiff(d[0])).toBe('tutor added (2,-3)');
    expect(studentDiffs(d)).toEqual([]);
  });
});
