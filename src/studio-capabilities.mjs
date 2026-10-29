import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CLIENT_AGENT } from './client-agent.mjs';
import { parseJson } from './json.mjs';

// What this Studio serves beyond the base API (GET /v1/capabilities, Agent
// Studio 0.34+): one name per contract and version, such as
// "requests.cancel.v1". A newer operation is used only when its name is
// listed. A Studio without the route (404) has no list: callers keep their old
// behaviour for it. Unknown names are ignored; a failed read keeps the last
// answer this machine had for the same Studio scope. Asked when a round
// starts, at most once an hour, kept in <stateDir>/studio-capabilities.json.
const FRESH_MS = 3_600_000, KEEP_MS = 7 * 24 * 3_600_000, TIMEOUT_MS = 3_000;
const NAME = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*\.v[0-9]+$/;
const FILE = 'studio-capabilities.json';

// The Studio scope: the origin, the key and member, and the authority epoch.
export function scopeID(origin, manifest) {
  const a = manifest?.authority;
  if (!manifest?.key_id || !manifest?.user?.id || !a?.studio_instance_id || !a?.dataset_epoch || !Number.isInteger(a.auth_generation)) return null;
  const scope = { origin, key_id: String(manifest.key_id).toLowerCase(), user_id: String(manifest.user.id).toLowerCase(), ...a };
  return createHash('sha256').update(JSON.stringify(scope)).digest('hex');
}

function read(stateDir, scope, now) {
  const kept = parseJson(safeRead(path.join(stateDir, FILE)));
  if (!kept || kept.scope !== scope || (kept.names !== null && !Array.isArray(kept.names)) || now - kept.at > KEEP_MS) return null;
  return kept;
}
function safeRead(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }

// The capabilities last heard from this Studio scope on this machine, or null
// when there is no list (none heard, long ago, or a Studio older than 0.34).
export function knownCapabilities(stateDir, origin, manifest, now = Date.now()) {
  const scope = scopeID(origin, manifest), kept = stateDir && scope ? read(stateDir, scope, now) : null;
  return kept?.names ? new Set(kept.names) : null;
}

export const hasCapability = (self, name) => !!self?.capabilities?.has(name);

// Refreshes self.capabilities for the round's grant; never fails the round.
export async function refreshCapabilities(self, grant, { stateDir = self.stateDir, fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now() } = {}) {
  const scope = scopeID(self.origin, self.manifest);
  const kept = stateDir && scope ? read(stateDir, scope, now) : null;
  if (kept) self.capabilities = kept.names ? new Set(kept.names) : null;
  if (kept && now - kept.at < FRESH_MS) return self.capabilities ?? null;
  if (!grant?.token || !self.origin) return self.capabilities ?? null;
  try {
    const response = await fetchImpl(`${self.origin}/v1/capabilities`, { signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Authorization: `Bearer ${grant.token}`, Accept: 'application/json', 'User-Agent': CLIENT_AGENT } });
    let names;
    if (response.status === 404) { void response.body?.cancel?.().catch(() => {}); names = null; }
    else if (response.ok) {
      const answer = await response.json();
      names = Array.isArray(answer?.capabilities) ? answer.capabilities.filter(n => typeof n === 'string' && NAME.test(n)).slice(0, 200) : [];
    } else { void response.body?.cancel?.().catch(() => {}); return self.capabilities ?? null; }
    self.capabilities = names ? new Set(names) : null;
    if (stateDir && scope) {
      const file = path.join(stateDir, FILE), temporary = `${file}.${process.pid}.tmp`;
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, JSON.stringify({ scope, at: now, names }), { mode: 0o600 });
      fs.renameSync(temporary, file);
    }
  } catch { /* the last answer, if any, stays */ }
  return self.capabilities ?? null;
}
