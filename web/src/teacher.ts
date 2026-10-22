// Teacher view: list sessions, show a timeline of graph changes and chat, and replay the
// graph at any point using the Desmos state stored with each graph event.

import { getConfig } from './api.ts';
import { createCalculator, loadDesmos, type DesmosCalculator } from './desmos.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface SessionRow {
  id: string;
  nickname: string;
  problem_id: string;
  demo_mode: number;
  model: string;
  started_at: number;
  last_event_at: number;
  solved_at: number | null;
  hint_level: number;
  student_messages: number;
  graph_events: number;
}

interface EventRow {
  id: number;
  ts: number;
  kind: string;
  payload: any;
}

interface Detail {
  session: SessionRow;
  problem: { title: string; statement: string; hint_ladder: string[] } | null;
  events: EventRow[];
  skills: { ts: number; skill: string; status: string; evidence: string }[];
}

let calc: DesmosCalculator | null = null;
let current: Detail | null = null;

const fmtTime = (ts: number) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

async function loadList(): Promise<void> {
  const rows = (await fetch('/api/teacher/sessions').then((r) => r.json())) as SessionRow[];
  const nav = $('session-list');
  if (rows.length === 0) {
    nav.replaceChildren(el('p', { className: 'muted', style: 'padding: 12px' } as never, 'No sessions yet.'));
    return;
  }
  nav.replaceChildren(
    ...rows.map((r) => {
      const b = el(
        'button',
        { type: 'button' },
        el('div', { className: 'name' }, `${r.nickname}${r.solved_at ? ' ✓' : ''}`),
        el('div', { className: 'meta' }, `${r.problem_id} · ${fmtTime(r.started_at)}`),
        el('div', { className: 'meta' }, `${r.student_messages} messages · ${r.graph_events} graph changes · hint ${r.hint_level}${r.demo_mode ? ' · demo' : ''}`),
      );
      b.dataset.id = r.id;
      b.addEventListener('click', () => {
        location.hash = r.id;
      });
      return b;
    }),
  );
}

function describe(e: EventRow): [string, string] {
  const p = e.payload;
  switch (e.kind) {
    case 'graph':
      return ['Graph', (p.text as string[]).join('; ')];
    case 'student_message':
      return ['Student', p.text];
    case 'tutor_message':
      return ['Tutor', p.text];
    case 'nudge':
      return ['Nudge', p.reason];
    case 'hint':
      return [`Hint → level ${p.level}`, p.reason];
    case 'skill':
      return [`Skill: ${p.skill}`, `${p.status}: ${p.evidence}`];
    case 'solved':
      return ['Solved', p.evidence];
    case 'tool_call':
      return [`Tool ${p.name}`, `${JSON.stringify(p.args)} → ${JSON.stringify(p.result)}`];
    case 'error':
      return ['Error', p.message];
    case 'empty_reply':
      return ['Empty reply', `model stopped with no text (${p.finishReason ?? 'no reason given'})${p.retried ? ', already retried' : ', asking again'}`];
    default:
      return [e.kind, JSON.stringify(p)];
  }
}

async function showSession(id: string): Promise<void> {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#session-list button')) b.classList.toggle('active', b.dataset.id === id);
  const res = await fetch(`/api/teacher/sessions/${encodeURIComponent(id)}`);
  if (!res.ok) return;
  current = (await res.json()) as Detail;
  const { session: s, problem, events, skills } = current;
  $('detail-empty').hidden = true;
  $('detail-body').hidden = false;

  const hints = events.filter((e) => e.kind === 'hint').map((e) => e.payload.level as number);
  const stat = (label: string, value: string) => el('div', { className: 'stat' }, el('b', {}, value), label);
  $('summary').replaceChildren(
    el('h2', {}, `${s.nickname}: ${problem?.title ?? s.problem_id}`),
    el('div', { className: 'muted' }, problem?.statement ?? ''),
    el(
      'div',
      { className: 'stats' },
      stat('time to solve', s.solved_at ? fmtDuration(s.solved_at - s.started_at) : 'not solved'),
      stat('session length', fmtDuration(s.last_event_at - s.started_at)),
      stat('hint levels used', hints.length ? hints.join(', ') : 'none'),
      stat('student messages', String(events.filter((e) => e.kind === 'student_message').length)),
      stat('graph changes', String(events.filter((e) => e.kind === 'graph').length)),
      stat('model', s.model || '?'),
    ),
  );

  $('skills').replaceChildren(
    el('h3', {}, 'Skill marks'),
    skills.length
      ? el(
          'table',
          {},
          el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Skill'), el('th', {}, 'Status'), el('th', {}, 'Evidence')),
          ...skills.map((k) =>
            el('tr', {}, el('td', {}, fmtDuration(k.ts - s.started_at)), el('td', {}, k.skill), el('td', { className: `status-${k.status}` }, k.status), el('td', {}, k.evidence)),
          ),
        )
      : el('p', { className: 'muted' }, 'None recorded.'),
  );

  $('timeline').replaceChildren(
    ...events.map((e, i) => {
      const [kind, text] = describe(e);
      const li = el('li', { className: e.kind }, el('span', { className: 'when' }, `+${fmtDuration(e.ts - s.started_at)}`), el('span', { className: 'kind' }, kind), text);
      li.addEventListener('click', () => setReplay(i));
      return li;
    }),
  );

  const slider = $<HTMLInputElement>('replay-slider');
  slider.max = String(Math.max(0, events.length - 1));
  setReplay(events.length - 1);
}

/** Restore the graph as it was right after event i. */
function setReplay(i: number): void {
  if (!current || !calc) return;
  const { events, session } = current;
  i = Math.max(0, Math.min(i, events.length - 1));
  $<HTMLInputElement>('replay-slider').value = String(i);
  let graph: EventRow | undefined;
  for (let j = i; j >= 0; j--) {
    if (events[j].kind === 'graph' && events[j].payload.desmos_state) {
      graph = events[j];
      break;
    }
  }
  if (graph) calc.setState(graph.payload.desmos_state, { allowUndo: false });
  else calc.setBlank();
  const e = events[i];
  $('replay-label').textContent = e ? `${i + 1}/${events.length} · +${fmtDuration(e.ts - session.started_at)}` : '';
  document.querySelectorAll('#timeline li').forEach((li, j) => {
    li.classList.toggle('current', j === i);
    li.classList.toggle('future', j > i);
  });
  document.querySelectorAll('#timeline li')[i]?.scrollIntoView({ block: 'nearest' });
}

async function init(): Promise<void> {
  const config = await getConfig();
  try {
    await loadDesmos(config.desmosApiKey, config.desmosApiVersion);
    calc = createCalculator($('replay-calc'), { keypad: false, settingsMenu: false, expressionsCollapsed: false });
  } catch (e) {
    $('replay-calc').textContent = String((e as Error).message);
  }
  $<HTMLInputElement>('replay-slider').addEventListener('input', (ev) => setReplay(Number((ev.target as HTMLInputElement).value)));
  await loadList();
  const show = () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id) void showSession(id);
  };
  window.addEventListener('hashchange', show);
  show();
}

void init();
