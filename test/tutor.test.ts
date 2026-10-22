// A tutor turn whose model reply comes back empty (a thinking model can spend its whole token
// budget thinking): the turn asks once more instead of leaving the student with silence.

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { createToolHost } from '../server/tools.ts';
import { SessionStore } from '../server/sessions.ts';
import { runTutorTurn } from '../server/tutor.ts';
import { loadProblems } from '../server/problems.ts';
import type { ChatMsg, LlmClient, LlmEvent } from '../server/llm.ts';

const root = resolve(import.meta.dirname, '..');
const problems = loadProblems(resolve(root, 'problems'));

function fakeModel(replies: (string | null)[]): LlmClient & { seen: ChatMsg[][] } {
  const seen: ChatMsg[][] = [];
  return {
    seen,
    describe: 'fake',
    toolMode: () => 'native',
    async *stream({ messages }): AsyncGenerator<LlmEvent> {
      seen.push([...messages]);
      const r = replies[seen.length - 1];
      if (r) yield { type: 'text', text: r };
      yield { type: 'done', finishReason: r ? 'stop' : 'length' };
    },
  };
}

async function turn(llm: LlmClient, empties: unknown[]) {
  const s = new SessionStore().create(problems.get('a-quadratic-vertex')!, 'test');
  s.chat.push({ role: 'student', text: 'i guessed 2', ts: Date.now() });
  return runTutorTurn(
    s,
    { kind: 'chat', text: 'i guessed 2' },
    { llm, tools: createToolHost(() => new Set()), promptPath: resolve(root, 'prompts/tutor_system.md'), onEmpty: (i) => empties.push(i) },
    () => {},
    new Set(),
  );
}

describe('empty model replies', () => {
  it('asks the model once more and logs why', async () => {
    const llm = fakeModel([null, 'What happens when you plug in x = 0?']);
    const empties: unknown[] = [];
    expect(await turn(llm, empties)).toBe('What happens when you plug in x = 0?');
    expect(empties).toEqual([{ round: 0, finishReason: 'length', retried: false }]);
    expect(llm.seen[1].at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('reached the student empty') });
  });

  it('gives up after one retry', async () => {
    const llm = fakeModel([null, null, 'never asked']);
    const empties: unknown[] = [];
    expect(await turn(llm, empties)).toBe('');
    expect(llm.seen).toHaveLength(2);
    expect(empties).toHaveLength(2);
  });
});

describe('replies that stop short of a question', () => {
  it('get one more round after a cue, and no more', async () => {
    const s = new SessionStore().create(problems.get('a-quadratic-vertex')!, 'test');
    s.chat.push({ role: 'student', text: "i can't see it", ts: Date.now() });
    let calls = 0;
    const llm: LlmClient = {
      describe: 'fake',
      toolMode: () => 'native',
      async *stream(): AsyncGenerator<LlmEvent> {
        calls++;
        yield { type: 'text', text: calls === 1 ? 'Sorry, let me add it again.' : 'Still no question.' };
        yield { type: 'tool_call', call: { id: `c${calls}`, name: 'add_tutor_expression', args: { latex: `(2,-${calls})` }, rawArgs: '' } };
        yield { type: 'done', finishReason: 'tool_calls' };
      },
    };
    const text = await runTutorTurn(
      s,
      { kind: 'chat', text: "i can't see it" },
      { llm, tools: createToolHost(() => new Set()), promptPath: resolve(root, 'prompts/tutor_system.md') },
      () => {},
      new Set(),
    );
    expect(calls).toBe(2);
    expect(text).toBe('Sorry, let me add it again. Still no question.');
  });
});

describe('the retry after an empty reply', () => {
  it('sends the retry-only request fields, and only on the retry', async () => {
    const s = new SessionStore().create(problems.get('a-quadratic-vertex')!, 'test');
    s.chat.push({ role: 'student', text: 'hi', ts: Date.now() });
    const seen: unknown[] = [];
    const llm: LlmClient = {
      describe: 'fake',
      toolMode: () => 'native',
      async *stream({ extraBody }): AsyncGenerator<LlmEvent> {
        seen.push(extraBody);
        if (seen.length === 2) yield { type: 'text', text: 'What do you notice?' };
        yield { type: 'done', finishReason: seen.length === 1 ? 'length' : 'stop' };
      },
    };
    const off = { chat_template_kwargs: { enable_thinking: false } };
    const text = await runTutorTurn(
      s,
      { kind: 'chat', text: 'hi' },
      { llm, tools: createToolHost(() => new Set()), promptPath: resolve(root, 'prompts/tutor_system.md'), retryExtraBody: off },
      () => {},
      new Set(),
    );
    expect(text).toBe('What do you notice?');
    expect(seen).toEqual([undefined, off]);
  });
});
