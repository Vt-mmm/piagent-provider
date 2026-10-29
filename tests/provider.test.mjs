import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collect } from './helpers/fake-pi.mjs';
import { setup } from './helpers/setup.mjs';

const text = message => message.content.filter(p => p.type === 'text').map(p => p.text).join('');

test('one model "Auto (công ty)" is registered, with no token before a run', async () => {
  const t = await setup();
  try {
    const { models, apiKey } = t.pi.provider;
    assert.equal(models.length, 1);
    assert.equal(models[0].name, 'Auto (công ty)');
    assert.equal(models[0].id, 'agent-watch-auto');
    assert.doesNotMatch(apiKey, /as_run_/);
  } finally { await t.cleanup(); }
});

test('Anthropic Messages: a run is started, the grant authenticates, the native model id is sent', async () => {
  const t = await setup();
  try {
    const { message } = await collect(await t.turn());
    assert.equal(message.stopReason, 'stop', message.errorMessage);
    assert.equal(text(message), 'Xin chào từ Studio giả.');
    const [request] = t.studio.inference();
    assert.equal(request.path, '/claude/v1/messages');
    assert.equal(request.authorized, true);
    assert.equal(request.parsed.model, 'claude-sonnet-5-5');
    assert.equal(t.broker.count('start'), 1);
    await t.finish();
    assert.equal(t.broker.count('close'), 1);
  } finally { await t.cleanup(); }
});

test('OpenAI Responses (codex) and Chat Completions (vendor) are served on their own paths', async () => {
  for (const [model, path, field] of [['gpt-6.1-sol', '/v1/responses', 'model'], ['deepseek-v4-pro', '/openai/v1/chat/completions', 'model']]) {
    const t = await setup({ manifestOptions: { main: [model] } });
    t.world.route = model;
    try {
      const { message } = await collect(await t.turn());
      assert.equal(message.stopReason, 'stop', message.errorMessage);
      assert.equal(text(message), 'Xin chào từ Studio giả.');
      const [request] = t.studio.inference();
      assert.equal(request.path, path);
      assert.equal(request.authorized, true);
      assert.equal(request.parsed[field], model);
    } finally { await t.cleanup(); }
  }
});

test('a model change between conversations: the next run routes to another wire without an error', async () => {
  const t = await setup({ manifestOptions: { main: ['claude-sonnet-5-5', 'gpt-6.1-sol', 'deepseek-v4-pro'] } });
  try {
    const seen = [];
    for (const route of ['claude-sonnet-5-5', 'gpt-6.1-sol', 'deepseek-v4-pro', 'claude-sonnet-5-5']) {
      t.world.route = route;
      const { message } = await collect(await t.turn(`hỏi ${route}`));
      assert.equal(message.stopReason, 'stop', `${route}: ${message.errorMessage}`);
      seen.push([t.studio.inference().at(-1).path, t.pi.provider.models[0].contextWindow]);
      await t.finish();
    }
    assert.deepEqual(seen.map(s => s[0]), ['/claude/v1/messages', '/v1/responses', '/openai/v1/chat/completions', '/claude/v1/messages']);
    assert.equal(seen[1][1], 272000, 'the registered model carries the routed model\'s limits');
    assert.notEqual(seen[0][1], seen[1][1]);
    assert.equal(t.broker.count('start'), 4);
  } finally { await t.cleanup(); }
});

test('the turn start renews once and re-registers the provider with the new token; the request does not renew again', async () => {
  const t = await setup();
  try {
    await t.pi.fire('before_agent_start', { messageType: 'user', prompt: 'a' });
    const before = t.pi.registrations, started = t.pi.provider.apiKey;
    assert.match(started, /^as_run_/, 'the run\'s token is the key once the run started');
    await t.pi.fire('turn_start', { turnIndex: 0 });
    assert.equal(t.broker.count('renew'), 1);
    assert.ok(t.pi.registrations > before);
    assert.notEqual(t.pi.provider.apiKey, started);
    const { message } = await collect(t.pi.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }], timestamp: 1 }] }));
    assert.equal(message.stopReason, 'stop', message.errorMessage);
    assert.equal(t.broker.count('renew'), 1, 'the request used the turn start\'s grant');
    assert.equal(t.studio.inference()[0].token, t.pi.provider.apiKey);
    // A second turn of the same run (after a tool result) renews again, and the old token is void.
    await t.pi.fire('turn_start', { turnIndex: 1 });
    assert.equal(t.broker.count('renew'), 2);
    assert.ok(![...t.world.valid.values()].includes(t.studio.inference()[0].token), 'the first token is void after the second renew');
  } finally { await t.cleanup(); }
});

test('only a member message starts a round: Pi\'s retry and the harness send-backs keep the run', async () => {
  const t = await setup();
  try {
    await t.pi.fire('before_agent_start', { messageType: 'user', prompt: 'một' });
    t.provider.nextPurpose = 'harness';
    await t.pi.fire('before_agent_start', { messageType: 'custom' });
    assert.equal(t.broker.count('start'), 1, 'no second run for a custom message');
    assert.equal(t.provider.nextPurpose, 'harness', 'state kept for a custom message');
    await t.pi.fire('before_agent_start', { messageType: 'user', prompt: 'hai' });
    assert.equal(t.provider.nextPurpose, null, 'state reset by a member message');
    assert.equal(t.broker.count('start'), 1, 'the open run goes on until the round settles');
    await t.finish();
    await t.pi.fire('before_agent_start', { messageType: 'user', prompt: 'ba' });
    assert.equal(t.broker.count('start'), 2);
  } finally { await t.cleanup(); }
});

test('the conversation id is fixed for every request of every turn', async () => {
  const t = await setup({ manifestOptions: { main: ['claude-sonnet-5-5', 'gpt-6.1-sol'] } });
  try {
    for (const route of ['claude-sonnet-5-5', 'gpt-6.1-sol']) {
      t.world.route = route;
      for (let i = 0; i < 2; i += 1) { await collect(await t.turn(`lượt ${i}`)); }
      await t.finish();
    }
    const requests = t.studio.inference();
    assert.equal(requests.length, 4);
    for (const r of requests) assert.equal(r.headers['x-claude-code-session-id'], 'session-0001-fixed');
    for (const r of requests.slice(0, 2)) assert.equal(r.headers['x-agent-purpose'], 'answer');
    assert.match(requests[0].headers['user-agent'], /^piagent-provider\//);
  } finally { await t.cleanup(); }
});

test('thinking follows the Harness: the run asks for the nearest allowed level and a forbidden pick is put back', async () => {
  const t = await setup({ manifestOptions: { thinking: ['medium', 'high'] } });
  try {
    t.pi.level = 'low';
    await t.pi.fire('before_agent_start', { messageType: 'user', prompt: 'x' });
    assert.equal(t.broker.log.find(e => e.action === 'start').effort, 'medium', 'low is not offered: the nearest deeper level');
    t.pi.level = 'low';
    await t.pi.fire('thinking_level_select', { level: 'low', previousLevel: 'medium' });
    assert.equal(t.pi.level, 'medium');
    t.pi.level = 'off';
    await t.pi.fire('thinking_level_select', { level: 'off', previousLevel: 'high' });
    assert.equal(t.pi.level, 'high');
  } finally { await t.cleanup(); }
});

test('a run that cannot start answers the turn with the reason instead of failing it', async () => {
  const t = await setup();
  try {
    t.world.fail.set('start', [{ message: 'managed-broker:permissionDenied' }]);
    const { message } = await collect(await t.turn());
    assert.equal(message.stopReason, 'error');
    assert.match(message.errorMessage, /no longer holds a usable company key/);
    assert.doesNotMatch(message.errorMessage, /as_run_/);
  } finally { await t.cleanup(); }
});

test('an admission refusal waits in line and is asked again; nothing of the refusal reaches the conversation', async () => {
  const t = await setup();
  try {
    t.studio.plan = [{ status: 429, code: 'concurrency_limit' }, 'ok'];
    const { events, message } = await collect(await t.turn());
    assert.equal(message.stopReason, 'stop', message.errorMessage);
    assert.equal(events.filter(e => e.type === 'error').length, 0);
    assert.equal(t.studio.inference().length, 1);
    assert.equal(t.studio.requests.filter(r => r.path.endsWith('/messages')).length, 2);
    assert.ok(t.broker.count('renew') >= 2, 'the ask again renewed the grant');
  } finally { await t.cleanup(); }
});

test('a brief refusal (a lapsed grant) renews and asks again', async () => {
  const t = await setup();
  try {
    t.studio.plan = [{ status: 401, code: 'invalid_run_grant' }, 'ok'];
    const { message } = await collect(await t.turn());
    assert.equal(message.stopReason, 'stop', message.errorMessage);
    assert.equal(t.studio.requests.filter(r => r.path.endsWith('/messages')).length, 2);
  } finally { await t.cleanup(); }
});

test('a conversation with Claude\'s thinking and tool calls continues on Codex and on a vendor without an error', async () => {
  const t = await setup({ manifestOptions: { main: ['claude-sonnet-5-5', 'gpt-6.1-sol', 'deepseek-v4-pro'] } });
  const history = [
    { role: 'user', content: [{ type: 'text', text: 'đọc file' }], timestamp: 1 },
    { role: 'assistant', api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-5-5', stopReason: 'toolUse', timestamp: 2,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: [{ type: 'thinking', thinking: 'cần đọc file', thinkingSignature: 'sig-from-anthropic' }, { type: 'toolCall', id: 'toolu_1', name: 'read', arguments: { path: 'a.txt' } }] },
    { role: 'toolResult', toolCallId: 'toolu_1', toolName: 'read', content: [{ type: 'text', text: 'nội dung' }], isError: false, timestamp: 3 },
  ];
  try {
    for (const route of ['gpt-6.1-sol', 'deepseek-v4-pro']) {
      t.world.route = route;
      await t.pi.fire('before_agent_start', { messageType: 'user', prompt: 'tiếp' });
      await t.pi.fire('turn_start', { turnIndex: 0 });
      const { message } = await collect(t.pi.stream({ messages: [{ role: 'system', content: 'Bạn là trợ lý.' }, ...history] }));
      assert.equal(message.stopReason, 'stop', `${route}: ${message.errorMessage}`);
      await t.finish();
    }
  } finally { await t.cleanup(); }
});

test('Studio stopped for two minutes: the work waits (no limit), then goes on; the wait is logged as a disconnect and reported', async () => {
  let clock = Date.parse('2026-10-29T01:00:00Z'), studio;
  const pauses = [];
  const linkOptions = { now: () => clock, random: () => 0.5,
    pause: async ms => { pauses.push(ms); clock += ms; if (clock - 0 >= Date.parse('2026-10-29T01:02:00Z') && studio.server.listening === false) await studio.start(); } };
  const t = await setup({ deps: { linkOptions } });
  studio = t.studio;
  try {
    // One answer first, so Studio's boot id and version are known before it goes away.
    assert.equal((await collect(await t.turn('một'))).message.stopReason, 'stop');
    await t.finish();
    await studio.stop();
    const started = clock;
    const { message } = await collect(await t.turn('hai'));
    assert.equal(message.stopReason, 'stop', message.errorMessage);
    assert.ok(clock - started >= 120_000, `waited ${clock - started} ms on the fake clock`);
    assert.ok(pauses.length > 3, 'the heartbeat was asked again and again');
    assert.ok(pauses.every(ms => ms <= 30_000 * 1.25), 'pauses stay bounded');
    const log = fs.readFileSync(path.join(t.stateDir, 'logs', 'studio-link.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const disconnect = log.find(l => l.kind === 'studio_disconnect');
    assert.equal(disconnect.outcome, 'resumed');
    assert.ok(disconnect.waited_ms >= 120_000);
    assert.deepEqual(disconnect.codes, ['studio-unreachable']);
    assert.equal(disconnect.conversation, 'session-0001-fixed');
    // The next request reports it to Studio.
    await t.pi.fire('turn_start', { turnIndex: 1 });
    await collect(t.pi.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'ba' }], timestamp: 1 }] }));
    await t.provider.studioLink.flush(t.pi.provider.apiKey);
    assert.equal(studio.disconnects.length, 1);
    assert.equal(studio.disconnects[0].events[0].outcome, 'resumed');
  } finally { await t.cleanup(); }
});

test('Stop during a Studio outage ends the wait at once', async () => {
  const t = await setup({ deps: { linkOptions: { pause: (ms, signal) => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(signal.reason ?? Error('aborted'))); }) } } });
  try {
    await t.studio.stop();
    const controller = new AbortController();
    await t.pi.fire('before_agent_start', { messageType: 'user', prompt: 'x' }, { ...t.ctx, signal: controller.signal });
    const stream = t.pi.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }], timestamp: 1 }] }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const { message } = await collect(stream);
    assert.equal(message.stopReason, 'aborted');
  } finally { await t.cleanup(); }
});
