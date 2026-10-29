import test from 'node:test';
import assert from 'node:assert/strict';
import { collect } from './helpers/fake-pi.mjs';
import { setup } from './helpers/setup.mjs';

const ask = (pi, channel, payload) => new Promise(resolve => pi.events.emit(channel, { v: 1, ...payload, reply: resolve }));
const TOKEN = /as_run_/;

test('run.state tells the harness the allowed thinking levels and the protocol when a run starts', async () => {
  const t = await setup({ manifestOptions: { thinking: ['low', 'medium'], extra: { bypass_mode: true } } });
  try {
    const states = [];
    t.pi.events.on('piagent:run.state', s => states.push(s));
    await t.pi.fire('before_agent_start', { messageType: 'user', prompt: 'x' });
    assert.equal(states.length, 1);
    assert.equal(states[0].v, 1);
    assert.match(states[0].runId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(states[0].harness.thinking.allowed, ['low', 'medium']);
    assert.equal(states[0].harness.bypassMode, true);
    assert.equal(states[0].harness.protocol, 1);
    assert.deepEqual(states[0].harness.helperCalls, ['scout']);
  } finally { await t.cleanup(); }
});

test('grant.request gives a helper a stream bound to its grant, never the token', async () => {
  const t = await setup();
  try {
    assert.equal((await ask(t.pi, 'piagent:grant.request', { role: 'scout', purpose: 'brief' })).ok, false, 'no run yet');
    await t.pi.fire('before_agent_start', { messageType: 'user', prompt: 'x' });
    const answer = await ask(t.pi, 'piagent:grant.request', { role: 'scout', purpose: 'brief' });
    assert.equal(answer.ok, true, answer.error);
    assert.doesNotMatch(JSON.stringify({ ...answer, stream: undefined }), TOKEN);
    assert.equal(answer.models[0].id, 'claude-sonnet-5-5');
    assert.equal(t.broker.log.find(e => e.action === 'child').role, 'scout');
    const { message } = await collect(answer.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'tìm file' }], timestamp: 1 }] }));
    assert.equal(message.stopReason, 'stop', message.errorMessage);
    const request = t.studio.inference().at(-1);
    assert.equal(request.authorized, true);
    assert.equal(request.headers['x-agent-purpose'], 'brief');
    assert.equal(request.headers['x-claude-code-session-id'], undefined, 'a helper names its role, not the conversation');
    await new Promise(r => { t.pi.events.emit('piagent:grant.close', { v: 1, role: 'scout' }); setImmediate(r); });
    assert.deepEqual(t.broker.log.at(-1), { action: 'close', role: 'scout' });
  } finally { await t.cleanup(); }
});

test('studio.call reaches only Studio run APIs, with the main grant, and never returns it', async () => {
  const t = await setup();
  try {
    await t.pi.fire('before_agent_start', { messageType: 'user', prompt: 'x' });
    const ok = await ask(t.pi, 'piagent:studio.call', { method: 'POST', path: '/studio/v1/managed/tool-failures', body: { n: 1 } });
    assert.equal(ok.ok, true, ok.error); assert.equal(ok.status, 200);
    assert.equal(t.studio.requests.at(-1).authorized, true);
    assert.doesNotMatch(JSON.stringify(ok), TOKEN);
    for (const path of ['/admin/keys', 'https://evil.example/v1/x', '/v1/../admin']) {
      const refused = await ask(t.pi, 'piagent:studio.call', { path });
      assert.deepEqual([refused.ok, refused.error], [false, 'managed-request-failed'], path);
    }
    assert.equal(t.studio.requests.filter(r => r.path === '/admin/keys').length, 0);
  } finally { await t.cleanup(); }
});

test('run.process hands the harness report to the close, once, when the broker advertises process reports', async () => {
  const t = await setup();
  try {
    await t.pi.fire('before_agent_start', { messageType: 'user', prompt: 'x' });
    t.pi.events.emit('piagent:run.process', { v: 1, process: { version: 1, checks: ['npm test'] } });
    await t.finish();
    assert.deepEqual(t.broker.log.find(e => e.action === 'close').process, { version: 1, checks: ['npm test'] });
    await t.pi.fire('before_agent_start', { messageType: 'user', prompt: 'y' });
    await t.finish();
    assert.equal(t.broker.log.filter(e => e.action === 'close').at(-1).process, undefined, 'a report belongs to one run');
  } finally { await t.cleanup(); }
});

test('a close that cannot reach Studio is asked again while the link waits, then closes', async () => {
  const t = await setup({ deps: { linkOptions: { pause: async () => {} } } });
  try {
    await t.pi.fire('before_agent_start', { messageType: 'user', prompt: 'x' });
    t.world.fail.set('close', [{ message: 'managed-broker:offline' }, { message: 'managed-broker:offline' }]);
    await t.finish();
    assert.equal(t.broker.count('close'), 3);
    assert.ok(t.pi.entries.some(e => e.customType === 'agent-watch-run' && e.data.state === 'closed'));
  } finally { await t.cleanup(); }
});
