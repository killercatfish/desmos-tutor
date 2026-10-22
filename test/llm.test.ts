import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLlmClient, oneShotEvents, type LlmEvent } from '../server/llm.ts';
import type { Config } from '../server/config.ts';

const cfg: Config['llm'] = {
  baseUrl: 'http://10.0.0.5:11434/v1',
  model: 'm',
  toolMode: 'auto',
  stream: 'auto',
  temperature: 0.4,
  maxTokens: 64,
  isPrivate: true,
};

const completion = (message: Record<string, unknown>) => ({ choices: [{ message, finish_reason: 'stop' }] });

async function collect(gen: AsyncGenerator<LlmEvent>): Promise<LlmEvent[]> {
  const out: LlmEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe('oneShotEvents', () => {
  it('strips thinking and yields native tool calls', () => {
    const events = [
      ...oneShotEvents(
        completion({
          content: '<think>hmm</think>Where is the vertex?',
          tool_calls: [{ id: 'c1', function: { name: 'check_point', arguments: '{"x":2}' } }],
        }),
      ),
    ];
    const text = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe('Where is the vertex?');
    expect(events).toContainEqual({ type: 'tool_call', call: { id: 'c1', name: 'check_point', args: { x: 2 }, rawArgs: '{"x":2}' } });
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('parses JSON tool blocks written in the text', () => {
    const events = [...oneShotEvents(completion({ content: 'Try this.\n```tool\n{"name":"mark_skill","arguments":{"skill":"s"}}\n```' }))];
    expect(events.some((e) => e.type === 'tool_call' && e.call.name === 'mark_skill')).toBe(true);
  });
});

describe('streaming fallback', () => {
  it('retries without streaming when the endpoint cannot stream, and stays that way', async () => {
    const bodies: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        bodies.push(body);
        if (body.stream) return new Response('{"error": "Expecting value: line 1 column 1 (char 0)"}', { status: 502 });
        return Response.json(completion({ content: 'Hi there.' }));
      }),
    );
    const client = createLlmClient(cfg, {});
    const first = await collect(client.stream({ messages: [{ role: 'user', content: 'hi' }], task: 'test' }));
    expect(first[0]).toEqual({ type: 'text', text: 'Hi there.' });
    await collect(client.stream({ messages: [{ role: 'user', content: 'again' }], task: 'test' }));
    expect(bodies.map((b) => b.stream)).toEqual([true, false, false]);
  });

  it('does not fall back when LLM_STREAM=true', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })));
    const client = createLlmClient({ ...cfg, stream: 'true' }, {});
    await expect(collect(client.stream({ messages: [{ role: 'user', content: 'hi' }], task: 'test' }))).rejects.toThrow(/502/);
  });
});
