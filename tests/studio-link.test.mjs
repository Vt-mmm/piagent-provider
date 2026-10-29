import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { StudioLink, STUDIO_WAIT_CODES, classifyWait, LINK_LOG } from '../src/studio-link.mjs';
import { failureCode, describeFailure } from '../src/failure.mjs';

const BEFORE = '11111111-1111-4111-8111-111111111111', AFTER = '22222222-2222-4222-8222-222222222222';
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'studio-link-'));
const lines = dir => fs.readFileSync(path.join(dir, 'logs', LINK_LOG), 'utf8').trim().split('\n').map(l => JSON.parse(l));

// A link whose heartbeat answers come from a list (the last one repeats),
// with no real pauses; `calls` records every request.
function linkWith(answers, { agentDir = null, post = () => new Response(null, { status: 204 }) } = {}) {
  const calls = [], events = [], statuses = [];
  let i = 0, clock = Date.parse('2026-10-21T01:00:00Z');
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/studio/v1/managed/disconnects')) return post(url, init);
    const next = answers[Math.min(i++, answers.length - 1)];
    if (next instanceof Error) throw next;
    return next();
  };
  const link = new StudioLink({ origin: 'https://studio.example', agentDir, fetchImpl, notify: e => events.push(e), ui: () => ({ setWorkingMessage: t => statuses.push(t) }),
    now: () => clock, pause: async (ms, signal) => { await new Promise(r => setImmediate(r)); if (signal?.aborted) throw signal.reason ?? Error('aborted'); clock += ms; }, random: () => 0.5 });
  return { link, calls, events, statuses, advance: ms => { clock += ms; } };
}

test('a wait across a Studio update is told as an update, logged and reported once Studio answers', async () => {
  const dir = tmp();
  const ready = (boot, version) => () => json(200, { status: 'ready', boot_id: boot, version });
  const { link, calls, events, statuses } = linkWith([
    Object.assign(Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
    () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    () => json(503, { status: 'starting', boot_id: AFTER, version: '0.36.0' }),
    ready(AFTER, '0.36.0'),
  ], { agentDir: dir });
  link.observe({ 'x-studio-boot': BEFORE, 'x-studio-version': '0.35.3' });
  const wait = await link.waitUntilBack({ phase: 'continue', code: 'studio-unreachable', conversation: 'conv-1' });
  assert.equal(wait.cause, 'studio_update');
  assert.equal(wait.outcome, 'resumed');
  assert.equal(wait.attempts, 4);
  assert.deepEqual([wait.version_before, wait.version_after, wait.boot_before, wait.boot_after], ['0.35.3', '0.36.0', BEFORE, AFTER]);
  assert.ok(wait.waited_ms >= 2_000);
  assert.deepEqual(events.map(e => e.state), ['start', 'waiting', 'waiting', 'waiting', 'end']);
  assert.equal(events.at(-1).cause, 'studio_update');
  assert.match(statuses[0], /goes on by itself/); assert.equal(statuses.at(-1), undefined);
  // The local log: a start line, then the whole wait, filterable by kind and cause.
  const log = lines(dir);
  assert.deepEqual(log.map(l => l.kind), ['studio_wait', 'studio_disconnect']);
  assert.equal(log[1].cause, 'studio_update'); assert.equal(log[1].conversation, 'conv-1');
  // Reported with the next token; sent once.
  assert.equal(await link.flush('as_run_x'), true);
  const sent = calls.filter(c => c.url.endsWith('/studio/v1/managed/disconnects'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].init.headers.Authorization, 'Bearer as_run_x');
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.events.length, 1);
  const e = body.events[0];
  assert.deepEqual([e.phase, e.cause, e.outcome, e.attempts, e.codes[0], e.conversation, e.version_after], ['continue', 'studio_update', 'resumed', 4, 'studio-unreachable', 'conv-1', '0.36.0']);
  assert.ok(e.started_age_ms >= e.ended_age_ms);
  assert.equal(await link.flush('as_run_x'), false, 'nothing left to send');
});

test('the causes Studio and the heartbeat can tell', () => {
  const seen = (...s) => new Set(s);
  assert.equal(classifyWait({ boot: BEFORE, version: '1' }, { boot: AFTER, version: '1' }, seen('down', 'ready'), ['studio-unreachable']), 'studio_restart');
  assert.equal(classifyWait({ boot: BEFORE, version: '1' }, { boot: BEFORE, version: '1' }, seen('draining', 'ready'), ['studio-unreachable']), 'studio_unavailable');
  assert.equal(classifyWait({ boot: BEFORE }, { boot: BEFORE }, seen('down', 'ready'), ['studio-unreachable']), 'network');
  assert.equal(classifyWait({ boot: BEFORE }, { boot: BEFORE }, seen('ready'), ['managed-broker:offline']), 'broker_offline');
  assert.equal(classifyWait({}, {}, seen('ready'), ['studio-unreachable']), 'unknown');
  for (const code of ['studio-unreachable', 'studio-gateway-unavailable', 'managed-broker:offline', 'connector_unavailable']) assert.ok(STUDIO_WAIT_CODES.has(code), code);
  for (const code of ['invalid_api_key', 'quota_exceeded', 'studio-request-failed', 'upstream_policy_refusal']) assert.ok(!STUDIO_WAIT_CODES.has(code), code);
});

test("a gateway's page instead of Studio's answer is its own code; other answers are not", () => {
  for (const raw of ['API error (502): <html>Bad gateway</html>', '503 <html>Service Unavailable</html>', 'API error (524): A timeout occurred', '530 <!DOCTYPE html>'])
    assert.equal(failureCode(raw), 'studio-gateway-unavailable', raw);
  assert.equal(failureCode('API error (400): bad'), 'studio-request-failed');
  assert.equal(failureCode('503 {"error":{"code":"connector_unavailable"}}'), 'connector_unavailable');
  assert.match(describeFailure('main', 'API error (502): x'), /gateway.*\[studio-gateway-unavailable\]$/);
});

test('Stop ends a wait, which is logged and reported as stopped', async () => {
  const dir = tmp();
  const { link } = linkWith([() => new Response('down', { status: 502 })], { agentDir: dir });
  const controller = new AbortController();
  const waiting = link.waitUntilBack({ phase: 'model', code: 'studio-unreachable', signal: controller.signal });
  setTimeout(() => link.cancel(), 5);
  await assert.rejects(waiting);
  assert.equal(lines(dir).at(-1).outcome, 'stopped');
  assert.equal(link.queue.at(-1).record.outcome, 'stopped');
});

test('an older Studio without the heartbeat counts as up; a Studio without the report route is not asked again', async () => {
  const { link, calls } = linkWith([() => new Response('not found', { status: 404, headers: { 'x-request-id': '0b8f6a36-1e0f-4a51-9d9e-3b3f0c0a1a11' } })],
    { post: () => new Response(null, { status: 404 }) });
  const wait = await link.waitUntilBack({ code: 'studio-unreachable' });
  assert.equal(wait.outcome, 'resumed');
  assert.equal(await link.flush('as_run_x'), false);
  assert.equal(link.disabled, true);
  link.queue.push({ record: wait, tries: 0 });
  assert.equal(await link.flush('as_run_x'), false);
  assert.equal(calls.filter(c => c.url.endsWith('/disconnects')).length, 1);
});

test('failing again right after Studio answers waits longer each time, and a request that goes through resets it', async () => {
  const { link } = linkWith([() => json(200, { status: 'ready', boot_id: BEFORE, version: '1' })]);
  const waited = [];
  for (let i = 0; i < 4; i++) waited.push((await link.waitUntilBack({ code: 'studio-unreachable' })).waited_ms);
  assert.deepEqual(waited, [2_000, 4_000, 8_000, 16_000]);
  link.ok();
  assert.equal((await link.waitUntilBack({ code: 'studio-unreachable' })).waited_ms, 2_000);
});

