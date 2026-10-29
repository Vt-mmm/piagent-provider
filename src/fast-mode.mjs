// Fast mode of a company conversation. The member turns it on per
// conversation, and only where the team's Harness in Studio allows it
// (harness.configuration.fast_mode); a conversation starts with it off. While
// on, the main agent's calls ask a Codex model for the priority service tier:
// the same model and thinking level, answered faster, at a higher rate Studio
// decides (and refuses for a run whose Harness does not allow it).
//
// `owner` holds `manifest`, `fast` and `entries`: { list(), append(type, data) }
// over the conversation's custom entries (pi.appendEntry in a session).
const ENTRY = 'agent-watch-fast';
export const NOTICE = 'agent-watch-fast-notice';
export const FAST_SERVICE_TIER = 'priority';

export const fastAllowed = manifest => manifest?.harness?.configuration?.fast_mode === true;
const recorded = entries => entries.list().filter(e => e.type === 'custom' && e.customType === ENTRY).at(-1)?.data;
export const restoreFast = entries => recorded(entries)?.enabled === true;
// The conversation records whether its Harness allows fast mode, so a front
// end shows the switch (or not); a Harness that stopped allowing it turns it off.
export function recordFast(owner) {
  const allowed = fastAllowed(owner.manifest), last = recorded(owner.entries);
  if (!allowed) owner.fast = false;
  if ((last?.allowed === true) === allowed && (last?.enabled === true) === Boolean(owner.fast)) return;
  owner.entries.append(ENTRY, { enabled: Boolean(owner.fast), allowed, at: new Date().toISOString() });
}
// "on" | "off" where the Harness allows fast mode, else null (no switch).
export const fastState = owner => fastAllowed(owner.manifest) ? owner.fast ? 'on' : 'off' : null;
export function setFast(owner, enabled) {
  if (enabled && !fastAllowed(owner.manifest)) throw Error('managed-fast-unavailable');
  if (Boolean(enabled) === Boolean(owner.fast)) return false;
  owner.fast = Boolean(enabled);
  owner.entries.append(ENTRY, { enabled: owner.fast, allowed: fastAllowed(owner.manifest), at: new Date().toISOString() });
  return true;
}
// Where fast mode is served, as Studio admits it (a model missing here runs at
// standard speed). Codex (Responses): service_tier "priority" on the models
// OpenAI's speed documentation names, checked 2026-10-13. Claude and the
// API-key vendors have no such tier.
const CODEX_FAST = new Set(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.5']);
export const fastServed = route => route?.provider === 'codex' && CODEX_FAST.has(route.native);
// Studio's refusal of the tier, or the provider's of a request carrying it:
// asked again once without it.
export const fastRefusal = code => code === 'policy_denied' || code === 'upstream_request_rejected';
// A fast request was refused before the model did any work: the conversation
// goes back to standard speed and says so, instead of failing the turn.
export function declineFast(owner, code) {
  owner.fast = false;
  try {
    recordFast(owner);
    owner.notify?.({ customType: NOTICE, code,
      content: `Fast mode was refused for this request [${code}]: this conversation continues at standard speed. Turn Fast on again to retry.` });
  } catch { /* the request goes on at standard speed either way */ }
}
// The payload hook of one request: the main agent's call on a model that
// serves fast mode carries the tier while fast mode is on and still allowed.
export function fastPayload(owner, role, route, onPayload) {
  if (role !== 'main' || !owner.fast || !fastAllowed(owner.manifest) || !fastServed(route)) return onPayload;
  return async (payload, model) => {
    const next = (onPayload ? await onPayload(payload, model) : undefined) ?? payload;
    return next && typeof next === 'object' && !Array.isArray(next) ? { ...next, service_tier: FAST_SERVICE_TIER } : next;
  };
}
