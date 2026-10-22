// End-to-end through the HTTP API with a scripted fake model and an in-memory database.

import { describe, expect, it } from 'vitest';
import { buildApp } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
import { TutorDb } from '../server/db.ts';
import { compactState, diffStates } from '../shared/diff.ts';
import type { LlmClient, LlmEvent } from '../server/llm.ts';

function scriptedLlm(rounds: LlmEvent[][]): LlmClient {
  let i = 0;
  return {
    describe: 'scripted',
    toolMode: () => 'native',
    async *stream() {
      yield* rounds[Math.min(i++, rounds.length - 1)];
    },
  };
}

const config = (env: Record<string, string> = {}) => loadConfig({ LLM_BASE_URL: 'http://localhost:8080/v1', ...env });

function sse(body: string) {
  return body
    .split('\n\n')
    .filter((c) => c.startsWith('data: '))
    .map((c) => JSON.parse(c.slice(6)));
}

describe('API', () => {
  it('logs a session: graph diffs, chat, tool calls, hint level, and serves the teacher timeline', async () => {
    const db = new TutorDb(':memory:');
    const llm = scriptedLlm([
      [
        { type: 'tool_call', call: { id: 'a', name: 'check_point_on_expression', args: { expression_id: '1', x: 0, y: 5 }, rawArgs: '' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text', text: 'Your curve misses (0, 5). What could change that?' },
        { type: 'tool_call', call: { id: 'b', name: 'advance_hint_level', args: { reason: 'tried a=1' }, rawArgs: '' } },
        { type: 'tool_call', call: { id: 'c', name: 'add_tutor_expression', args: { latex: '(2,-3)', label: 'vertex' }, rawArgs: '' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
    ]);
    const { app } = buildApp(config(), { llm, db, logger: false });

    const created = (await app.inject({ method: 'POST', url: '/api/sessions', payload: { problemId: 'a-quadratic-vertex', nickname: 'Pat <b>' } })).json();
    expect(created.nickname).toBe('Pat b');
    expect(created.problem.goal).toBeUndefined(); // teacher-only fields stay on the server

    const state = compactState([{ id: '1', type: 'expression', latex: 'y=\\left(x-2\\right)^{2}-3' }]);
    const g = await app.inject({ method: 'POST', url: `/api/sessions/${created.id}/graph`, payload: { state, diffs: diffStates(null, state), desmosState: { v: 1 } } });
    expect(g.statusCode).toBe(200);

    const turn = await app.inject({ method: 'POST', url: `/api/sessions/${created.id}/turn`, payload: { kind: 'chat', text: 'is this right?' } });
    const events = sse(turn.body);
    expect(events.map((e) => e.type)).toEqual(['token', 'action', 'done']);
    expect(events[1].action).toMatchObject({ kind: 'add', id: 'tutor_1', latex: '(2,-3)' });

    const t = (await app.inject({ method: 'GET', url: `/api/teacher/sessions/${created.id}` })).json();
    expect(t.events.map((e: { kind: string }) => e.kind)).toEqual(['graph', 'student_message', 'tool_call', 'hint', 'tool_call', 'tool_call', 'tutor_message']);
    expect(t.events[2].payload.result).toMatchObject({ on_curve: false, y_on_curve_at_x: 1 });
    expect(t.events[0].payload.desmos_state).toEqual({ v: 1 });
    expect(t.session.hint_level).toBe(1);

    const list = (await app.inject({ method: 'GET', url: '/api/teacher/sessions' })).json();
    expect(list[0]).toMatchObject({ id: created.id, student_messages: 1, graph_events: 1 });
  });

  it('picks the session back up after a server restart', async () => {
    const db = new TutorDb(':memory:');
    const first = buildApp(config(), { llm: scriptedLlm([[{ type: 'text', text: 'Hi!' }]]), db, logger: false });
    const { id } = (await first.app.inject({ method: 'POST', url: '/api/sessions', payload: { problemId: 'a-quadratic-vertex' } })).json();
    const state = compactState([{ id: '1', type: 'expression', latex: 'y=x^{2}' }, { id: 'tutor_3', type: 'expression', latex: '(2,-3)' }]);
    await first.app.inject({ method: 'POST', url: `/api/sessions/${id}/graph`, payload: { state, diffs: diffStates(null, state), desmosState: {} } });

    const second = buildApp(config(), { llm: scriptedLlm([[{ type: 'text', text: 'Back.' }]]), db, logger: false });
    const turn = await second.app.inject({ method: 'POST', url: `/api/sessions/${id}/turn`, payload: { kind: 'chat', text: 'hello?' } });
    expect(sse(turn.body).at(-1)).toEqual({ type: 'done', text: 'Back.' });
    expect(second.sessions.get(id)!.state.expressions).toHaveLength(2);
    expect(second.sessions.get(id)!.nextTutorId).toBe(4);
  });

  it('demo mode ignores typed nicknames', async () => {
    const { app } = buildApp(config({ LLM_BASE_URL: 'https://openrouter.ai/api/v1' }), { llm: scriptedLlm([]), db: new TutorDb(':memory:'), logger: false });
    expect((await app.inject({ method: 'GET', url: '/api/config' })).json().demoMode).toBe(true);
    const s = (await app.inject({ method: 'POST', url: '/api/sessions', payload: { problemId: 'b-parallel-line', nickname: 'Jane Smith' } })).json();
    expect(s.nickname).not.toContain('Jane');
    expect(s.nickname).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ \d{2}$/);
  });

  it('refuses nudges when they are off', async () => {
    const { app } = buildApp(config(), { llm: scriptedLlm([]), db: new TutorDb(':memory:'), logger: false });
    const { id } = (await app.inject({ method: 'POST', url: '/api/sessions', payload: { problemId: 'a-quadratic-vertex' } })).json();
    const r = await app.inject({ method: 'POST', url: `/api/sessions/${id}/turn`, payload: { kind: 'nudge', reason: 'idle' } });
    expect(r.statusCode).toBe(400);
  });
});
