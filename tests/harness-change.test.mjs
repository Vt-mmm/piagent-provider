import test from 'node:test';
import assert from 'node:assert/strict';
import { collect } from './helpers/fake-pi.mjs';
import { setup } from './helpers/setup.mjs';
import { MODELS, manifestFor } from './helpers/fake-studio.mjs';

const text = message => message.content.filter(p => p.type === 'text').map(p => p.text).join('');
const SESSION = 'session-0001-fixed';

// The key's Harness as the conversation first read it: Claude is the only model it lists.
const oldHarness = t => { t.world.manifest.models = MODELS.slice(0, 1); };
// The Harness changed in Studio: the main model is another one, the revision is new.
const changeHarness = (t, model, thinking = ['medium', 'high']) => {
  t.world.manifest = manifestFor(t.studio.origin, { main: [model], thinking });
  t.world.manifest.harness.revision = String(Number(t.world.manifest.harness.revision) + 1);
  t.world.route = model;
};
const noTokens = t => {
  const dump = JSON.stringify([t.pi.seen, t.pi.entries, t.ctx.notices]);
  assert.doesNotMatch(dump, /as_run_/);
};

test('the Harness changes between messages (Claude → Codex → Claude): each message answers, no "continue" needed', async () => {
  const t = await setup();
  try {
    oldHarness(t);
    const seen = [];
    for (const model of ['claude-sonnet-5-5', 'gpt-6.1-sol', 'claude-sonnet-5-5']) {
      if (model !== 'claude-sonnet-5-5' || seen.length) changeHarness(t, model);
      const { message } = await collect(await t.turn(`hỏi ${model}`));
      assert.equal(message.stopReason, 'stop', `${model}: ${message.errorMessage}`);
      assert.equal(text(message), 'Xin chào từ Studio giả.');
      const last = t.studio.inference().at(-1);
      seen.push(last.path);
      assert.equal(last.authorized, true);
      assert.equal(last.headers['x-claude-code-session-id'] ?? SESSION, SESSION);
      await t.finish();
    }
    assert.deepEqual(seen, ['/claude/v1/messages', '/v1/responses', '/claude/v1/messages']);
    assert.ok(t.pi.provider.models[0].contextWindow > 0);
    assert.ok(t.ctx.notices.some(n => /Cấu hình công ty vừa đổi/.test(n.text)), 'the member is told in Vietnamese');
    noTokens(t);
  } finally { await t.cleanup(); }
});

test('the old grant is refused in the middle of a message: a new run is made and the request is sent once more', async () => {
  const t = await setup();
  try {
    const first = await collect(await t.turn('một'));
    assert.equal(first.message.stopReason, 'stop');
    await t.finish();
    // The next message starts a run under the old Harness; then Studio changes it before the request.
    await t.pi.fire('before_agent_start', { messageType: 'user', prompt: 'hai' });
    const starts = t.broker.count('start');
    changeHarness(t, 'gpt-6.1-sol');
    t.world.fail.set('renew', [{ message: 'managed-broker:identityChanged' }]);
    await t.pi.fire('turn_start', { turnIndex: 0 });
    const { message } = await collect(t.pi.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hai' }], timestamp: Date.now() }] }));
    assert.equal(message.stopReason, 'stop', message.errorMessage);
    assert.equal(t.broker.count('start'), starts + 1, 'exactly one new run');
    assert.equal(t.studio.inference().at(-1).path, '/v1/responses');
    assert.equal(t.studio.inference().at(-1).authorized, true);
    assert.deepEqual(t.pi.provider.models[0].id, 'agent-watch-auto');
    noTokens(t);
  } finally { await t.cleanup(); }
});

test('a grant for a model the conversation did not know is rebuilt once, not looped', async () => {
  const t = await setup();
  try {
    oldHarness(t);
    await t.pi.fire('before_agent_start', { messageType: 'user', prompt: 'một' });
    const starts = t.broker.count('start');
    changeHarness(t, 'gpt-6.1-sol');
    await t.pi.fire('turn_start', { turnIndex: 0 });
    const { message } = await collect(t.pi.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'một' }], timestamp: Date.now() }] }));
    assert.equal(message.stopReason, 'stop', message.errorMessage);
    assert.equal(t.broker.count('start') - starts, 1);
    assert.equal(t.studio.inference().length, 1, 'the refused request never reached a model');
    // The thinking level the new Harness allows.
    assert.ok(t.pi.provider && t.provider.allowed.includes('medium'));
    assert.ok(!t.provider.allowed.includes('off'));
  } finally { await t.cleanup(); }
});

test('a start that failed is not stuck: "continue" reads the Harness again and goes on', async () => {
  const t = await setup();
  try {
    oldHarness(t);
    // Studio hands out a grant for a model the manifest it serves does not list yet.
    t.world.route = 'gpt-6.1-sol';
    const failed = await collect(await t.turn('một'));
    assert.equal(failed.message.stopReason, 'error');
    assert.match(failed.message.errorMessage, /managed-grant-invalid/);
    assert.doesNotMatch(failed.message.errorMessage, /\/bug/);
    assert.doesNotMatch(failed.message.errorMessage, /as_run_/);
    await t.finish();
    // The configuration catches up; one "continue" is enough.
    changeHarness(t, 'gpt-6.1-sol');
    const { message } = await collect(await t.turn('continue'));
    assert.equal(message.stopReason, 'stop', message.errorMessage);
    assert.equal(t.studio.inference().at(-1).path, '/v1/responses');
    noTokens(t);
  } finally { await t.cleanup(); }
});
