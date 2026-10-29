// The provider inside real Pi 1.3.0 (the pinned peer dependency), against a
// simulated Studio and broker, in a temporary agent dir. Nothing real is called
// and nothing is written outside the temporary directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeStudio, FakeWorld, manifestFor } from './helpers/fake-studio.mjs';
import { brokerProgram } from './helpers/broker-program.mjs';

const root = new URL('..', import.meta.url).pathname;
const pi = path.join(root, 'node_modules', '.bin', 'pi');

async function rig(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-smoke-')));
  const studio = await new FakeStudio(new FakeWorld(null), { reply: 'Chào từ Pi thật.' }).listen();
  studio.world.manifest = manifestFor(studio.origin);
  const broker = path.join(dir, 'broker.mjs');
  fs.writeFileSync(broker, brokerProgram(studio.origin, studio.world.manifest), { mode: 0o700 });
  const binding = path.join(dir, 'binding.json');
  fs.writeFileSync(binding, JSON.stringify({ schema_version: 1, model: 'agent-watch-auto', profile_id: 'd'.repeat(64), origin: studio.origin, broker }));
  const agent = path.join(dir, 'agent'), project = path.join(dir, 'project');
  fs.mkdirSync(agent); fs.mkdirSync(project);
  // One model only: the launcher scopes Pi to the company model.
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ enabledModels: ['studio/agent-watch-auto'], retry: { enabled: true, maxRetries: 2 } }));
  t.after(async () => { await studio.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const env = { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: agent, PIAGENT_BINDING: binding, PI_OFFLINE: '1', TERM: 'xterm-256color' };
  return { dir, studio, agent, project, env, args: ['--no-extensions', '-e', path.join(root, 'src/index.mjs'), '--model', 'studio/agent-watch-auto', '--offline'] };
}
// The simulated Studio lives in this process, so Pi must run asynchronously.
function run(command, args, options) {
  return new Promise(resolve => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 60_000);
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}
const files = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]);

test('pi -p: a company turn runs through the broker and the simulated Studio, and the run is closed', async t => {
  const r = await rig(t);
  const result = await run(pi, [...r.args, '-p', 'Xin chào'], { cwd: r.project, env: r.env, timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Chào từ Pi thật\./);
  const [request] = r.studio.inference();
  assert.equal(request.path, '/claude/v1/messages');
  assert.equal(request.authorized, true);
  assert.equal(request.parsed.model, 'claude-sonnet-5-5');
  assert.match(request.headers['x-claude-code-session-id'], /^[\w-]{8,}$/);
  const actions = r.studio.events.map(e => e.action);
  assert.ok(actions.includes('grant') && actions.at(-1) === 'close', JSON.stringify(actions));
  const everything = [result.stdout, result.stderr, ...files(r.dir).filter(f => !f.endsWith('broker.mjs')).map(f => fs.readFileSync(f, 'utf8'))].join('\n');
  assert.doesNotMatch(everything, /as_run_/, 'no run token on the screen, in logs or in any file');
});

const python = spawnSync('python3', ['--version']).status === 0;
test('pi (interactive): Ctrl+P cycles nothing; /model, /login, /scoped-models, /share, /bug are blocked in Vietnamese', { skip: !python, timeout: 90_000 }, async t => {
  const r = await rig(t);
  const driver = path.join(root, 'tests/helpers/drive.py');
  const result = await run('python3', ['-I', driver, JSON.stringify({ cmd: [pi, ...r.args], cwd: r.project, env: r.env }), '^P', '/model', '/login', '/scoped-models', '/share', '/bug'],
    { timeout: 80_000 });
  assert.equal(result.status, 0, result.stderr);
  const blocked = result.stdout.match(/Lệnh \/(model|login|scoped-models|share|bug) bị chặn trong chế độ công ty/g) ?? [];
  assert.equal(new Set(blocked).size, 5, result.stdout.slice(-1500));
  assert.match(result.stdout, /Only one model in scope/, 'Ctrl+P has nothing else to cycle to');
  assert.match(result.stdout, /agent-watch-auto/, 'the footer shows the one company model');
  assert.doesNotMatch(result.stdout, /as_run_/);
});
