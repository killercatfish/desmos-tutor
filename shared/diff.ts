// Compact graph state and the diff between two snapshots.

import { TUTOR_PREFIX } from './guard.ts';
import type { CompactExpression, CompactState, DiffEntry, Owner } from './types.ts';

/** The subset of a Desmos expression state we read (calculator.getExpressions()). */
export interface RawExpression {
  id: string;
  type?: string;
  latex?: string;
  text?: string;
  hidden?: boolean;
  label?: string;
  sliderBounds?: { min?: string; max?: string; step?: string };
}

const SLIDER_RE = /^\s*([a-zA-Z](?:_\{?[a-zA-Z0-9]+\}?)?)\s*=\s*(-?\d+(?:\.\d+)?|-?\.\d+)\s*$/;

export function ownerOf(id: string): Owner {
  return id.startsWith(TUTOR_PREFIX) ? 'tutor' : 'student';
}

/** `a=1` -> { name: 'a', value: 1 }. Anything that isn't a plain number assignment -> null. */
export function parseSlider(latex: string): { name: string; value: number } | null {
  const m = latex.match(SLIDER_RE);
  if (!m) return null;
  return { name: m[1].replace(/[{}]/g, ''), value: Number(m[2]) };
}

export function compactState(raw: RawExpression[]): CompactState {
  const expressions: CompactExpression[] = [];
  for (const e of raw) {
    const latex = (e.type === 'text' ? e.text : e.latex) ?? '';
    if (e.type !== 'text' && latex.trim() === '') continue; // empty rows aren't interesting
    const c: CompactExpression = {
      id: String(e.id),
      type: e.type ?? 'expression',
      latex,
      hidden: Boolean(e.hidden),
      owner: ownerOf(String(e.id)),
    };
    const s = e.type === 'expression' || e.type === undefined ? parseSlider(latex) : null;
    if (s) c.slider = { ...s, min: e.sliderBounds?.min, max: e.sliderBounds?.max, step: e.sliderBounds?.step };
    if (e.label) c.label = e.label;
    expressions.push(c);
  }
  return { expressions };
}

export function diffStates(prev: CompactState | null, next: CompactState): DiffEntry[] {
  const before = new Map((prev?.expressions ?? []).map((e) => [e.id, e]));
  const after = new Map(next.expressions.map((e) => [e.id, e]));
  const out: DiffEntry[] = [];

  for (const [id, e] of after) {
    const old = before.get(id);
    if (!old) {
      out.push({ kind: 'added', id, owner: e.owner, latex: e.latex });
      continue;
    }
    if (old.latex !== e.latex) {
      const a = parseSlider(old.latex);
      const b = parseSlider(e.latex);
      if (a && b && a.name === b.name) out.push({ kind: 'slider', id, owner: e.owner, name: b.name, from: a.value, to: b.value });
      else out.push({ kind: 'edited', id, owner: e.owner, from: old.latex, to: e.latex });
    }
    if (old.hidden !== e.hidden) out.push({ kind: 'visibility', id, owner: e.owner, latex: e.latex, hidden: e.hidden });
  }
  for (const [id, e] of before) {
    if (!after.has(id)) out.push({ kind: 'removed', id, owner: e.owner, latex: e.latex });
  }
  return out;
}

export function describeDiff(d: DiffEntry): string {
  const who = d.owner === 'tutor' ? 'tutor ' : '';
  switch (d.kind) {
    case 'added':
      return `${who}added ${d.latex}`;
    case 'removed':
      return `${who}removed ${d.latex}`;
    case 'edited':
      return `${who}changed ${d.from} -> ${d.to}`;
    case 'slider':
      return `${who}changed ${d.name}: ${d.from} -> ${d.to}`;
    case 'visibility':
      return `${who}${d.hidden ? 'hid' : 'showed'} ${d.latex}`;
  }
}

/** Student-made changes only; tutor cues don't count as the student "doing something". */
export function studentDiffs(diffs: DiffEntry[]): DiffEntry[] {
  return diffs.filter((d) => d.owner === 'student');
}
