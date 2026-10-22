// The tutor's math tools: step checking (mathjs) and the SymPy sidecar client.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { createToolHost } from '../server/tools.ts';
import { SessionStore } from '../server/sessions.ts';
import { loadProblems } from '../server/problems.ts';

const problems = loadProblems(resolve(import.meta.dirname, '..', 'problems'));

function setup(sympyUrl?: string) {
  const s = new SessionStore().create(problems.get('a-quadratic-vertex')!, 'test');
  const host = createToolHost(() => new Set(), {}, { sympyUrl });
  const call = (name: string, args: unknown): Promise<any> => host.execute(s, { id: 'x', name, args, rawArgs: JSON.stringify(args) }, () => {});
  return { host, s, call };
}

afterEach(() => vi.unstubAllGlobals());

describe('check_equivalent tool', () => {
  it('judges a step', async () => {
    const { call } = setup();
    expect((await call('check_equivalent', { before: '2\\left(x+3\\right)=10', after: 'x+3=5' })).equivalent).toBe(true);
    expect((await call('check_equivalent', { before: '\\left(x-2\\right)^{2}', after: 'x^{2}-4' })).equivalent).toBe(false);
  });

  it('returns an error, not a crash, for bad input', async () => {
    const { call } = setup();
    expect((await call('check_equivalent', { before: 'x+1=2', after: 'x+1' })).error).toBeDefined();
    expect((await call('check_equivalent', {})).error).toBeDefined();
  });
});

describe('symbolic tool', () => {
  it('is only offered when a sidecar is configured', () => {
    const names = (url?: string) => setup(url).host.specs().map((t) => t.name);
    expect(names()).not.toContain('symbolic');
    expect(names('http://127.0.0.1:3002')).toContain('symbolic');
  });

  it('sends mathjs text, never LaTeX, and splits equations', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, result: '[2]', latex: '\\left[ 2\\right]', variable: 'x' }));
    vi.stubGlobal('fetch', fetchMock);
    const { call } = setup('http://127.0.0.1:3002');
    const r = await call('symbolic', { op: 'solve', latex: '2\\left(x+3\\right)=10' });
    expect(r).toEqual({ result: '\\left[ 2\\right]', plain: '[2]', variable: 'x' });
    const sent = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(sent).toMatchObject({ op: 'solve', expr: '2*(x+3)', rhs: '10' });
  });

  it('says so when the sidecar is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const { call } = setup('http://127.0.0.1:3002');
    expect((await call('symbolic', { op: 'factor', latex: 'x^{2}-1' })).error).toMatch(/not running/);
  });

  it('rejects unknown ops before calling the sidecar', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { call } = setup('http://127.0.0.1:3002');
    expect((await call('symbolic', { op: 'eval', latex: 'x' })).error).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
