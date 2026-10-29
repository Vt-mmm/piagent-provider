// Checks on what Agent Watch hands over: the Studio manifest, an origin and a
// run grant. A failed check throws a `managed-*` code failure.mjs describes.
import { isVendor } from './native-catalog.mjs';
import { slotArgs } from './grant-share.mjs';

export function usableManifest(manifest) {
  if (manifest?.schema_version !== 2 || manifest.credential_mode !== 'managed' || !manifest.authority || !manifest.harness) throw Error('managed-configuration-unavailable');
  return manifest;
}

const AUTHORITY = ['studio_instance_id', 'dataset_epoch', 'auth_generation'];
export const sameAuthority = (a, b) => AUTHORITY.every(k => a?.[k] === b?.[k]);
const TOKEN = /^as_run_[a-f0-9-]{36}_[\w-]{43}$/;

// A grant is Studio's, for this manifest's authority and this role (`key` is
// `role` or `role#slot`), a model the manifest lists, and a well-formed token.
export function verifyGrant(grant, manifest, key) {
  const { role, slot = 1 } = slotArgs(key);
  const listed = () => manifest.models.some(m => m.id === grant.model_id && m.owned_by === grant.provider && m.provider_model_id === grant.provider_model_id);
  const wellFormed = grant && sameAuthority(grant, manifest.authority) && grant.role === role && (grant.slot ?? 1) === slot
    && Number.isSafeInteger(grant.fence) && grant.fence >= 1 && TOKEN.test(grant.token) && (['claude', 'codex'].includes(grant.provider) || isVendor(grant.provider));
  if (!wellFormed || !listed()) throw Error('managed-grant-invalid');
}

// Only https, or http on a loopback address; no credentials, path, query or hash.
export function safeOrigin(origin) {
  const u = new URL(origin);
  const local = u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.username || u.password || u.search || u.hash || !['', '/'].includes(u.pathname) || (u.protocol !== 'https:' && !local)) throw Error('managed-origin-invalid');
  return u.origin;
}

// Effort for a run: the member's level, or the nearest one the Harness offers
// (Pi's rule for a level a model lacks: the next deeper, else the next shallower).
export const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function nearestLevel(level, allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0 || allowed.includes(level)) return level;
  const at = Math.max(0, LEVELS.indexOf(level));
  return LEVELS.slice(at).find(l => allowed.includes(l)) ?? LEVELS.slice(0, at).reverse().find(l => allowed.includes(l)) ?? allowed[0];
}

// Advisory size of the task, from the member's message; Studio owns allowed
// models, budgets and run authority.
export function taskClass(text) {
  const plain = String(text).normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd').toLowerCase();
  if (plain.length > 1500 || /\b(architecture|migration|security|concurrency|concurrent|race|deadlock)\b|kien truc|bao mat|be tac|tranh chap/u.test(plain)) return 'complex';
  return plain.length < 100 && !/\b(implement|fix|debug|refactor|review|build)\b|sua loi|trien khai|kiem tra/u.test(plain) ? 'simple' : 'standard';
}

// Levels the member may pick: those the native model has, the manifest lists,
// and, for each role the member's level matters to, some permitted candidate has.
export function nativeThinkingLevels(model) {
  if (!model?.reasoning) return ['off'];
  const map = model.thinkingLevelMap ?? {};
  return LEVELS.filter(level => map[level] !== null && (!['xhigh', 'max'].includes(level) || map[level] !== undefined));
}
export function allowedThinkingLevels(manifest, nativeOf, main) {
  const roles = Object.entries(manifest.harness.configuration).filter(([name, r]) => r && Array.isArray(r.model_ids) && (name === 'main' || r.effort == null)).map(([, r]) => r);
  const some = (role, level) => role.model_ids.some(id => {
    const entry = manifest.models.find(m => m.id === id), native = entry && nativeOf(entry);
    return native && nativeThinkingLevels(native).includes(level);
  });
  return nativeThinkingLevels(main).filter(level => (!Array.isArray(manifest.thinking_levels) || manifest.thinking_levels.includes(level)) && roles.every(role => some(role, level)));
}
