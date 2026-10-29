// The shape of every request the provider sends, against a fixture masked from a
// real run through Agent Watch (tests/fixtures/real-wire.json, 2026-10-29: a Claude
// answer and tool step, a Codex Responses brief and tool step, capabilities). It
// keeps the provider in step with what Agent Studio reads (piagent-bundle
// docs/protocol-sync.md): paths, header names, body fields, call-purpose headers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { gunzipSync } from 'node:zlib';
import { collect } from './helpers/fake-pi.mjs';
import { setup } from './helpers/setup.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/real-wire.json', import.meta.url), 'utf8')).requests;
// Studio (native/request.go ManagedEffort) reads a Claude request's active effort from the last
// system message's output_config in `messages`; the top-level output_config is only the default.
const activeEffort = body => body.messages.findLast(m => m.role === 'system' && m.output_config)?.output_config.effort ?? body.output_config?.effort;
const entry = (path, purpose) => fixture.find(r => r.path === path && (r.headerValues['x-agent-purpose'] ?? null) === purpose);
const TOOL = { name: 'get_time', description: 'Returns the time.', parameters: { type: 'object', properties: {}, additionalProperties: false } };
const call = { type: 'toolCall', id: 'call_1', name: 'get_time', arguments: {} };
const withResult = (assistant, id) => [{ role: 'user', content: [{ type: 'text', text: 'giờ?' }], timestamp: 1 }, assistant,
  { role: 'toolResult', toolCallId: id, toolName: 'get_time', content: [{ type: 'text', text: '13:00' }], isError: false, timestamp: 3 }];
const context = messages => normalizeContext({ systemPrompt: 'ngắn gọn', messages, tools: [TOOL] });
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const claudeAsk = [{ role: 'user', content: [{ type: 'text', text: 'giờ?' }], timestamp: 1 }];
const assistant = (api, provider, model) => ({ role: 'assistant', api, provider, model, stopReason: 'toolUse', usage, timestamp: 2, content: [call] });
const claudeStep = withResult(assistant('anthropic-messages', 'anthropic', 'claude-sonnet-5-5'), 'call_1');
const codexStep = withResult(assistant('openai-responses', 'openai-codex', 'gpt-6.1-sol'), 'call_1');

// What the fixture says a request carries must all be present in the received one.
function matches(received, expected, label) {
  const names = Object.keys(received.headers);
  for (const name of expected.headerNames) assert.ok(names.includes(name), `${label}: header ${name} is sent`);
  for (const [name, value] of Object.entries(expected.headerValues)) assert.equal(received.headers[name], value, `${label}: ${name}`);
  assert.deepEqual(Object.keys(received.parsed), expected.bodyKeys, `${label}: body fields`);
  assert.equal(received.parsed.tools.length, expected.tools, `${label}: tools`);
  assert.equal(received.parsed.stream, expected.stream, `${label}: stream`);
}

test('Claude (Messages): answer and tool step carry the headers and fields Studio reads', async () => {
  const t = await setup();
  try {
    await t.pi.fire('before_agent_start', { messageType: 'user', prompt: 'giờ?' });
    await t.pi.fire('turn_start', { turnIndex: 0 });
    await collect(t.pi.stream(context(claudeAsk), { reasoning: 'medium' }));
    await t.pi.fire('turn_start', { turnIndex: 1 });
    await collect(t.pi.stream(context(claudeStep), { reasoning: 'medium' }));
    const [answer, step] = t.studio.inference();
    matches(answer, entry('/claude/v1/messages', 'answer'), 'answer');
    matches(step, entry('/claude/v1/messages', 'tool_step'), 'tool_step');
    assert.equal(step.headers['x-agent-after'], 'get_time');
    // Studio compares the request's thinking level with the run's effort.
    assert.equal(activeEffort(answer.parsed), t.pi.provider.models[0].thinkingLevelMap.medium);
    assert.equal(answer.headers['x-claude-code-session-id'], 'session-0001-fixed');
    assert.match(answer.headers['x-session-id'], /^[0-9a-f-]{36}$/i, "the role's id");
    assert.match(answer.headers['x-api-key'], /^as_run_/, 'the Messages wire carries the grant as x-api-key');
    assert.match(answer.headers['user-agent'], /^piagent\/\d/);
  } finally { await t.cleanup(); }
});

test('Codex (Responses) through a helper grant: brief and tool step', async () => {
  const t = await setup({ manifestOptions: { extra: { review: { mode: 'fixed', model_ids: ['gpt-6.1-sol'] } } } });
  try {
    await t.pi.fire('before_agent_start', { messageType: 'user', prompt: 'giờ?' });
    t.world.route = 'gpt-6.1-sol';
    const helper = await new Promise(resolve => t.pi.events.emit('piagent:grant.request', { v: 1, role: 'review', purpose: 'brief', reply: resolve }));
    assert.equal(helper.ok, true, helper.error);
    await collect(helper.stream(context(claudeAsk)));
    await collect(helper.stream(context(codexStep)));
    const [brief, step] = t.studio.inference();
    matches(brief, entry('/v1/responses', 'brief'), 'brief');
    matches(step, entry('/v1/responses', 'tool_step'), 'tool_step');
    assert.equal(brief.parsed.reasoning.effort, 'medium', 'Studio reads reasoning.effort of a Responses request');
    assert.match(brief.headers.authorization, /^Bearer as_run_/, 'the Responses wire carries the grant as a Bearer token');
    assert.equal(brief.parsed.model, 'gpt-6.1-sol');
  } finally { await t.cleanup(); }
});

test('capabilities are asked with a Bearer grant and the Pi-family User-Agent', async () => {
  const t = await setup();
  try {
    await t.pi.fire('before_agent_start', { messageType: 'user', prompt: 'x' });
    await t.pi.fire('turn_start', { turnIndex: 0 });
    await new Promise(r => setTimeout(r, 100));
    const asked = t.studio.requests.find(r => r.path === '/v1/capabilities'), expected = fixture.find(r => r.path === '/v1/capabilities');
    for (const name of expected.headerNames) assert.ok(name in asked.headers, name);
    assert.equal(asked.authorized, true, 'asked with the renewed grant, not the start grant');
  } finally { await t.cleanup(); }
});

test('a request whose thinking differs from the run is what Studio refuses: the provider asks with the run\'s level', async () => {
  const t = await setup();
  try {
    await t.pi.fire('before_agent_start', { messageType: 'user', prompt: 'x' });
    await t.pi.fire('turn_start', { turnIndex: 0 });
    // A helper stream defaults its reasoning to the grant's effort.
    const helper = await new Promise(resolve => t.pi.events.emit('piagent:grant.request', { v: 1, role: 'scout', purpose: 'brief', reply: resolve }));
    await collect(helper.stream({ messages: claudeAsk }));
    const sent = t.studio.inference().at(-1).parsed;
    assert.equal(sent.thinking?.type, 'adaptive', 'thinking is on, as the run\'s effort needs');
    assert.equal(activeEffort(sent), 'medium', 'at the effort of the grant');
  } finally { await t.cleanup(); }
});

test('bodies over 64 KiB go up gzip once Studio advertised it, and not before', async () => {
  const t = await setup();
  try {
    t.studio.advertiseGzip = true;
    await t.pi.fire('before_agent_start', { messageType: 'user', prompt: 'x' });
    await t.pi.fire('turn_start', { turnIndex: 0 });
    await collect(t.pi.stream(context(claudeAsk), { reasoning: 'medium' }));
    const big = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(80_000) }], timestamp: 1 }];
    await t.pi.fire('turn_start', { turnIndex: 1 });
    await collect(t.pi.stream(context(big), { reasoning: 'medium' }));
    const [first, second] = t.studio.requests.filter(r => r.path.endsWith('/messages'));
    assert.equal(first.headers['content-encoding'], undefined);
    assert.equal(second.headers['content-encoding'], 'gzip');
    assert.ok(second.body.length > 64 * 1024 && second.raw.length < second.body.length / 10, 'sent compressed');
    assert.equal(JSON.parse(gunzipSync(second.raw).toString()).stream, true);
  } finally { await t.cleanup(); }
});
