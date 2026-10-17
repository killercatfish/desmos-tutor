// SQLite storage: sessions, the event log (graph diffs, chat, tool calls, hint changes),
// skill marks, and solved status. Students are a typed or generated nickname only.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { describeDiff } from '../shared/diff.ts';
import type { CompactState, DiffEntry, Problem } from '../shared/types.ts';
import type { LiveSession } from './sessions.ts';

export type EventKind =
  | 'graph'
  | 'student_message'
  | 'tutor_message'
  | 'nudge'
  | 'tool_call'
  | 'hint'
  | 'skill'
  | 'solved'
  | 'error';

export interface EventRow {
  id: number;
  session_id: string;
  ts: number;
  kind: EventKind;
  payload: any;
}

export interface SessionRow {
  id: string;
  nickname: string;
  problem_id: string;
  demo_mode: number;
  model: string;
  started_at: number;
  last_event_at: number;
  solved_at: number | null;
  hint_level: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  problem_id TEXT NOT NULL,
  demo_mode INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  last_event_at INTEGER NOT NULL,
  solved_at INTEGER,
  hint_level INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, id);
CREATE TABLE IF NOT EXISTS skill_marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  ts INTEGER NOT NULL,
  skill TEXT NOT NULL,
  status TEXT NOT NULL,
  evidence TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS skill_marks_session ON skill_marks(session_id, id);
`;

export class TutorDb {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  createSession(s: LiveSession, demoMode: boolean, model: string): void {
    this.db
      .prepare(`INSERT INTO sessions (id, nickname, problem_id, demo_mode, model, started_at, last_event_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(s.id, s.nickname, s.problem.id, demoMode ? 1 : 0, model, s.startedAt, s.startedAt);
  }

  event(sessionId: string, kind: EventKind, payload: unknown, ts = Date.now()): void {
    this.db.prepare(`INSERT INTO events (session_id, ts, kind, payload) VALUES (?, ?, ?, ?)`).run(sessionId, ts, kind, JSON.stringify(payload));
    this.db.prepare(`UPDATE sessions SET last_event_at = ? WHERE id = ?`).run(ts, sessionId);
  }

  graph(sessionId: string, state: CompactState, diffs: DiffEntry[], desmosState: unknown, ts = Date.now()): void {
    this.event(sessionId, 'graph', { diffs, text: diffs.map(describeDiff), state, desmos_state: desmosState }, ts);
  }

  hint(sessionId: string, level: number, reason: string): void {
    this.event(sessionId, 'hint', { level, reason });
    this.db.prepare(`UPDATE sessions SET hint_level = ? WHERE id = ?`).run(level, sessionId);
  }

  skill(sessionId: string, skill: string, status: string, evidence: string, ts = Date.now()): void {
    this.event(sessionId, 'skill', { skill, status, evidence }, ts);
    this.db.prepare(`INSERT INTO skill_marks (session_id, ts, skill, status, evidence) VALUES (?, ?, ?, ?, ?)`).run(sessionId, ts, skill, status, evidence);
  }

  solved(sessionId: string, evidence: string, ts = Date.now()): void {
    this.event(sessionId, 'solved', { evidence }, ts);
    this.db.prepare(`UPDATE sessions SET solved_at = COALESCE(solved_at, ?) WHERE id = ?`).run(ts, sessionId);
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
  }

  listSessions(limit = 200): (SessionRow & { student_messages: number; graph_events: number })[] {
    return this.db
      .prepare(
        `SELECT s.*,
           (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.kind = 'student_message') AS student_messages,
           (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.kind = 'graph') AS graph_events
         FROM sessions s ORDER BY s.started_at DESC LIMIT ?`,
      )
      .all(limit) as (SessionRow & { student_messages: number; graph_events: number })[];
  }

  events(sessionId: string): EventRow[] {
    return (this.db.prepare(`SELECT * FROM events WHERE session_id = ? ORDER BY id`).all(sessionId) as (Omit<EventRow, 'payload'> & { payload: string })[]).map(
      (r) => ({ ...r, payload: JSON.parse(r.payload) }),
    );
  }

  skillMarks(sessionId: string) {
    return this.db.prepare(`SELECT ts, skill, status, evidence FROM skill_marks WHERE session_id = ? ORDER BY id`).all(sessionId);
  }

  /** Rebuild live state from the log, e.g. after the dev server restarts mid-session. */
  loadLive(id: string, problems: Map<string, Problem>): LiveSession | undefined {
    const row = this.getSession(id);
    const problem = row && problems.get(row.problem_id);
    if (!row || !problem) return undefined;
    const s: LiveSession = {
      id: row.id,
      nickname: row.nickname,
      problem,
      startedAt: row.started_at,
      hintLevel: row.hint_level,
      solved: row.solved_at !== null,
      state: { expressions: [] },
      recentDiffs: [],
      chat: [],
      editsSinceTutor: 0,
      lastActivity: row.last_event_at,
      nextTutorId: 1,
      busy: false,
    };
    for (const e of this.events(id)) {
      if (e.kind === 'graph') {
        s.state = e.payload.state;
        for (const t of e.payload.text as string[]) s.recentDiffs.push({ ts: e.ts, text: t, owner: '' });
      } else if (e.kind === 'student_message') s.chat.push({ role: 'student', text: e.payload.text, ts: e.ts });
      else if (e.kind === 'tutor_message') s.chat.push({ role: 'tutor', text: e.payload.text, ts: e.ts });
    }
    s.recentDiffs = s.recentDiffs.slice(-30);
    s.chat = s.chat.slice(-40);
    // Don't reuse tutor ids that are already on the graph.
    const used = s.state.expressions.map((e) => Number(e.id.match(/^tutor_(?:hl_)?(\d+)$/)?.[1] ?? 0));
    s.nextTutorId = Math.max(0, ...used) + 1;
    return s;
  }
}
