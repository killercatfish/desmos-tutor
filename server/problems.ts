import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TUTOR_PREFIX } from '../shared/guard.ts';
import type { Problem } from '../shared/types.ts';

export function loadProblems(dir: string): Map<string, Problem> {
  const out = new Map<string, Problem>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const p = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Problem;
    for (const key of ['id', 'title', 'statement', 'goal'] as const) {
      if (typeof p[key] !== 'string') throw new Error(`${file}: missing "${key}"`);
    }
    p.common_misconceptions ??= [];
    p.hint_ladder ??= [];
    p.starter_expressions = (p.starter_expressions ?? []).map((s, i) => {
      const owner = s.owner ?? 'student';
      let id = s.id ?? `${owner === 'tutor' ? TUTOR_PREFIX : 's_'}starter_${i}`;
      if (owner === 'tutor' && !id.startsWith(TUTOR_PREFIX)) id = TUTOR_PREFIX + id;
      if (owner === 'student' && id.startsWith(TUTOR_PREFIX)) throw new Error(`${file}: student starter "${id}" can't use the tutor prefix`);
      return { ...s, id, owner };
    });
    out.set(p.id, p);
  }
  return out;
}

/** Tutor-owned starter ids: the tutor may not remove or overwrite these. */
export function lockedIds(p: Problem): Set<string> {
  return new Set((p.starter_expressions ?? []).filter((s) => s.owner === 'tutor').map((s) => s.id!));
}

/** The student-facing problem: no goal, misconceptions, hints, or secret latex. */
export function publicProblem(p: Problem) {
  return {
    id: p.id,
    title: p.title,
    statement: p.statement,
    starter_expressions: p.starter_expressions,
  };
}
