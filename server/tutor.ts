// One tutor turn: build the prompt from the problem, the graph and the chat, stream the
// model's reply, run any tool calls, and loop until the model stops calling tools.

import { readFileSync } from 'node:fs';
import type { ChatMsg, LlmClient, ToolCall, ToolSpec } from './llm.ts';
import type { LiveSession } from './sessions.ts';
import type { TurnEvent } from '../shared/types.ts';

export type Trigger = { kind: 'chat'; text: string } | { kind: 'nudge'; reason: string };

export interface ToolHost {
  specs(): ToolSpec[];
  /** Runs one call. Returns what the model sees as the result. Never throws. */
  execute(session: LiveSession, call: ToolCall, emit: (e: TurnEvent) => void): Promise<unknown>;
}

export interface TurnDeps {
  llm: LlmClient;
  tools: ToolHost;
  promptPath: string;
  /** Short task label for the model-server request headers. */
  task?: string;
  signal?: AbortSignal;
}

const MAX_TOOL_ROUNDS = 5;
const CHAT_HISTORY = 14;

/** The policy file is re-read every turn, so edits to prompts/tutor_system.md apply immediately. */
export function loadPolicy(path: string): string {
  return readFileSync(path, 'utf8').trim();
}

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

export function describeGraph(s: LiveSession, locked: Set<string>): string {
  if (s.state.expressions.length === 0) return '(the graph is empty)';
  return s.state.expressions
    .map((e) => {
      const tags: string[] = [e.owner];
      if (e.slider) tags.push(`slider ${e.slider.name} = ${e.slider.value}${e.slider.min !== undefined ? `, range ${e.slider.min} to ${e.slider.max}` : ''}`);
      if (e.hidden) tags.push('hidden');
      if (e.type !== 'expression') tags.push(e.type);
      if (locked.has(e.id)) tags.push('set up by the problem, locked');
      const star = s.problem.starter_expressions?.find((x) => x.id === e.id);
      if (star?.secret) tags.push('equation hidden from the student: they only see the curve');
      return `- id ${e.id} [${tags.join('; ')}]: ${e.latex}`;
    })
    .join('\n');
}

export function buildSystemPrompt(policy: string, s: LiveSession, locked: Set<string>, now = Date.now()): string {
  const p = s.problem;
  const ladder = p.hint_ladder
    .map((h, i) => {
      const n = i + 1;
      const status = n < s.hintLevel ? 'used' : n === s.hintLevel ? 'CURRENT' : 'locked';
      return `${n}. [${status}] ${h}`;
    })
    .join('\n');
  const diffs = s.recentDiffs.slice(-12);
  const parts = [
    policy,
    '---',
    '# This session',
    `## Problem: ${p.title}`,
    `Student sees: ${p.statement}`,
    `Goal (teacher-facing, never read this out): ${p.goal}`,
    '## Common misconceptions to watch for',
    p.common_misconceptions.map((m) => `- ${m}`).join('\n') || '- (none listed)',
    '## Hint ladder (vague to specific)',
    ladder || '(no hints)',
    s.hintLevel === 0
      ? 'Hint level 0: no hints unlocked yet. Diagnose first.'
      : `Hint level ${s.hintLevel} of ${p.hint_ladder.length}. Use hints up to the CURRENT one; later ones are locked until you call advance_hint_level.`,
    '## The student\'s graph right now',
    describeGraph(s, locked),
    '## Recent graph changes (oldest first)',
    diffs.length ? diffs.map((d) => `- (${ago(d.ts, now)}) ${d.text}`).join('\n') : '- (none yet)',
    s.solved ? '## Status\nYou already marked this solved. Help them reflect or extend.' : '',
  ];
  return parts.filter(Boolean).join('\n\n');
}

export function buildMessages(policy: string, s: LiveSession, trigger: Trigger, locked: Set<string>): ChatMsg[] {
  const msgs: ChatMsg[] = [{ role: 'system', content: buildSystemPrompt(policy, s, locked) }];
  for (const m of s.chat.slice(-CHAT_HISTORY)) {
    msgs.push(m.role === 'student' ? { role: 'user', content: m.text } : { role: 'assistant', content: m.text });
  }
  if (trigger.kind === 'nudge') {
    msgs.push({
      role: 'user',
      content: `(No message from the student. ${trigger.reason} Look at their graph and ask one short, specific question to get them going again.)`,
    });
  }
  if (msgs.length === 1) msgs.push({ role: 'user', content: '(The student just opened the problem. Greet them briefly and ask what they notice or plan to try first.)' });
  return msgs;
}

/**
 * Runs a full turn. `trigger` is already recorded in the session's chat (for a chat turn).
 * Returns the text the student saw.
 */
export async function runTutorTurn(s: LiveSession, trigger: Trigger, deps: TurnDeps, emit: (e: TurnEvent) => void, locked: Set<string>): Promise<string> {
  const policy = loadPolicy(deps.promptPath);
  const messages = buildMessages(policy, s, trigger, locked);
  const tools = deps.tools.specs();
  let visible = '';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let roundText = '';
    const calls: ToolCall[] = [];
    for await (const ev of deps.llm.stream({ messages, tools, task: deps.task ?? 'tutor', signal: deps.signal })) {
      if (ev.type === 'text') {
        roundText += ev.text;
        emit({ type: 'token', text: ev.text });
      } else if (ev.type === 'reset') {
        roundText = '';
        emit({ type: 'reset' });
      } else if (ev.type === 'tool_call') calls.push(ev.call);
    }
    if (roundText) visible += (visible ? ' ' : '') + roundText.trim();
    if (calls.length === 0) break;

    messages.push({ role: 'assistant', content: roundText, tool_calls: calls });
    for (const call of calls) {
      const result = await deps.tools.execute(s, call, emit);
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: JSON.stringify(result) });
    }
    // If the model already wrote to the student and only did bookkeeping, don't make it talk again.
    if (roundText.trim() && calls.every((c) => QUIET_TOOLS.has(c.name))) break;
  }
  return visible.trim();
}

/** Tools whose results the model doesn't need before speaking. */
const QUIET_TOOLS = new Set(['mark_progress', 'mark_solved', 'highlight', 'add_tutor_expression', 'remove_tutor_expression', 'advance_hint_level']);
