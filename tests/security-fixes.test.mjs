import assert from 'node:assert/strict';
import { test } from 'node:test';
import { busCallAllowed } from '../src/bus.mjs';
import { purposeHeaders } from '../src/call-purpose.mjs';
import { redact } from '../src/redact.mjs';
import { NEEDLES, SECRETS } from './fixtures/secret-corpus.mjs';

// Regression tests for docs/security-review.md (T1 studio.call, T5). Synthetic strings only.
test('T1: piagent:studio.call reaches only the paths the harness uses, so another extension cannot spend the run on a model call', () => {
  for (const path of ['/studio/v1/managed/tool-failures', '/v1/managed/settle', '/v1/memory/search', '/v1/memory/retain']) assert.ok(busCallAllowed(path), path);
  for (const path of ['/v1/chat/completions', '/v1/messages', '/v1/requests/abc/cancel', '/v1/models', '/studio/v1/managed/disconnects', '/v1/memory/', '/v1/memory/search?x=1', '/v1/memory/../x',
    '/studio/v1/managed/x', '/v1/', undefined, 7]) assert.ok(!busCallAllowed(path), String(path));
});

test('T5: every secret shape of the corpus is redacted from text that leaves the provider', () => {
  for (const [i, secret] of SECRETS.entries()) assert.ok(!redact(`upstream said ${secret} end`).includes(NEEDLES[i]), `leaked: ${NEEDLES[i]}`);
});

test('T5: no prompt text goes to Studio in a call header: a helper\'s brief title is never sent', () => {
  const owner = { jobTitles: new Map([['scout', 'Find where the login token is kept']]), nextPurpose: null };
  const headers = purposeHeaders(owner, 'scout', { messages: [{ role: 'user', content: 'x' }] });
  assert.deepEqual(Object.keys(headers), ['X-Agent-Purpose']);
  assert.ok(!JSON.stringify(headers).includes('login'));
});

test('T1: with the bus secret, studio.call, grant.request and run.process from a stranger are refused', async () => {
  const { setup } = await import('./helpers/setup.mjs');
  const { serveNonce, withNonce } = await import('../src/bus-nonce.mjs');
  const ask = (pi, channel, payload) => new Promise(resolve => pi.events.emit(channel, { v: 1, ...payload, reply: resolve }));
  const t = await setup({ beforeLoad: pi => serveNonce(pi.events) });
  try {
    await t.pi.fire('before_agent_start', { messageType: 'user', prompt: 'x' });
    const forged = await ask(t.pi, 'piagent:studio.call', { method: 'POST', path: '/studio/v1/managed/tool-failures', body: {} });
    assert.deepEqual([forged.ok, forged.error], [false, 'managed-bus-nonce']);
    const grant = await ask(t.pi, 'piagent:grant.request', { role: 'scout' });
    assert.equal(grant.ok, false);
    const real = await new Promise(resolve => t.pi.events.emit('piagent:studio.call', withNonce(t.pi.events, { v: 1, method: 'POST', path: '/studio/v1/managed/tool-failures', body: {}, reply: resolve })));
    assert.equal(real.ok, true, real.error);
  } finally { await t.cleanup(); }
});

test('L3: a binding that others can write, or that belongs to someone else, is refused', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { readBinding } = await import('../src/index.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binding-')), file = path.join(dir, 'binding.json');
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, origin: 'https://aw.example.test', profile_id: 'a'.repeat(64), broker: '/x/broker' }));
  fs.chmodSync(file, 0o600);
  assert.equal(readBinding(file).origin, 'https://aw.example.test');
  fs.chmodSync(file, 0o666);
  assert.throws(() => readBinding(file), /managed-binding-untrusted/);
  fs.chmodSync(file, 0o620);
  assert.throws(() => readBinding(file), /managed-binding-untrusted/);
});
