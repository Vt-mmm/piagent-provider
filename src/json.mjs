// The one JSON reader of the provider: text in, a value or the fallback out,
// plus the framing of the broker's JSON-lines stream.
import { StringDecoder } from 'node:string_decoder';

// The fallback may be `undefined` on purpose: it tells "not JSON" from `null`.
export function parseJson(text, ...fallback) {
  try { return JSON.parse(text); } catch { return fallback.length ? fallback[0] : null; }
}

// Newline-delimited JSON over a byte stream. `feed` returns the objects of
// the complete lines; it throws when a line does not parse or the unfinished
// tail grows past `limit` bytes, so a broken peer cannot grow memory.
export class JsonLines {
  #tail = ''; #decoder = new StringDecoder('utf8');
  constructor(limit = 2 * 1024 * 1024) { this.limit = limit; }
  feed(chunk) {
    this.#tail += this.#decoder.write(chunk);
    if (Buffer.byteLength(this.#tail) > this.limit) throw Error('json-lines-too-long');
    const out = [];
    for (let end = this.#tail.indexOf('\n'); end >= 0; end = this.#tail.indexOf('\n')) {
      const line = this.#tail.slice(0, end);
      this.#tail = this.#tail.slice(end + 1);
      if (!line.trim()) continue;
      const value = parseJson(line, undefined);
      if (value === undefined) throw Error('json-lines-invalid');
      out.push(value);
    }
    return out;
  }
}
