// The only code path by which the tutor touches the calculator. Every action goes
// through the shared guard first, so a bad id from the server can't edit student work.

import { assertActionAllowed } from '../../shared/guard.ts';
import { compactState } from '../../shared/diff.ts';
import type { StarterExpression, TutorAction } from '../../shared/types.ts';
import type { DesmosCalculator, DesmosExpression } from './desmos.ts';

const HIGHLIGHT_MS = 1800;

export class TutorCanvas {
  constructor(
    private calc: Pick<DesmosCalculator, 'getExpressions' | 'setExpression' | 'removeExpression'>,
    private locked: Set<string> = new Set(),
  ) {}

  setLocked(ids: Set<string>): void {
    this.locked = ids;
  }

  apply(action: TutorAction): void {
    assertActionAllowed(action, compactState(this.calc.getExpressions()), this.locked);
    switch (action.kind) {
      case 'add': {
        const e: DesmosExpression = { id: action.id, latex: action.latex };
        if (action.color) e.color = action.color;
        if (action.lineStyle) e.lineStyle = action.lineStyle;
        if (action.label) {
          e.label = action.label;
          e.showLabel = true;
        }
        this.calc.setExpression(e);
        return;
      }
      case 'remove':
        this.calc.removeExpression({ id: action.id });
        return;
      case 'highlight': {
        // Draw a thick translucent copy on top, then take it away. The original is untouched.
        this.calc.setExpression({ id: action.tempId, latex: action.latex, color: '#fa7e19', lineWidth: 9, lineOpacity: 0.45, pointSize: 22 });
        setTimeout(() => this.calc.removeExpression({ id: action.tempId }), HIGHLIGHT_MS);
        return;
      }
    }
  }
}

/** Problem setup. Not a tutor action: this is the starting graph, student starters included. */
export function starterToDesmos(s: StarterExpression): DesmosExpression {
  const e: DesmosExpression = { id: s.id!, latex: s.latex };
  if (s.color) e.color = s.color;
  if (s.lineStyle) e.lineStyle = s.lineStyle;
  if (s.hidden) e.hidden = true;
  if (s.secret) e.secret = true;
  if (s.readonly) e.readonly = true;
  if (s.sliderBounds) e.sliderBounds = s.sliderBounds;
  return e;
}
