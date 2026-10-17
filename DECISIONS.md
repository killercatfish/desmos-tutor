# Decisions

Defaults chosen while building v0.1 where the spec left room. Each says who made it. Change any of
them freely.

## 2026-10-17: v0.1 build (all Claude; Josh to review)

**Stack**
- Vanilla TypeScript frontend, no Preact. The UI is two panels and a dialog; a framework wasn't worth it. *(Claude)*
- Fastify, one process. Vite on 5173 proxies `/api` to Fastify on 3001 in dev; `npm start` serves the built frontend from Fastify. *(Claude)*
- No OpenAI SDK. `server/llm.ts` uses plain `fetch` and SSE parsing, so the fallback logic, `<think>` stripping and request headers stay in one small file. *(Claude)*
- Desmos API `v1.11` (current stable, 1.11.4). `v1.12` also loads with the demo key; switch with `DESMOS_API_VERSION`. *(Claude)*
- Default `LLM_MODEL=qwen27b`, a llama-swap name for a 27B Qwen. llama.cpp ignores the name. *(Claude)*

**Privacy**
- The server binds to `127.0.0.1` by default. `/teacher` has no auth in v0.1 (auth is out of scope), so this keeps it off the network. *(Claude)*
- Demo mode turns on by itself for any endpoint that isn't localhost or a private network. Tailscale's 100.64–127.x range and `.local` / `.ts.net` names count as private. *(Claude)*
- In demo mode the **server** ignores typed nicknames, not just the UI. *(Claude)*
- The `X-HKOS-*` labels go only to private-network endpoints, never to cloud providers. *(Claude)*
- `PROVIDER_TRAINS_ON_DATA=false` with a cloud URL is allowed, but the server prints a warning at startup. *(Claude)*
- The student's browser gets only text, graph actions, errors and "done" from a turn. Skill marks, tool results and hint reasons stay on the server. *(Claude)*
- Known gap: the target curve's LaTeX in problem (c) reaches the browser, because Desmos has to draw it. `secret` hides it from the expression list, but a student with devtools could read it. *(Claude)*

**Tutor behavior**
- `prompts/tutor_system.md` holds the policy only. The server appends a generated "This session" section with the problem, goal, misconceptions, hint ladder with used/current/locked marks, graph state and recent diffs. The file is re-read every turn. *(Claude)*
- Everything goes in **one** system message at the start. Qwen chat templates reject system messages anywhere else. *(Claude)*
- The prompt allows plotting the problem's *givens* (like the stated vertex) whenever the student is stuck. Hint level isn't required for that. This is what lets "adds a tutor point at the vertex when I'm stuck" happen without climbing three hint levels. *(Claude)*
- The hint level starts at 0. `advance_hint_level` moves up one level at a time and returns the newly unlocked hint text. *(Claude)*
- Up to 5 tool rounds per turn. If the model has already written to the student and only called bookkeeping tools (marks, cues, hints), the turn ends without another model call. *(Claude)*
- "3 or more edits with no progress" is implemented as 3+ student graph edits since the tutor last spoke, with no chat, after 10 s of quiet. The app can't judge "progress" without a per-problem checker. There are at most 2 nudges in a row until the student does something. Nudges stay off by default. *(Claude)*
- No code-level answer filter on live output. The text is already streamed by the time it could be checked. `scripts/simulate.ts` detects leaks instead, for prompt tuning. A per-problem `forbidden` list checked before streaming is an option for v0.2. *(Claude)*

**Guard**
- Beyond the `tutor_` prefix, the guard also refuses to: (1) remove or overwrite problem-owned tutor expressions (like the target), (2) define a name the student already defines (`a=5` when the student has `a`), because that breaks their graph with "defined twice", (3) highlight a slider, because the highlight copy would define it twice. *(Claude)*
- Highlight = a thick translucent tutor copy for 1.8 s. Desmos has no "pulse" API, and changing the student expression's style would modify it. *(Claude)*
- The model may choose its own id for a cue (it must start with `tutor_`). Otherwise the server assigns `tutor_1`, `tutor_2`, … *(Claude)*

**Math checker**
- A small LaTeX→mathjs converter written for this project instead of a LaTeX parser library. It covers what Desmos emits for school algebra: `\left( \right)`, `\frac`, `\sqrt`, `^{}`, `\cdot`, subscripts, `\left| |`, trig/log, and implicit multiplication (`2x`, `a(x-h)`, `x(x-1)`). No inequalities, no user-defined functions called by name. *(Claude)*
- Both math tools accept `expression_id`, so the model can check "the student's curve" without copying LaTeX, and slider values on the graph are in scope automatically. *(Claude)*
- Tolerance: relative 1e-6. *(Claude)*

**Logging**
- One `events` table with a JSON payload per event kind, plus `skill_marks` and summary columns on `sessions`. Every graph event stores the full `calculator.getState()`, so replay is exact. *(Claude)*
- Live sessions are rebuilt from the log when the server restarts, so `tsx watch` reloads during development don't lose a session. *(Claude)*
- Graph snapshots are sent only when the diff is non-empty. Viewport-only changes aren't logged. *(Claude)*

**Future hooks**
- `LlmClient` in `server/llm.ts` is the only seam a Vertex AI backend needs to fill. *(Claude)*
- Sign in with Google: `server/auth/google.ts` registers a 501 route when the flag is on, and the start dialog shows a disabled button. No OAuth code. *(Claude)*
