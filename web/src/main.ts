import { createSession, getConfig, getProblems, postGraph, runTurn, type SessionInfo } from './api.ts';
import { TutorCanvas, starterToDesmos } from './canvas.ts';
import { createCalculator, loadDesmos, type DesmosCalculator } from './desmos.ts';
import { GraphObserver } from './observer.ts';
import type { PublicConfig } from '../../shared/types.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let config: PublicConfig;
let calc: DesmosCalculator;
let canvas: TutorCanvas;
let observer: GraphObserver | null = null;
let session: SessionInfo | null = null;
let busy = false;
let lastActivity = Date.now();
let editsSinceTutor = 0;
let nudgeTimer: ReturnType<typeof setInterval> | null = null;
let nudgesInARow = 0; // at most 2 nudges until the student does something

function addMessage(role: 'tutor' | 'student' | 'system' | 'error', text: string): HTMLDivElement {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  $('messages').appendChild(div);
  $('messages').scrollTop = $('messages').scrollHeight;
  return div;
}

async function startSession(problemId: string, nickname: string): Promise<void> {
  observer?.stop();
  session = await createSession(problemId, nickname || undefined);
  const p = session.problem;
  $('problem-title').textContent = p.title;
  $('problem-statement').textContent = p.statement;
  $('nickname-chip').textContent = session.nickname;
  $('nickname-chip').hidden = false;
  $('messages').replaceChildren();
  addMessage('system', `Session started as ${session.nickname}.`);

  calc.setBlank();
  const starters = p.starter_expressions ?? [];
  if (starters.length) calc.setExpressions(starters.map(starterToDesmos));
  canvas.setLocked(new Set(starters.filter((s) => s.owner === 'tutor').map((s) => s.id!)));

  const id = session.id;
  observer = new GraphObserver(calc, (snap) => {
    const studentEdits = snap.diffs.filter((d) => d.owner === 'student').length;
    if (studentEdits) {
      lastActivity = Date.now();
      editsSinceTutor += studentEdits;
      nudgesInARow = 0;
    }
    return postGraph(id, snap).catch((e) => console.error('graph post failed', e));
  });
  observer.start();
  await observer.flush(); // record the starting graph so replay begins from it
  editsSinceTutor = 0;
  lastActivity = Date.now();
  setChatEnabled(true);
  startNudges();
}

function setChatEnabled(on: boolean): void {
  $<HTMLTextAreaElement>('chat-input').disabled = !on;
  $<HTMLButtonElement>('chat-send').disabled = !on;
  if (on) $('chat-input').focus();
}

async function tutorTurn(body: { kind: 'chat'; text: string } | { kind: 'nudge'; reason: string }): Promise<void> {
  if (!session || busy) return;
  busy = true;
  setChatEnabled(false);
  const sessionId = session.id;
  let bubble: HTMLDivElement | null = null;
  let text = '';
  try {
    await observer?.flush(); // the tutor should see the graph as it is right now
    for await (const ev of runTurn(sessionId, body)) {
      if (session?.id !== sessionId) break; // a new session started mid-turn
      if (ev.type === 'token') {
        text += ev.text;
        bubble ??= addMessage('tutor', '');
        bubble.textContent = text;
        $('messages').scrollTop = $('messages').scrollHeight;
      } else if (ev.type === 'reset') {
        text = '';
        if (bubble) bubble.textContent = '';
      } else if (ev.type === 'action') {
        try {
          canvas.apply(ev.action);
        } catch (e) {
          console.warn('tutor action refused in the browser', e);
        }
      } else if (ev.type === 'error') {
        addMessage('error', ev.message);
      } else if (ev.type === 'done') {
        if (bubble && ev.text) bubble.textContent = ev.text;
        if (!bubble && !ev.text) addMessage('system', '(the tutor had nothing to say)');
      }
    }
  } catch (e) {
    addMessage('error', `Couldn't reach the tutor: ${(e as Error).message}`);
  } finally {
    busy = false;
    editsSinceTutor = 0;
    lastActivity = Date.now();
    if (session?.id === sessionId) setChatEnabled(true);
  }
}

/** Idle nudges (off unless NUDGES_ENABLED=true): 90 s of nothing, or 3+ edits with no chat. */
function startNudges(): void {
  if (nudgeTimer) clearInterval(nudgeTimer);
  if (!config.nudgesEnabled) return;
  let nudgedAt = 0;
  nudgeTimer = setInterval(() => {
    if (busy || !session || lastActivity <= nudgedAt || nudgesInARow >= 2) return;
    const idle = (Date.now() - lastActivity) / 1000;
    let reason: string | null = null;
    if (idle >= config.idleNudgeSeconds) reason = `The student has made no changes and sent no messages for ${Math.round(idle)} seconds.`;
    else if (editsSinceTutor >= 3 && idle >= 10) reason = `The student has made ${editsSinceTutor} graph edits since you last spoke without asking anything.`;
    if (!reason) return;
    nudgedAt = lastActivity;
    nudgesInARow++;
    void tutorTurn({ kind: 'nudge', reason });
  }, 5000);
}

function onChatSubmit(ev: Event): void {
  ev.preventDefault();
  const input = $<HTMLTextAreaElement>('chat-input');
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = '';
  addMessage('student', text);
  lastActivity = Date.now();
  nudgesInARow = 0;
  void tutorTurn({ kind: 'chat', text });
}

async function openStartDialog(): Promise<void> {
  const problems = await getProblems();
  const select = $<HTMLSelectElement>('problem-select');
  select.replaceChildren(
    ...problems.map((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.title;
      return o;
    }),
  );
  const dialog = $<HTMLDialogElement>('start-dialog');
  dialog.showModal();
}

async function init(): Promise<void> {
  config = await getConfig();
  if (config.demoMode) {
    $('demo-banner').hidden = false;
    $('nickname-row').hidden = true;
    $('nickname-demo').hidden = false;
  }
  if (config.googleSignIn) $('google-signin').hidden = false; // stub only: see server/auth/google.ts

  try {
    await loadDesmos(config.desmosApiKey, config.desmosApiVersion);
  } catch (e) {
    addMessage('error', String((e as Error).message));
    return;
  }
  calc = createCalculator($('calculator'));
  canvas = new TutorCanvas(calc);

  const dialog = $<HTMLDialogElement>('start-dialog');
  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'start') return;
    const nickname = config.demoMode ? '' : $<HTMLInputElement>('nickname-input').value;
    startSession($<HTMLSelectElement>('problem-select').value, nickname).catch((e) => addMessage('error', String(e)));
  });
  $('new-session').addEventListener('click', () => void openStartDialog());
  $('chat-form').addEventListener('submit', onChatSubmit);
  $('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) onChatSubmit(e);
  });
  await openStartDialog();
}

void init();
