// Decides whether the LLM endpoint is on this machine / a private network.
// Anything else is treated as a provider that may train on what we send it.

import { isIP } from 'node:net';

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.lan')) return true;
  if (h.endsWith('.ts.net')) return true; // Tailscale MagicDNS
  const kind = isIP(h);
  if (kind === 4) {
    const [a, b] = h.split('.').map(Number);
    if (a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT range, which Tailscale uses
    return false;
  }
  if (kind === 6) {
    if (h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true; // unique local
    if (h.startsWith('fe80')) return true;
    return false;
  }
  return false;
}

export function isPrivateUrl(url: string): boolean {
  try {
    return isPrivateHost(new URL(url).hostname);
  } catch {
    return false;
  }
}
