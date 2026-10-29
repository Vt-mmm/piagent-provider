import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLIENT_AGENT } from '../src/client-agent.mjs';
import { JsonLines, parseJson } from '../src/json.mjs';
import { describeFailure, failureCode, failureIsAdmissionRefusal, failureIsBriefRefusal, failureText, unnamedFailureText } from '../src/failure.mjs';
import { redact } from '../src/redact.mjs';
import { PI_HOST_VERSION, compareVersions, hostCli, hostPackage, hostPlan, installPrivateHost, privateHostPrefix, privateHostRoot } from '../src/pi-host.mjs';
import { allowedThinkingLevels, nearestLevel, safeOrigin, taskClass, usableManifest, verifyGrant } from '../src/manifest.mjs';
import { blockedCommand, guardedEditor } from '../src/guard.mjs';
import { createThinkingGuard } from '../src/thinking.mjs';
import { callPathAllowed } from '../src/bus.mjs';
import { FakeWorld, manifestFor } from './helpers/fake-studio.mjs';

test('parseJson gives the fallback; JsonLines frames lines split anywhere, even inside a character', () => {
  assert.equal(parseJson('{', 'x'), 'x'); assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  const lines = new JsonLines(), bytes = Buffer.from('{"t":"é"}\n{"n":2}\n');
  const out = [...lines.feed(bytes.subarray(0, 7)), ...lines.feed(bytes.subarray(7))];
  assert.deepEqual(out, [{ t: 'é' }, { n: 2 }]);
  assert.throws(() => new JsonLines().feed('nope\n'), /json-lines-invalid/);
  assert.throws(() => new JsonLines(10).feed('x'.repeat(11)), /json-lines-too-long/);
});

test('failures: Studio code, gateway page, network words and local codes; the sentence never shows a token', () => {
  assert.equal(failureCode('503 {"error":{"code":"session_account_busy_retry_later"}}'), 'session_account_busy_retry_later');
  assert.equal(failureCode('API error (502): <html>'), 'studio-gateway-unavailable');
  assert.equal(failureCode('fetch failed'), 'studio-unreachable');
  assert.equal(failureCode('managed-broker:offline'), 'managed-broker:offline');
  assert.equal(failureCode(failureText(Object.assign(Error('managed-broker:serverUnavailable'), { studioCode: 'harness_route_unavailable' }))), 'harness_route_unavailable');
  assert.ok(failureIsAdmissionRefusal('concurrency_limit') && !failureIsAdmissionRefusal('upstream_interrupted'));
  assert.ok(failureIsBriefRefusal('invalid_run_grant') && !failureIsBriefRefusal('concurrency_limit'));
  const token = `as_run_${'a'.repeat(36)}_${'b'.repeat(43)}`;
  assert.doesNotMatch(describeFailure('main', `401 {"code":"invalid_run_grant"} Bearer ${token}`), /as_run_/);
  assert.doesNotMatch(unnamedFailureText(`weird ${token} failure`) ?? '', /as_run_/);
  assert.equal(redact(`x ${token} y Bearer abcdefghijkl z sk-abcdefghijklmnop`), 'x [redacted] y Bearer [redacted] z [redacted]');
});

test('the client names itself with the package version', () => assert.match(CLIENT_AGENT, /^piagent-provider\/\d+\.\d+\.\d+/));

test('pi host: pinned version, plan, private install paths, no writes to the real home', () => {
  assert.equal(PI_HOST_VERSION, '1.3.0');
  assert.deepEqual([hostPlan('1.3.0'), hostPlan('1.4.1'), hostPlan('1.2.0'), hostPlan(null)], ['current', 'private', 'global', 'global']);
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0 && compareVersions('1.3.0+x', '1.3.0') === 0);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'host-home-'));
  try {
    assert.equal(privateHostRoot('1.3.0', home), null);
    const lines = [];
    const root = installPrivateHost({ version: '1.3.0', home, dryRun: true, log: line => lines.push(line) });
    assert.ok(root.startsWith(privateHostPrefix('1.3.0', home)));
    assert.match(lines[0], /^DRY RUN: npm install .*--ignore-scripts.*pi-coding-agent@1\.3\.0$/);
    assert.equal(fs.existsSync(path.join(home, '.piagent')), false, 'a dry run writes nothing');
    const fake = path.join(home, '.piagent', 'pi-host', '1.3.0', 'node_modules', '@earendil-works', 'pi-coding-agent');
    fs.mkdirSync(fake, { recursive: true });
    fs.writeFileSync(path.join(fake, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.3.0', bin: { pi: 'dist/cli.js' } }));
    assert.equal(privateHostRoot('1.3.0', home), fs.realpathSync(fake));
    assert.equal(hostCli(fake), path.join(fake, 'dist/cli.js'));
    assert.equal(privateHostRoot('1.2.0', home), null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
  assert.ok(hostPackage(new URL('../node_modules/@earendil-works/pi-coding-agent', import.meta.url).pathname, '@earendil-works/pi-ai').includes('pi-ai'));
  assert.throws(() => hostPackage(os.tmpdir(), 'no-such-package-xyz'), /managed-sdk-dependency-missing/);
});

test('manifest checks: origin, grant, levels, task class', () => {
  assert.equal(safeOrigin('https://studio.example.test/'), 'https://studio.example.test');
  assert.equal(safeOrigin('http://127.0.0.1:9'), 'http://127.0.0.1:9');
  const badOrigins = ['http://studio.example.test', 'https://u:p@studio.example.test', 'https://studio.example.test/x', 'https://studio.example.test/?a=1'];
  for (const bad of badOrigins) assert.throws(() => safeOrigin(bad), /managed-origin-invalid/, bad);
  const manifest = manifestFor('http://127.0.0.1:9'), world = new FakeWorld(manifest);
  world.runID = '00000000-0000-4000-8000-0000000000a1';
  const grant = world.grant('main');
  verifyGrant(grant, manifest, 'main');
  for (const bad of [{ ...grant, token: 'as_run_short' }, { ...grant, role: 'scout' }, { ...grant, fence: 0 }, { ...grant, model_id: 'other' }, { ...grant, studio_instance_id: 'x' }, null])
    assert.throws(() => verifyGrant(bad, manifest, 'main'), /managed-grant-invalid/);
  assert.throws(() => usableManifest({ schema_version: 1 }), /managed-configuration-unavailable/);
  assert.equal(nearestLevel('xhigh', ['low', 'medium']), 'medium'); assert.equal(nearestLevel('minimal', ['low', 'medium']), 'low'); assert.equal(nearestLevel('high', undefined), 'high');
  const native = { reasoning: true, thinkingLevelMap: { off: null, minimal: null, xhigh: 'xhigh' } };
  const levels = allowedThinkingLevels({ ...manifest, thinking_levels: ['off', 'low', 'medium', 'xhigh'] }, () => native, native);
  assert.deepEqual(levels, ['low', 'medium', 'xhigh']);
  assert.equal(taskClass('hi'), 'simple'); assert.equal(taskClass('Sửa lỗi đăng nhập trong form này giúp tôi nhé'), 'standard');
  assert.equal(taskClass('Thiết kế kiến trúc mới'), 'complex'); assert.equal(taskClass('x'.repeat(1600)), 'complex');
});

test('/login /model /scoped-models /share /bug are blocked with a Vietnamese message; other input passes', () => {
  for (const c of ['/login', '/logout', '/model gpt', '/scoped-models', '/share', '/bug  ']) assert.match(blockedCommand(c).message, /bị chặn trong chế độ công ty/, c);
  for (const c of ['/modelx', '/help', 'model', 'giải thích /model', '']) assert.equal(blockedCommand(c), null, c);
});

test('the guarded editor swallows a blocked submit, clears the box and tells the member', () => {
  const notices = [];
  class Base { constructor() { this.cleared = 0; } setText() { this.cleared += 1; } }
  const editor = new (guardedEditor(Base, (text, kind) => notices.push([text, kind])))();
  const sent = [];
  editor.onSubmit = text => sent.push(text);   // what Pi does after creating the editor
  editor.onSubmit('/model');
  editor.onSubmit('/share');
  editor.onSubmit('sửa lỗi này');
  assert.deepEqual(sent, ['sửa lỗi này']);
  assert.equal(editor.cleared, 2); assert.equal(notices.length, 2); assert.equal(notices[0][1], 'warning');
});

test('a thinking level the Harness does not allow is put back to the right one', () => {
  const pi = { level: 'medium', getThinkingLevel() { return this.level; }, setThinkingLevel(l) { this.level = l; } };
  let allowed = ['medium', 'high'];
  const log = [], guard = createThinkingGuard(pi, { allowed: () => allowed, log: e => log.push(e) });
  pi.level = 'low'; guard.onSelect({ level: 'low', previousLevel: 'medium' });
  assert.equal(pi.level, 'medium'); assert.deepEqual(log[0], { kind: 'thinking_reverted', asked: 'low', now: 'medium' });
  pi.level = 'high'; guard.onSelect({ level: 'high', previousLevel: 'medium' });
  assert.equal(pi.level, 'high', 'an allowed level stays');
  pi.level = 'off'; guard.onSelect({ level: 'off', previousLevel: 'high' });
  assert.equal(pi.level, 'high');
  allowed = ['high']; pi.level = 'medium'; guard.onSelect({ level: 'medium', previousLevel: 'low' });
  assert.equal(pi.level, 'high', 'neither asked nor previous is allowed: the nearest');
  assert.equal(guard.force('low'), 'high'); assert.equal(pi.level, 'high');
  allowed = null; pi.level = 'low'; guard.onSelect({ level: 'low', previousLevel: 'high' });
  assert.equal(pi.level, 'low', 'no list: every level stands');
});

test('studio.call paths: only Studio run and managed APIs, nothing that escapes them', () => {
  for (const p of ['/v1/requests/abc/cancel', '/studio/v1/managed/disconnects', '/studio/v1/managed/settle?x=1']) assert.ok(callPathAllowed(p), p);
  for (const p of ['/', '/admin/keys', '/v1/../admin', 'https://evil.example/v1/x', '//evil.example/v1/x', '/v1//x', 7, undefined]) assert.ok(!callPathAllowed(p), String(p));
});
