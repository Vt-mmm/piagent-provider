import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { JsonLines } from './json.mjs';

const TIMEOUT_MS = 25_000;
const WSL = ['WSL_INTEROP', 'WSL_DISTRO_NAME'];

// The broker is Agent Watch's `managed-broker`: JSON lines on stdio, one
// request at a time. It holds the member's key; this client never sees it,
// only the run grants it hands out. The child gets a minimal environment.
export class BrokerClient {
  #child; #pending = new Map(); #tail = Promise.resolve(); #closed = false;
  constructor({ executable, profileID, spawnImpl = spawn, environment = process.env }) {
    if (!path.isAbsolute(executable) || fs.realpathSync(executable) !== executable || !/^[a-f0-9]{64}$/.test(profileID)) throw Error('managed-broker-binding-invalid');
    const env = { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', ...Object.fromEntries(WSL.filter(name => environment[name]).map(name => [name, environment[name]])) };
    this.#child = spawnImpl(executable, ['managed-broker', '--profile', profileID], { stdio: ['pipe', 'pipe', 'pipe'], env });
    const lines = new JsonLines();
    this.#child.stdin.on('error', () => this.#fail());
    this.#child.on('error', () => this.#fail());
    this.#child.on('close', () => this.#fail());
    this.#child.stderr.on('data', () => {});
    this.#child.stdout.on('data', chunk => {
      try { for (const message of lines.feed(chunk)) this.#answer(message); } catch { this.#child.kill(); this.#fail(); }
    });
  }
  #fail() {
    this.#closed = true;
    for (const item of this.#pending.values()) { clearTimeout(item.timer); item.reject(Error('managed-broker-disconnected')); }
    this.#pending.clear();
  }
  #answer(message) {
    const item = this.#pending.get(message.id);
    if (!item) throw Error('unexpected-broker-response');
    clearTimeout(item.timer); this.#pending.delete(message.id);
    if (!message.error) { item.resolve(message.result); return; }
    // Agent Watch's coarse error stays the message (start and renewal decide
    // on it); Studio's own reason rides along for the member.
    const error = Error(`managed-broker:${String(message.error).replace(/[^a-zA-Z_]/g, '').slice(0, 80)}`);
    if (/^[a-z0-9_]{1,64}$/.test(message.studio_code ?? '')) error.studioCode = message.studio_code;
    item.reject(error);
  }
  request(action, args = {}) {
    const next = this.#tail.then(() => new Promise((resolve, reject) => {
      if (this.#closed) { reject(Error('managed-broker-disconnected')); return; }
      const id = randomUUID();
      const timer = setTimeout(() => { this.#child.kill(); reject(Error('managed-broker-timeout')); }, TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(`${JSON.stringify({ ...args, id, action })}\n`);
    }));
    this.#tail = next.catch(() => {});
    return next;
  }
  async dispose() {
    if (this.#closed) return;
    try { await this.request('close'); } catch { /* the child is killed next */ }
    this.#child.stdin.end(); this.#child.kill(); this.#closed = true;
  }
}
