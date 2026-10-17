// Types shared by the browser client, the server, and the simulate script.

export type Owner = 'student' | 'tutor';

/** One expression in the compact graph state the tutor sees. */
export interface CompactExpression {
  id: string;
  type: string; // 'expression' | 'text' | 'table' | ...
  latex: string;
  hidden: boolean;
  owner: Owner;
  /** Present when the expression is a slider-style assignment like `a=1`. */
  slider?: { name: string; value: number; min?: string; max?: string; step?: string };
  label?: string;
}

export interface CompactState {
  expressions: CompactExpression[];
}

export type DiffEntry =
  | { kind: 'added'; id: string; owner: Owner; latex: string }
  | { kind: 'removed'; id: string; owner: Owner; latex: string }
  | { kind: 'edited'; id: string; owner: Owner; from: string; to: string }
  | { kind: 'slider'; id: string; owner: Owner; name: string; from: number; to: number }
  | { kind: 'visibility'; id: string; owner: Owner; latex: string; hidden: boolean };

export interface StarterExpression {
  id?: string;
  latex: string;
  /** 'tutor' starters get a `tutor_` id and are locked (the tutor may not remove them either). */
  owner?: Owner;
  color?: string;
  lineStyle?: 'SOLID' | 'DASHED' | 'DOTTED';
  hidden?: boolean;
  /** Hide the latex in the expression list (the curve still shows). Used for targets. */
  secret?: boolean;
  readonly?: boolean;
  sliderBounds?: { min: string; max: string; step?: string };
}

export interface Problem {
  id: string;
  title: string;
  statement: string;
  goal: string;
  common_misconceptions: string[];
  hint_ladder: string[];
  starter_expressions?: StarterExpression[];
}

/** Something the tutor asks the client to do to the calculator. Only ever touches `tutor_` ids. */
export type TutorAction =
  | {
      kind: 'add';
      id: string;
      latex: string;
      color?: string;
      label?: string;
      lineStyle?: 'SOLID' | 'DASHED' | 'DOTTED';
    }
  | { kind: 'remove'; id: string }
  | { kind: 'highlight'; targetId: string; latex: string; tempId: string };

/** Server-sent events streamed to the client during a tutor turn. */
export type TurnEvent =
  | { type: 'token'; text: string }
  /** Discard the text streamed so far this turn (it turned out to be model reasoning). */
  | { type: 'reset' }
  | { type: 'action'; action: TutorAction }
  | { type: 'tool'; name: string; args: unknown; result: unknown }
  | { type: 'hint'; level: number; reason: string }
  | { type: 'progress'; skill: string; status: string; evidence: string }
  | { type: 'solved'; evidence: string }
  | { type: 'error'; message: string }
  | { type: 'done'; text: string };

export interface PublicConfig {
  desmosApiKey: string;
  desmosApiVersion: string;
  demoMode: boolean;
  nudgesEnabled: boolean;
  idleNudgeSeconds: number;
  googleSignIn: boolean;
}
