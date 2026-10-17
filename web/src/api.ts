import type { PublicConfig, StarterExpression, TurnEvent } from '../../shared/types.ts';
import type { Snapshot } from './observer.ts';

export interface PublicProblem {
  id: string;
  title: string;
  statement: string;
  starter_expressions?: StarterExpression[];
}

export interface SessionInfo {
  id: string;
  nickname: string;
  problem: PublicProblem;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

export const getConfig = () => fetch('/api/config').then((r) => json<PublicConfig>(r));
export const getProblems = () => fetch('/api/problems').then((r) => json<PublicProblem[]>(r));

export function createSession(problemId: string, nickname?: string): Promise<SessionInfo> {
  return fetch('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ problemId, nickname }),
  }).then((r) => json<SessionInfo>(r));
}

export function postGraph(sessionId: string, snap: Snapshot): Promise<unknown> {
  return fetch(`/api/sessions/${sessionId}/graph`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(snap),
  }).then((r) => json(r));
}

/** Starts a tutor turn and yields its server-sent events as they stream in. */
export async function* runTurn(
  sessionId: string,
  body: { kind: 'chat'; text: string } | { kind: 'nudge'; reason: string },
): AsyncGenerator<TurnEvent> {
  const res = await fetch(`/api/sessions/${sessionId}/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (data) yield JSON.parse(data) as TurnEvent;
    }
  }
}
