// Loads the Desmos API and declares the small part of it we use.

export interface DesmosExpression {
  id: string;
  type?: string;
  latex?: string;
  text?: string;
  hidden?: boolean;
  color?: string;
  label?: string;
  showLabel?: boolean;
  lineStyle?: string;
  lineWidth?: number;
  lineOpacity?: number;
  pointSize?: number;
  secret?: boolean;
  readonly?: boolean;
  sliderBounds?: { min?: string; max?: string; step?: string };
}

export interface DesmosCalculator {
  getExpressions(): DesmosExpression[];
  setExpression(e: DesmosExpression): void;
  setExpressions(es: DesmosExpression[]): void;
  removeExpression(e: { id: string }): void;
  getState(): unknown;
  setState(state: unknown, opts?: { allowUndo?: boolean }): void;
  setBlank(): void;
  observeEvent(event: 'change', cb: () => void): void;
  unobserveEvent(event: 'change'): void;
  updateSettings(s: Record<string, unknown>): void;
  destroy(): void;
}

declare global {
  interface Window {
    Desmos?: {
      GraphingCalculator(el: HTMLElement, opts?: Record<string, unknown>): DesmosCalculator;
      Colors: Record<string, string>;
    };
  }
}

let loading: Promise<void> | null = null;

export function loadDesmos(apiKey: string, version: string): Promise<void> {
  if (window.Desmos) return Promise.resolve();
  if (!apiKey) return Promise.reject(new Error('DESMOS_API_KEY is not set in .env'));
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://www.desmos.com/api/${encodeURIComponent(version)}/calculator.js?apiKey=${encodeURIComponent(apiKey)}`;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load the Desmos API (offline, or a bad key?)'));
    document.head.appendChild(s);
  });
  return loading;
}

export function createCalculator(el: HTMLElement, opts: Record<string, unknown> = {}): DesmosCalculator {
  if (!window.Desmos) throw new Error('Desmos not loaded');
  return window.Desmos.GraphingCalculator(el, {
    keypad: true,
    expressionsCollapsed: false,
    settingsMenu: true,
    zoomButtons: true,
    ...opts,
  });
}
