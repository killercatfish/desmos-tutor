// Watches the calculator, snapshots it about 1.5 s after the last change, and reports diffs.

import { compactState, diffStates } from '../../shared/diff.ts';
import type { CompactState, DiffEntry } from '../../shared/types.ts';
import type { DesmosCalculator } from './desmos.ts';

export interface Snapshot {
  state: CompactState;
  diffs: DiffEntry[];
  desmosState: unknown;
}

export class GraphObserver {
  private last: CompactState | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private calc: DesmosCalculator,
    private onSnapshot: (s: Snapshot) => unknown,
    private debounceMs = 1500,
  ) {}

  start(): void {
    this.last = null;
    this.calc.observeEvent('change', () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.flush(), this.debounceMs);
    });
  }

  stop(): void {
    this.calc.unobserveEvent('change');
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Take a snapshot now (used before a tutor turn so the tutor sees the latest graph). */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const state = compactState(this.calc.getExpressions());
    const diffs = diffStates(this.last, state);
    if (diffs.length === 0) return;
    this.last = state;
    await this.onSnapshot({ state, diffs, desmosState: this.calc.getState() });
  }
}
