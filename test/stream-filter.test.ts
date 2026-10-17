import { describe, expect, it } from 'vitest';
import { StreamFilter, parseToolText, type FilterOut } from '../server/stream-filter.ts';
import { toJsonModeMessages } from '../server/llm.ts';

function run(chunks: string[]): FilterOut[] {
  const f = new StreamFilter();
  const out = chunks.flatMap((c) => f.push(c));
  out.push(...f.end());
  return out;
}
const visible = (outs: FilterOut[]) => outs.filter((o) => o.type === 'text').map((o) => (o as { text: string }).text).join('');

describe('StreamFilter', () => {
  it('passes plain text through', () => {
    expect(visible(run(['What do ', 'you notice?']))).toBe('What do you notice?');
  });

  it('drops think blocks, even split across chunks', () => {
    const outs = run(['<thi', 'nk>the answer is 2</th', 'ink>\n\nWhat does a ', 'do?']);
    expect(visible(outs)).toBe('What does a do?');
  });

  it('resets when a think block closes that never opened', () => {
    const outs = run(['reasoning here', '</think>', 'Real reply.']);
    expect(outs.map((o) => o.type)).toEqual(['text', 'reset', 'text']);
    expect(outs[2]).toEqual({ type: 'text', text: 'Real reply.' });
  });

  it('pulls out fenced tool blocks', () => {
    const outs = run(['Let me mark that.\n```to', 'ol\n{"name":"evaluate","arguments":{"latex":"y=x^2","x":2}}\n``', '`\nDone?']);
    expect(visible(outs)).toBe('Let me mark that.\n\nDone?');
    const tool = outs.find((o) => o.type === 'tool_text') as { raw: string };
    expect(parseToolText(tool.raw)).toEqual({ name: 'evaluate', args: { latex: 'y=x^2', x: 2 } });
  });

  it('pulls out Qwen-style tool_call tags', () => {
    const outs = run(['<tool_call>{"name": "advance_hint_level", "arguments": "{\\"reason\\": \\"stuck\\"}"}</tool_call>Okay.']);
    const tool = outs.find((o) => o.type === 'tool_text') as { raw: string };
    expect(parseToolText(tool.raw)).toEqual({ name: 'advance_hint_level', args: { reason: 'stuck' } });
    expect(visible(outs)).toBe('Okay.');
  });

  it("doesn't hold back text that only looks like a marker start forever", () => {
    expect(visible(run(['x < 3 and a <', '']))).toBe('x < 3 and a <');
  });
});

describe('toJsonModeMessages', () => {
  it('folds tool results into user turns and keeps roles alternating', () => {
    const msgs = toJsonModeMessages(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', tool_calls: [{ id: '1', name: 'evaluate', args: { x: 1 }, rawArgs: '{"x":1}' }] },
        { role: 'tool', tool_call_id: '1', name: 'evaluate', content: '{"value":1}' },
      ],
      [{ name: 'evaluate', description: 'd', parameters: {} }],
    );
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(msgs[0].content).toContain('```tool');
    expect(msgs[2].content).toContain('"name":"evaluate"');
    expect(msgs[3].content).toContain('[tool result for evaluate]');
  });
});
