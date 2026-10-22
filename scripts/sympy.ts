// `npm run sympy` (and `npm run dev`): starts the SymPy sidecar if its venv exists.
// `npm run sympy:setup`: creates sidecar/.venv and installs SymPy.

import { spawnSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const venv = resolve(root, 'sidecar/.venv');
const py = resolve(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

if (process.argv.includes('--setup')) {
  const base = process.platform === 'win32' ? 'python' : 'python3';
  for (const args of [[base, '-m', 'venv', venv], [py, '-m', 'pip', 'install', '-q', '-r', resolve(root, 'sidecar/requirements.txt')]]) {
    const r = spawnSync(args[0], args.slice(1), { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  console.log('SymPy sidecar ready. It starts with `npm run dev`, or alone with `npm run sympy`.');
} else if (!existsSync(py)) {
  console.log('SymPy sidecar not set up (optional): run `npm run sympy:setup` to enable the symbolic tool.');
} else {
  const port = new URL(process.env.SYMPY_URL || 'http://127.0.0.1:3002').port || '3002';
  const child = spawn(py, [resolve(root, 'sidecar/sympy_server.py'), '--port', port], { stdio: 'inherit' });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
  child.on('exit', (code) => process.exit(code ?? 0));
}
