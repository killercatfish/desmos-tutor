// Splits a streamed model reply into what the student should see and what they shouldn't:
// <think>…</think> reasoning is dropped, and tool calls written as text (```tool {json}``` or
// Qwen-style <tool_call>{json}</tool_call>) are pulled out. Markers may arrive split across chunks.

export type FilterOut =
  | { type: 'text'; text: string }
  | { type: 'tool_text'; raw: string }
  /** The model closed a think block it never opened: everything shown so far was reasoning. */
  | { type: 'reset' };

interface Block {
  open: string;
  close: string;
  kind: 'think' | 'tool';
}

const BLOCKS: Block[] = [
  { open: '<think>', close: '</think>', kind: 'think' },
  { open: '```tool', close: '```', kind: 'tool' },
  { open: '<tool_call>', close: '</tool_call>', kind: 'tool' },
];
const STRAY_CLOSE = '</think>';
const MARKERS = [...BLOCKS.map((b) => b.open), STRAY_CLOSE];

export class StreamFilter {
  private buf = '';
  private inside: Block | null = null;
  private emittedVisible = false;

  push(chunk: string): FilterOut[] {
    this.buf += chunk;
    return this.drain(false);
  }

  end(): FilterOut[] {
    return this.drain(true);
  }

  private drain(final: boolean): FilterOut[] {
    const out: FilterOut[] = [];
    for (;;) {
      if (this.inside) {
        const i = this.buf.indexOf(this.inside.close);
        if (i < 0) {
          if (final) {
            if (this.inside.kind === 'tool') out.push({ type: 'tool_text', raw: this.buf });
            this.buf = '';
            this.inside = null;
          }
          return out;
        }
        if (this.inside.kind === 'tool') out.push({ type: 'tool_text', raw: this.buf.slice(0, i) });
        this.buf = this.buf.slice(i + this.inside.close.length);
        this.inside = null;
        continue;
      }

      // Earliest marker in the buffer.
      let best: { at: number; marker: string } | null = null;
      for (const m of MARKERS) {
        const at = this.buf.indexOf(m);
        if (at >= 0 && (!best || at < best.at)) best = { at, marker: m };
      }
      if (best) {
        this.emit(out, this.buf.slice(0, best.at));
        this.buf = this.buf.slice(best.at + best.marker.length);
        if (best.marker === STRAY_CLOSE) {
          out.push({ type: 'reset' });
          this.emittedVisible = false;
        } else {
          this.inside = BLOCKS.find((b) => b.open === best!.marker)!;
        }
        continue;
      }

      // No marker yet: emit everything except a tail that could be the start of one.
      const keep = final ? 0 : longestMarkerPrefixSuffix(this.buf);
      this.emit(out, this.buf.slice(0, this.buf.length - keep));
      this.buf = this.buf.slice(this.buf.length - keep);
      return out;
    }
  }

  private emit(out: FilterOut[], text: string): void {
    if (!text) return;
    // Trim leading whitespace at the start of the visible reply (left over after a think block).
    if (!this.emittedVisible) text = text.replace(/^\s+/, '');
    if (!text) return;
    this.emittedVisible = true;
    const last = out[out.length - 1];
    if (last?.type === 'text') last.text += text;
    else out.push({ type: 'text', text });
  }
}

function longestMarkerPrefixSuffix(s: string): number {
  let best = 0;
  for (const m of MARKERS) {
    for (let n = Math.min(m.length - 1, s.length); n > best; n--) {
      if (s.endsWith(m.slice(0, n))) {
        best = n;
        break;
      }
    }
  }
  return best;
}

/** Parses a tool call written as text: {"name": ..., "arguments": {...}}. */
export function parseToolText(raw: string): { name: string; args: unknown } | null {
  const s = raw.trim().replace(/^json\s*/i, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    const name = obj.name ?? obj.tool ?? obj.function;
    if (typeof name !== 'string') return null;
    let args = obj.arguments ?? obj.args ?? obj.parameters ?? {};
    if (typeof args === 'string') args = JSON.parse(args);
    return { name, args };
  } catch {
    return null;
  }
}
