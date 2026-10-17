# Socratic Desmos Tutor (v0.1)

A local web app with a Desmos graphing calculator on the left and a tutor chat on the right. The
tutor watches the student's graph as it changes and guides them with one question at a time. It
never hands over the answer. Every session is logged so a teacher can replay how the student's
thinking moved.

It's built for the hard problems, the ones where a stuck student reaches for an answer machine. The
tutor makes working through the problem yourself the faster path. **Project page:**
https://killercatfish.github.io/desmos-tutor/

By default every model call goes to a model running on your own machine or network. There are
no cloud APIs, no telemetry, and no analytics.

## Quick start

```sh
npm install
npm run dev
```

- Student view: http://127.0.0.1:5173
- Teacher view: http://127.0.0.1:5173/teacher

The first `npm run dev` copies `.env.example` to `.env`. You still need a model server running
(see below). Without one, the calculator works, but the tutor shows an error when you send a
message.

## Pointing it at a model

Any OpenAI-compatible `/v1/chat/completions` endpoint works. Set two lines in `.env`:

```sh
LLM_BASE_URL=http://localhost:8080/v1
LLM_MODEL=qwen27b
```

Changing the model needs no code changes. Restart `npm run dev` after editing `.env`.
`prompts/tutor_system.md` is re-read on every turn, so you can edit it while the app runs.

| Server | Start it | `.env` |
|---|---|---|
| llama.cpp | `llama-server -m model.gguf --jinja --port 8080` | `LLM_BASE_URL=http://localhost:8080/v1` |
| vLLM | `vllm serve Qwen/Qwen3-32B --enable-auto-tool-choice --tool-call-parser hermes` | `LLM_BASE_URL=http://localhost:8000/v1`, `LLM_MODEL=Qwen/Qwen3-32B` |
| Ollama | `ollama serve` (and `ollama pull qwen3:32b`) | `LLM_BASE_URL=http://localhost:11434/v1`, `LLM_MODEL=qwen3:32b` |
| LM Studio | start the local server in the app | `LLM_BASE_URL=http://localhost:1234/v1` |
| llama-swap on a LAN GPU box | already running | `LLM_BASE_URL=http://192.168.1.50:11434/v1`, `LLM_MODEL=qwen27b` |

**Tool calling.** The tutor uses OpenAI-style function calling. llama.cpp needs `--jinja` for that,
and vLLM needs the two tool flags above. If the endpoint refuses tools, the app switches by itself to
a fallback, where the model writes tool calls as ```` ```tool ```` JSON blocks. Set `LLM_TOOL_MODE=json`
to force the fallback, or `native` to turn it off.

**Thinking models.** `<think>…</think>` text is stripped before the student sees anything. To turn
thinking off on servers that support it, pass extra request fields with, for example,
`LLM_EXTRA_BODY={"chat_template_kwargs":{"enable_thinking":false}}`.

**Request labels.** For private-network endpoints, every request carries
`X-HKOS-Requester: desmos-tutor.tutor` (or `.simulate`) and `X-HKOS-Trace`. These headers are
never sent to outside providers.

## Student data and cloud providers

**Real students: use a local model only.** Then nothing a student types or graphs leaves the machine.

`.env.example` also has commented-out presets for Gemini's OpenAI-compatible endpoint, OpenRouter
and Groq. These are **for development and testing with fake students only.** Those providers may
log or train on everything sent to them.

`PROVIDER_TRAINS_ON_DATA` controls demo mode. If you leave it unset, it's `false` for localhost and
private-network addresses (10.x, 172.16–31.x, 192.168.x, Tailscale 100.64–127.x, `.local`) and `true`
for everything else. When it's `true`:

- a yellow banner says *"Demo mode — don't type your real name or personal info"*;
- nicknames are auto-generated (like "Blue Heron 42"), and the nickname field is hidden. The server
  ignores any typed name.

Setting it to `false` for a cloud endpoint removes those guards. Only do that if a data agreement
covers the endpoint (for example, a school's own Vertex AI project in a later version).

## Desmos API key

`.env.example` ships the **public demo key** from the Desmos API docs. It's fine for local
development. **Deploying anywhere needs your own key** (https://www.desmos.com/my-api): set
`DESMOS_API_KEY` in `.env`.

## Problems

Problems live in `problems/*.json`:

```json
{
  "id": "a-quadratic-vertex",
  "title": "…",
  "statement": "student-facing text",
  "goal": "teacher-facing: what mastery looks like",
  "common_misconceptions": ["…"],
  "hint_ladder": ["vague", "…", "specific"],
  "starter_expressions": [
    { "id": "tutor_target", "latex": "y=…", "owner": "tutor", "lineStyle": "DASHED", "secret": true, "readonly": true },
    { "id": "s_a", "latex": "a=1", "sliderBounds": { "min": "-5", "max": "5", "step": "0.5" } }
  ]
}
```

Starters with `"owner": "tutor"` are locked: the tutor can't remove them either. `secret` hides the
equation in the expression list, so the student only sees the curve.

## How the tutor can (and can't) touch the graph

The tutor can add, remove and highlight **only expressions whose id starts with `tutor_`.** The code
enforces this, not just the prompt: `shared/guard.ts` runs on the server before an action is sent
and again in the browser before the calculator is touched. Highlighting draws a temporary tutor
copy on top, so the student's expression is never modified. `test/guard.test.ts` tries to break this
at every layer.

## Prompt tuning

```sh
npm run simulate              # fake student works problem (a) against the model in .env
npm run simulate -- --verbose # include tool results
npm run simulate -- --save    # also save the run so /teacher can replay it
```

The script flags answer leaks and turns that break the length rules, and it checks whether the tutor
plotted the vertex when the student got stuck.

## Other settings

| Variable | Default | |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `3001` | API server. Vite (5173) proxies `/api` to it. |
| `DB_PATH` | `data/tutor.db` | SQLite file (gitignored). |
| `NUDGES_ENABLED` | `false` | Tutor speaks up after `IDLE_NUDGE_SECONDS` (90) idle, or after 3+ edits without chat. |
| `FEATURE_GOOGLE_SIGNIN` | `false` | Stub only in v0.1. |
| `LLM_TEMPERATURE` / `LLM_MAX_TOKENS` | `0.4` / `1024` | |

## Scripts

`npm run dev` · `npm test` · `npm run typecheck` · `npm run build` then `npm start` (serves the
built frontend from the API server) · `npm run simulate`

## Layout

```
server/      Fastify API: app.ts (routes), llm.ts (the only model client), tutor.ts (turn loop),
             tools.ts (tool specs + guard), math.ts (LaTeX → mathjs checker), db.ts (SQLite),
             config.ts, privacy.ts, auth/google.ts (stub)
shared/      Used by server and browser: types, graph diff, tutor-id guard
web/         Vite frontend: index.html (student), teacher.html (timeline + replay)
problems/    Problem files
prompts/     tutor_system.md, the editable Socratic policy
scripts/     simulate.ts, ensure-env.ts
test/        vitest
```

## License

MIT. See `LICENSE`. Desmos is a trademark of Desmos Studio PBC; this project is not affiliated with it.
