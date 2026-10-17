// Runs before `npm run dev`: creates .env from .env.example the first time, so a fresh
// clone comes up with the Desmos demo key and the local-model defaults.

import { copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const env = resolve(root, '.env');
if (!existsSync(env)) {
  copyFileSync(resolve(root, '.env.example'), env);
  console.log('Created .env from .env.example (local model, Desmos demo key). Edit it to point at your model server.');
}
