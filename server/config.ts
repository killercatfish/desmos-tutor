import 'dotenv/config';
import { resolve } from 'node:path';
import { isPrivateUrl } from './privacy.ts';

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

function jsonObject(v: string | undefined, name: string): Record<string, unknown> | undefined {
  if (!v?.trim()) return undefined;
  const o = JSON.parse(v);
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`${name} must be a JSON object`);
  return o;
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) ? n : fallback;
}

export interface Config {
  root: string;
  host: string;
  port: number;
  dbPath: string;
  desmosApiKey: string;
  desmosApiVersion: string;
  llm: {
    baseUrl: string;
    model: string;
    apiKey?: string;
    /** 'auto' tries native tool calling and falls back to JSON blocks if the endpoint refuses. */
    toolMode: 'auto' | 'native' | 'json';
    /** 'auto' streams and falls back to one-shot replies if the endpoint can't stream. */
    stream: 'auto' | 'true' | 'false';
    /** Extra request fields for the one retry after an empty reply, e.g. thinking off (LLM_RETRY_EXTRA_BODY). */
    retryExtraBody?: Record<string, unknown>;
    temperature: number;
    maxTokens: number;
    isPrivate: boolean;
  };
  providerTrainsOnData: boolean;
  /** SymPy sidecar for the `symbolic` tool; empty turns the tool off. */
  sympyUrl: string;
  nudgesEnabled: boolean;
  idleNudgeSeconds: number;
  googleSignIn: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const root = resolve(import.meta.dirname, '..');
  const baseUrl = (env.LLM_BASE_URL || 'http://localhost:8080/v1').replace(/\/+$/, '');
  const isPrivate = isPrivateUrl(baseUrl);
  const toolMode = (env.LLM_TOOL_MODE || 'auto') as Config['llm']['toolMode'];
  const stream = (env.LLM_STREAM || 'auto').trim().toLowerCase() as Config['llm']['stream'];
  return {
    root,
    host: env.HOST || '127.0.0.1',
    port: num(env.PORT, 3001),
    dbPath: resolve(root, env.DB_PATH || 'data/tutor.db'),
    desmosApiKey: env.DESMOS_API_KEY || '',
    desmosApiVersion: env.DESMOS_API_VERSION || 'v1.11',
    llm: {
      baseUrl,
      model: env.LLM_MODEL || 'qwen27b',
      apiKey: env.LLM_API_KEY || undefined,
      toolMode: ['auto', 'native', 'json'].includes(toolMode) ? toolMode : 'auto',
      stream: ['auto', 'true', 'false'].includes(stream) ? stream : 'auto',
      retryExtraBody: jsonObject(env.LLM_RETRY_EXTRA_BODY, 'LLM_RETRY_EXTRA_BODY'),
      temperature: num(env.LLM_TEMPERATURE, 0.4),
      maxTokens: num(env.LLM_MAX_TOKENS, 1024),
      isPrivate,
    },
    // Default: assume a non-private endpoint trains on our data. Explicit env wins.
    providerTrainsOnData: bool(env.PROVIDER_TRAINS_ON_DATA, !isPrivate),
    sympyUrl: env.SYMPY_URL === undefined ? 'http://127.0.0.1:3002' : env.SYMPY_URL.trim(),
    nudgesEnabled: bool(env.NUDGES_ENABLED, false),
    idleNudgeSeconds: num(env.IDLE_NUDGE_SECONDS, 90),
    googleSignIn: bool(env.FEATURE_GOOGLE_SIGNIN, false),
  };
}
