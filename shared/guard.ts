// The tutor-id guard. The tutor may only create, change or remove expressions whose
// id starts with `tutor_`. Student expressions are never edited, deleted or hidden.
// This is checked on the server before an action is sent, and again in the browser
// before anything touches the calculator.

import type { CompactState, TutorAction } from './types.ts';

export const TUTOR_PREFIX = 'tutor_';

export function isTutorId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith(TUTOR_PREFIX) && id.length > TUTOR_PREFIX.length;
}

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardError';
  }
}

/** Names a latex string defines, e.g. `a=1` -> ['a'], `f(x)=x^2` -> ['f']. `y=`/`x=` define nothing. */
export function definedNames(latex: string): string[] {
  const m = latex.trim().match(/^([a-zA-Z](?:_\{?[a-zA-Z0-9]+\}?)?)\s*(\\left\()?(\([^)]*\))?\s*=/);
  if (!m) return [];
  const name = m[1].replace(/[{}]/g, '');
  if (name === 'y' || name === 'x') return [];
  return [name];
}

/**
 * Throws GuardError if the action would touch anything but the tutor's own expressions.
 * `locked` lists tutor-owned ids the problem set up (like a target curve) that the tutor
 * may not remove either.
 */
export function assertActionAllowed(action: TutorAction, state: CompactState, locked: Set<string> = new Set()): void {
  switch (action.kind) {
    case 'add': {
      if (!isTutorId(action.id)) throw new GuardError(`Tutor may only create expressions with ids starting "${TUTOR_PREFIX}" (got "${action.id}")`);
      if (locked.has(action.id)) throw new GuardError(`"${action.id}" is locked by the problem`);
      if (typeof action.latex !== 'string' || action.latex.length === 0 || action.latex.length > 300) {
        throw new GuardError('latex must be a non-empty string of at most 300 characters');
      }
      // Defining a name the student already uses would break their expression ("defined twice").
      const studentNames = new Set(
        state.expressions.filter((e) => e.owner === 'student').flatMap((e) => definedNames(e.latex)),
      );
      for (const name of definedNames(action.latex)) {
        if (studentNames.has(name)) throw new GuardError(`"${name}" is already defined by the student; pick another name`);
      }
      return;
    }
    case 'remove': {
      if (!isTutorId(action.id)) throw new GuardError(`Tutor may only remove its own expressions (got "${action.id}")`);
      if (locked.has(action.id)) throw new GuardError(`"${action.id}" is locked by the problem`);
      return;
    }
    case 'highlight': {
      // Highlight never touches the target: it draws a temporary tutor copy on top.
      if (!isTutorId(action.tempId)) throw new GuardError('highlight copy must have a tutor id');
      const target = state.expressions.find((e) => e.id === action.targetId);
      if (!target) throw new GuardError(`No expression "${action.targetId}" on the graph`);
      // A copy of `a=1` would define `a` twice and break the student's graph.
      if (definedNames(target.latex).length > 0 || target.type !== 'expression') {
        throw new GuardError(`"${action.targetId}" can't be highlighted (it defines a name or isn't a curve/point); refer to it in words instead`);
      }
      return;
    }
    default:
      throw new GuardError('Unknown action');
  }
}
