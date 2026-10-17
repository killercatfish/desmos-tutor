// The one module that talks to a model. Everything else uses the LlmClient interface,
// so a later version can swap in another backend (e.g. Vertex AI under a school's own
// Google Cloud project) without touching the tutor logic.
//
// This implementation speaks the OpenAI chat-completions protocol, which llama.cpp,
// vLLM, Ollama, LM Studio, Gemini's OpenAI-compatible endpoint, OpenRouter and Groq all serve.

import { hostname } from 'node:os';
import type { Config } from './config.ts';
import { StreamFilter, parseToolText } from './stream-filter.ts';

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments, or undefined if the model sent invalid JSON. */
  args: unknown;
  rawArgs: string;
}

export type ChatMsg =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; name: string; content: string };

export type LlmEvent =
  | { type: 'text'; text: string }
  | { type: 'reset' }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; finishReason: string | null };

export interface LlmRequest {
  messages: ChatMsg[];
  tools?: ToolSpec[];
  /** Short task name for the X-HKOS-Requester header, e.g. "tutor" or "simulate". */
  task: string;
  signal?: AbortSignal;
}

export interface LlmClient {
  readonly describe: string;
  /** 'native' = OpenAI function calling; 'json' = tool calls written as ```tool blocks. */
  toolMode(): 'native' | 'json';
  stream(req: LlmRequest): AsyncGenerator<LlmEvent>;
}

export function createLlmClient(cfg: Config['llm'], env: NodeJS.ProcessEnv = process.env): LlmClient {
  return new OpenAICompatClient(cfg, env);
}

class OpenAICompatClient implements LlmClient {
  private mode: 'native' | 'json';
  private extraBody: Record<string, unknown> = {};

  constructor(
    private cfg: Config['llm'],
    private env: NodeJS.ProcessEnv,
  ) {
    this.mode = cfg.toolMode === 'json' ? 'json' : 'native';
    if (env.LLM_EXTRA_BODY) {
      try {
        this.extraBody = JSON.parse(env.LLM_EXTRA_BODY);
      } catch {
        throw new Error('LLM_EXTRA_BODY must be a JSON object');
      }
    }
  }

  get describe() {
    return `${this.cfg.model} @ ${this.cfg.baseUrl}`;
  }

  toolMode() {
    return this.mode;
  }

  private headers(task: string): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' };
    if (this.cfg.apiKey) h.authorization = `Bearer ${this.cfg.apiKey}`;
    // Home GPU nodes want every request labelled with who sent it. Not sent to outside providers.
    if (this.cfg.isPrivate) {
      h['X-HKOS-Requester'] = `desmos-tutor.${task}`;
      const sid = this.env.CLAUDE_CODE_SESSION_ID;
      h['X-HKOS-Trace'] = this.env.HKOS_TRACE || (sid ? `claude:${sid}` : `desmos-tutor:${hostname()}`);
    }
    return h;
  }

  async *stream(req: LlmRequest): AsyncGenerator<LlmEvent> {
    const useNative = this.mode === 'native' && (req.tools?.length ?? 0) > 0;
    let res = await this.post(req, useNative);
    if (!res.ok && useNative && this.cfg.toolMode === 'auto') {
      const body = await res.text();
      // The endpoint refused function calling (llama.cpp without --jinja says so, for example):
      // switch to JSON tool blocks for the rest of this process.
      if (/tool|function|jinja/i.test(body)) {
        console.warn(`[llm] native tool calls refused (${res.status}: ${body.slice(0, 160)}); using JSON tool blocks`);
        this.mode = 'json';
        res = await this.post(req, false);
      } else {
        throw new Error(`LLM request failed: ${res.status} ${body.slice(0, 300)}`);
      }
    }
    if (!res.ok || !res.body) {
      throw new Error(`LLM request failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    }

    const filter = new StreamFilter();
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: string | null = null;
    let textCallN = 0;

    const fromFilter = function* (outs: ReturnType<StreamFilter['push']>): Generator<LlmEvent> {
      for (const o of outs) {
        if (o.type === 'text') yield { type: 'text', text: o.text };
        else if (o.type === 'reset') yield { type: 'reset' };
        else {
          const parsed = parseToolText(o.raw);
          if (parsed) yield { type: 'tool_call', call: { id: `text_${++textCallN}`, name: parsed.name, args: parsed.args, rawArgs: JSON.stringify(parsed.args) } };
        }
      }
    };

    for await (const data of sseData(res.body)) {
      if (data === '[DONE]') break;
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.error) throw new Error(`LLM error: ${JSON.stringify(chunk.error).slice(0, 300)}`);
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      // reasoning_content / reasoning (separate thinking channel) is ignored on purpose.
      if (typeof delta.content === 'string' && delta.content) yield* fromFilter(filter.push(delta.content));
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const p = pending.get(idx) ?? { id: '', name: '', args: '' };
        if (tc.id) p.id = tc.id;
        if (tc.function?.name) p.name += tc.function.name;
        if (tc.function?.arguments) p.args += tc.function.arguments;
        pending.set(idx, p);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    yield* fromFilter(filter.end());

    for (const [idx, p] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      let args: unknown;
      try {
        args = p.args.trim() ? JSON.parse(p.args) : {};
      } catch {
        args = undefined;
      }
      yield { type: 'tool_call', call: { id: p.id || `call_${idx}`, name: p.name, args, rawArgs: p.args } };
    }
    yield { type: 'done', finishReason };
  }

  private post(req: LlmRequest, native: boolean): Promise<Response> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: native ? toNativeMessages(req.messages) : toJsonModeMessages(req.messages, req.tools ?? []),
      stream: true,
      temperature: this.cfg.temperature,
      max_tokens: this.cfg.maxTokens,
      ...this.extraBody,
    };
    if (native) {
      body.tools = req.tools!.map((t) => ({ type: 'function', function: t }));
      body.tool_choice = 'auto';
    }
    return fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(req.task),
      body: JSON.stringify(body),
      signal: req.signal,
    });
  }
}

function toNativeMessages(msgs: ChatMsg[]): unknown[] {
  return msgs.map((m) => {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArgs || '{}' } })),
      };
    }
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
    return { role: m.role, content: m.content };
  });
}

/** For endpoints without function calling: tools go in the system prompt, results come back as user turns. */
export function toJsonModeMessages(msgs: ChatMsg[], tools: ToolSpec[]): { role: string; content: string }[] {
  const out: { role: string; content: string }[] = [];
  const push = (role: string, content: string) => {
    const last = out[out.length - 1];
    // Many chat templates need user/assistant to alternate, so merge neighbours.
    if (last && last.role === role && role !== 'system') last.content += `\n\n${content}`;
    else out.push({ role, content });
  };
  for (const m of msgs) {
    if (m.role === 'system') push('system', tools.length ? `${m.content}\n\n${jsonToolInstructions(tools)}` : m.content);
    else if (m.role === 'assistant') {
      const calls = (m.tool_calls ?? []).map((c) => '```tool\n' + JSON.stringify({ name: c.name, arguments: c.args ?? {} }) + '\n```');
      push('assistant', [m.content, ...calls].filter(Boolean).join('\n'));
    } else if (m.role === 'tool') push('user', `[tool result for ${m.name}] ${m.content}`);
    else push('user', m.content);
  }
  return out;
}

function jsonToolInstructions(tools: ToolSpec[]): string {
  const list = tools.map((t) => `- ${t.name}: ${t.description}\n  arguments schema: ${JSON.stringify(t.parameters)}`).join('\n');
  return [
    '## Tools',
    'To call a tool, write a fenced block exactly like this (the student never sees it):',
    '```tool',
    '{"name": "tool_name", "arguments": {"arg": "value"}}',
    '```',
    'You may call several tools in one reply. Results come back in the next message as "[tool result for name]".',
    'If you call a tool whose result you need (like a math check), stop after the block and wait for the result before writing to the student.',
    '',
    list,
  ].join('\n');
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const event = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (data) yield data;
    }
  }
  if (buf.trim().startsWith('data:')) yield buf.trim().slice(5).trimStart();
}
