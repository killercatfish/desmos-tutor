// Auto-generated nicknames for demo mode, e.g. "Blue Heron 42".

const COLORS = ['Blue', 'Green', 'Amber', 'Coral', 'Silver', 'Violet', 'Teal', 'Crimson', 'Golden', 'Indigo', 'Olive', 'Rusty'];
const ANIMALS = ['Heron', 'Otter', 'Falcon', 'Badger', 'Lynx', 'Puffin', 'Marten', 'Ibis', 'Gecko', 'Bison', 'Wren', 'Orca'];

export function generateNickname(rand: () => number = Math.random): string {
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  return `${pick(COLORS)} ${pick(ANIMALS)} ${10 + Math.floor(rand() * 90)}`;
}

/** Typed nicknames: trimmed, short, printable. Empty -> null. */
export function cleanNickname(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 40);
  return s || null;
}
