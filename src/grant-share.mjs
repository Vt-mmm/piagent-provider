// Every renew replaces the role's token. Requests of one role running side by
// side, and a helper refreshing main beside main's own request, share one
// renew, so none voids a sibling's token before Studio admits its request.
// The share lasts while one of them still runs, at most a minute (the lease
// is two). `owner` holds `broker` and `sharedGrants`.
const SHARE_MS = 60_000;

export function shareGrant(owner, role, now = Date.now()) {
  owner.sharedGrants ??= new Map();
  const shared = owner.sharedGrants.get(role);
  if (shared && now - shared.at < SHARE_MS) { shared.users++; return shared; }
  return seedGrant(owner, role, owner.broker.request('renew', slotArgs(role)), now, 1);
}

// A grant already renewed for the role (the turn start's) joins the share.
export function seedGrant(owner, role, grant, now = Date.now(), users = 0) {
  owner.sharedGrants ??= new Map();
  const entry = { at: now, users, grant: Promise.resolve(grant) };
  entry.grant.catch(() => { if (owner.sharedGrants.get(role) === entry) owner.sharedGrants.delete(role); });
  owner.sharedGrants.set(role, entry);
  return entry;
}

export function releaseGrant(owner, role, entry) {
  if (--entry.users <= 0 && owner.sharedGrants?.get(role) === entry) owner.sharedGrants.delete(role);
}

// A helper the member asked for beside another of its role holds a grant of
// its own: its key is role#slot (slot 2 or 3), the broker's {role, slot}.
export const baseRole = key => String(key).split('#')[0];
export function slotArgs(key) {
  const [role, slot] = String(key).split('#');
  return slot ? { role, slot: Number(slot) } : { role };
}
