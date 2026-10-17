// Live per-session state the tutor needs on every turn. The durable record is the event log.

import { randomUUID } from 'node:crypto';
import { describeDiff } from '../shared/diff.ts';
import type { CompactState, DiffEntry, Problem } from '../shared/types.ts';

export interface ChatMessage {
  role: 'student' | 'tutor';
  text: string;
  ts: number;
}

export interface LiveSession {
  id: string;
  nickname: string;
  problem: Problem;
  startedAt: number;
  hintLevel: number;
  solved: boolean;
  state: CompactState;
  /** Recent graph changes, newest last, as plain-language lines. */
  recentDiffs: { ts: number; text: string; owner: string }[];
  chat: ChatMessage[];
  /** Student edits since the tutor last spoke (drives the "3 edits, no progress" nudge). */
  editsSinceTutor: number;
  lastActivity: number;
  nextTutorId: number;
  busy: boolean;
}

const MAX_DIFFS = 30;
const MAX_CHAT = 40;

export class SessionStore {
  private sessions = new Map<string, LiveSession>();

  create(problem: Problem, nickname: string, id: string = randomUUID()): LiveSession {
    const now = Date.now();
    const s: LiveSession = {
      id,
      nickname,
      problem,
      startedAt: now,
      hintLevel: 0,
      solved: false,
      state: { expressions: [] },
      recentDiffs: [],
      chat: [],
      editsSinceTutor: 0,
      lastActivity: now,
      nextTutorId: 1,
      busy: false,
    };
    this.sessions.set(id, s);
    return s;
  }

  get(id: string): LiveSession | undefined {
    return this.sessions.get(id);
  }

  /** Put an existing session back into memory (after a server restart). */
  restore(s: LiveSession): void {
    this.sessions.set(s.id, s);
  }
}

export function applyGraphUpdate(s: LiveSession, state: CompactState, diffs: DiffEntry[], ts = Date.now()): void {
  s.state = state;
  for (const d of diffs) s.recentDiffs.push({ ts, text: describeDiff(d), owner: d.owner });
  if (s.recentDiffs.length > MAX_DIFFS) s.recentDiffs.splice(0, s.recentDiffs.length - MAX_DIFFS);
  const studentEdits = diffs.filter((d) => d.owner === 'student').length;
  if (studentEdits > 0) {
    s.editsSinceTutor += studentEdits;
    s.lastActivity = ts;
  }
}

export function addChat(s: LiveSession, role: ChatMessage['role'], text: string, ts = Date.now()): void {
  s.chat.push({ role, text, ts });
  if (s.chat.length > MAX_CHAT) s.chat.splice(0, s.chat.length - MAX_CHAT);
  if (role === 'student') s.lastActivity = ts;
  else s.editsSinceTutor = 0;
}
