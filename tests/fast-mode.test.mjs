import test from 'node:test';
import assert from 'node:assert/strict';
import { declineFast, fastAllowed, fastPayload, fastRefusal, fastServed, fastState, recordFast, restoreFast, setFast } from '../src/fast-mode.mjs';

const manifest = fast => ({ harness: { configuration: { main: { mode: 'fixed', model_ids: ['m'] }, ...(fast === undefined ? {} : { fast_mode: fast }) } } });
function entries() {
  const list = [];
  return { stored: list, list: () => list, append: (customType, data) => list.push({ type: 'custom', customType, data }) };
}

test('fast mode exists only where the Harness allows it, and starts off', () => {
  assert.equal(fastAllowed(manifest()), false); assert.equal(fastAllowed(manifest(false)), false);
  assert.equal(fastAllowed(manifest('true')), false); assert.equal(fastAllowed(manifest(true)), true);
  const closed = { manifest: manifest(), entries: entries() };
  closed.fast = restoreFast(closed.entries); recordFast(closed);
  assert.equal(fastState(closed), null);
  assert.throws(() => setFast(closed, true), /managed-fast-unavailable/);
  const open = { manifest: manifest(true), entries: entries() };
  open.fast = restoreFast(open.entries); recordFast(open);
  assert.equal(fastState(open), 'off');
  assert.equal(setFast(open, true), true); assert.equal(setFast(open, true), false, 'already on');
  assert.equal(fastState(open), 'on'); assert.equal(restoreFast(open.entries), true, 'kept with the conversation');
  // The administrator turns fast mode off in the Harness: the conversation follows.
  open.manifest = manifest(false); recordFast(open);
  assert.equal(open.fast, false); assert.equal(fastState(open), null); assert.equal(restoreFast(open.entries), false);
});

test("only the main agent's call on a model that serves fast mode asks for the priority tier", async () => {
  const on = { manifest: manifest(true), fast: true }, codex = { provider: 'codex', native: 'gpt-6-astra' }, body = { model: 'gpt', input: 'x' };
  assert.deepEqual(await fastPayload(on, 'main', codex)(body, {}), { model: 'gpt', input: 'x', service_tier: 'priority' });
  assert.equal(body.service_tier, undefined, "the caller's payload is not changed in place");
  assert.deepEqual(await fastPayload(on, 'main', codex, async p => ({ ...p, store: false }))(body, {}), { model: 'gpt', input: 'x', store: false, service_tier: 'priority' });
  const earlier = () => undefined;
  assert.equal(fastPayload(on, 'review', codex, earlier), earlier, 'subagents run as usual');
  assert.equal(fastPayload({ manifest: manifest(true), fast: false }, 'main', codex, earlier), earlier, 'off until the member turns it on');
  assert.equal(fastPayload({ manifest: manifest(false), fast: true }, 'main', codex, earlier), earlier, 'the Harness stopped allowing it');
  const others = [{ provider: 'claude', native: 'claude-opus-5-5' }, { provider: 'deepseek', native: 'deepseek-v4-pro' },
    { provider: 'codex', native: 'gpt-4-old' }, { provider: 'codex' }, undefined];
  for (const route of others) {
    assert.equal(fastServed(route), false, JSON.stringify(route));
    assert.equal(fastPayload(on, 'main', route, earlier), earlier, JSON.stringify(route));
  }
  for (const native of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.5']) assert.equal(fastServed({ provider: 'codex', native }), true, native);
});

test('a refused fast request puts the conversation back to standard speed', () => {
  assert.equal(fastRefusal('policy_denied'), true); assert.equal(fastRefusal('upstream_request_rejected'), true);
  for (const code of ['token_quota_exhausted', 'upstream_rate_limited', 'concurrency_limit', 'upstream_interrupted', 'studio-unreachable']) assert.equal(fastRefusal(code), false, code);
  const notices = [], owner = { manifest: manifest(true), fast: true, entries: entries(), notify: n => notices.push(n) };
  recordFast(owner);
  declineFast(owner, 'policy_denied');
  assert.equal(owner.fast, false); assert.equal(restoreFast(owner.entries), false);
  assert.equal(notices.length, 1); assert.match(notices[0].content, /policy_denied.*standard speed/); assert.equal(notices[0].customType, 'agent-watch-fast-notice');
  const earlier = () => undefined;
  assert.equal(fastPayload(owner, 'main', { provider: 'codex', native: 'gpt-6-sol' }, earlier), earlier, 'the next ask carries no tier');
  const bare = { manifest: manifest(true), fast: true, entries: entries() };
  declineFast(bare, 'upstream_request_rejected'); assert.equal(bare.fast, false);
});
