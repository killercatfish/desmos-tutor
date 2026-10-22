import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { Config } from './config.ts';
import { loadProblems, lockedIds, publicProblem } from './problems.ts';
import { SessionStore, addChat, applyGraphUpdate, type LiveSession } from './sessions.ts';
import { createLlmClient, type LlmClient } from './llm.ts';
import { runTutorTurn, type ToolHost, type Trigger } from './tutor.ts';
import { createToolHost } from './tools.ts';
import { TutorDb } from './db.ts';
import { cleanNickname, generateNickname } from './nickname.ts';
import { registerGoogleAuth } from './auth/google.ts';
import type { CompactState, DiffEntry, PublicConfig, TurnEvent } from '../shared/types.ts';

/** Turn events the student's browser gets. Progress notes and tool results stay on the server. */
const CLIENT_EVENTS = new Set<TurnEvent['type']>(['token', 'reset', 'action', 'error', 'done']);

export function buildApp(config: Config, opts: { llm?: LlmClient; tools?: ToolHost; db?: TutorDb; logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger === false ? false : { level: 'info' }, bodyLimit: 4 * 1024 * 1024 });
  const problems = loadProblems(resolve(config.root, 'problems'));
  const sessions = new SessionStore();
  const db = opts.db ?? new TutorDb(config.dbPath);
  const llm = opts.llm ?? createLlmClient(config.llm);
  const tools =
    opts.tools ??
    createToolHost((s) => lockedIds(s.problem), {
      toolCall: (s, name, args, result) => db.event(s.id, 'tool_call', { name, args, result }),
      hint: (s, level, reason) => db.hint(s.id, level, reason),
      skill: (s, skill, status, evidence) => db.skill(s.id, skill, status, evidence),
      solved: (s, evidence) => db.solved(s.id, evidence),
    }, { sympyUrl: config.sympyUrl });
  const promptPath = resolve(config.root, 'prompts/tutor_system.md');

  /** Live session, reloaded from the log if the server restarted since it began. */
  function live(id: string): LiveSession | undefined {
    let s = sessions.get(id);
    if (!s) {
      s = db.loadLive(id, problems);
      if (s) sessions.restore(s);
    }
    return s;
  }

  app.get('/api/config', async (): Promise<PublicConfig> => ({
    desmosApiKey: config.desmosApiKey,
    desmosApiVersion: config.desmosApiVersion,
    demoMode: config.providerTrainsOnData,
    nudgesEnabled: config.nudgesEnabled,
    idleNudgeSeconds: config.idleNudgeSeconds,
    googleSignIn: config.googleSignIn,
  }));

  app.get('/api/problems', async () => [...problems.values()].map(publicProblem));

  app.post<{ Body: { problemId: string; nickname?: string } }>('/api/sessions', async (req, reply) => {
    const problem = problems.get(req.body?.problemId);
    if (!problem) return reply.code(400).send({ error: 'Unknown problem' });
    // Demo mode: the provider may train on what we send, so no typed names at all.
    const nickname = config.providerTrainsOnData ? generateNickname() : (cleanNickname(req.body.nickname) ?? generateNickname());
    const s = sessions.create(problem, nickname);
    db.createSession(s, config.providerTrainsOnData, llm.describe);
    return { id: s.id, nickname: s.nickname, problem: publicProblem(problem) };
  });

  app.post<{ Params: { id: string }; Body: { state: CompactState; diffs: DiffEntry[]; desmosState: unknown } }>(
    '/api/sessions/:id/graph',
    async (req, reply) => {
      const s = live(req.params.id);
      if (!s) return reply.code(404).send({ error: 'No such session' });
      const { state, diffs, desmosState } = req.body ?? ({} as never);
      if (!state || !Array.isArray(state.expressions) || !Array.isArray(diffs)) return reply.code(400).send({ error: 'Bad snapshot' });
      applyGraphUpdate(s, state, diffs);
      db.graph(s.id, state, diffs, desmosState);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { kind: 'chat'; text: string } | { kind: 'nudge'; reason: string } }>(
    '/api/sessions/:id/turn',
    async (req, reply) => {
      const s = live(req.params.id);
      if (!s) return reply.code(404).send({ error: 'No such session' });
      if (s.busy) return reply.code(409).send({ error: 'The tutor is still answering' });
      const body = req.body;
      let trigger: Trigger;
      if (body?.kind === 'chat' && typeof body.text === 'string' && body.text.trim()) {
        trigger = { kind: 'chat', text: body.text.trim().slice(0, 2000) };
        addChat(s, 'student', trigger.text);
        db.event(s.id, 'student_message', { text: trigger.text });
      } else if (body?.kind === 'nudge') {
        if (!config.nudgesEnabled) return reply.code(400).send({ error: 'Nudges are turned off' });
        trigger = { kind: 'nudge', reason: String(body.reason ?? '').slice(0, 200) };
        db.event(s.id, 'nudge', { reason: trigger.reason });
      } else {
        return reply.code(400).send({ error: 'Expected {kind: "chat", text} or {kind: "nudge", reason}' });
      }

      s.busy = true;
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const abort = new AbortController();
      reply.raw.on('close', () => abort.abort());
      const emit = (e: TurnEvent) => {
        if (CLIENT_EVENTS.has(e.type) && !reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
      };
      try {
        const text = await runTutorTurn(s, trigger, { llm, tools, promptPath, signal: abort.signal, onEmpty: (info) => db.event(s.id, 'empty_reply', info) }, emit, lockedIds(s.problem));
        if (text) {
          addChat(s, 'tutor', text);
          db.event(s.id, 'tutor_message', { text });
        }
        emit({ type: 'done', text });
      } catch (err) {
        const message = abort.signal.aborted ? 'cancelled' : (err as Error).message;
        req.log.error({ err }, 'tutor turn failed');
        db.event(s.id, 'error', { message });
        emit({ type: 'error', message: `The tutor couldn't answer: ${message}` });
      } finally {
        s.busy = false;
        reply.raw.end();
      }
    },
  );

  // Teacher view (read-only). No auth in v0.1: the server binds to 127.0.0.1 by default.
  app.get('/api/teacher/sessions', async () => db.listSessions());

  app.get<{ Params: { id: string } }>('/api/teacher/sessions/:id', async (req, reply) => {
    const row = db.getSession(req.params.id);
    if (!row) return reply.code(404).send({ error: 'No such session' });
    return {
      session: row,
      problem: problems.get(row.problem_id) ?? null,
      events: db.events(row.id),
      skills: db.skillMarks(row.id),
    };
  });

  registerGoogleAuth(app, config);

  // Built frontend (npm run build). In dev, Vite serves the frontend and proxies /api here.
  const webDist = resolve(config.root, 'dist/web');
  if (existsSync(webDist)) {
    app.register(fastifyStatic, { root: webDist });
    app.get('/teacher', (_req, reply) => reply.sendFile('teacher.html'));
  }

  return { app, problems, sessions, db };
}
