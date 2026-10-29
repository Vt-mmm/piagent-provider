import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readBinding } from '../src/index.mjs';
import { setup } from './helpers/setup.mjs';

test('session start wires the model, the editor guard and a fixed starting thinking level', async () => {
  let editorFactory;
  const t = await setup();
  try {
    t.ctx.ui.setEditorComponent = factory => { editorFactory = factory; };
    await t.pi.fire('session_start', {});
    assert.equal(t.pi.models.at(-1).id, 'agent-watch-auto');
    assert.equal(typeof editorFactory, 'function');
    assert.equal(t.pi.level, 'medium');
  } finally { await t.cleanup(); }
});

test('session start tells the harness the Harness before any run exists', async () => {
  const t = await setup({ manifestOptions: { extra: { workflow: { plan: 'off', verify: 'require', review: 'require', max_fix_loops: 2 } } } });
  try {
    const seen = [];
    t.pi.events.on('piagent:run.state', d => seen.push(d));
    await t.pi.fire('session_start', {});
    assert.equal(seen.length, 1);
    assert.equal(seen[0].runId, null);
    assert.equal(seen[0].harness.workflow.verify, 'require');
    assert.equal(t.broker.count('start'), 0, 'no run was started for it');
  } finally { await t.cleanup(); }
});

test('picking another provider\'s model is undone with a message', async () => {
  const t = await setup();
  try {
    await t.pi.fire('model_select', { model: { provider: 'anthropic', id: 'claude-opus-5-5' } });
    assert.equal(t.pi.models.at(-1).id, 'agent-watch-auto');
    assert.match(t.ctx.notices.at(-1).text, /chỉ có một model "Auto \(công ty\)"/);
    const before = t.pi.models.length;
    await t.pi.fire('model_select', { model: { provider: 'studio', id: 'agent-watch-auto' } });
    assert.equal(t.pi.models.length, before);
  } finally { await t.cleanup(); }
});

test('fast mode is restored from the conversation when it opens', async () => {
  const t = await setup({ manifestOptions: { extra: { fast_mode: true } } });
  try {
    t.pi.entries.push({ type: 'custom', customType: 'agent-watch-fast', data: { enabled: true, allowed: true } });
    await t.pi.fire('session_start', {});
    assert.equal(t.provider.fast, true);
  } finally { await t.cleanup(); }
});

test('session shutdown closes the open run and the broker', async () => {
  const t = await setup();
  try {
    await t.pi.fire('before_agent_start', { messageType: 'user', prompt: 'x' });
    await t.pi.fire('session_shutdown');
    assert.equal(t.broker.count('close'), 1);
    assert.equal(t.broker.disposed, true);
  } finally { await t.studio.close(); }
});

test('AGENT_WATCH_MANAGED_BINDING names the binding; PIAGENT_BINDING wins when both are set', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binding-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, origin) => { const file = path.join(dir, name); fs.writeFileSync(file, JSON.stringify({ schema_version: 1, profile_id: 'c'.repeat(64), origin, broker: '/x/broker' })); return file; };
  const saved = { a: process.env.AGENT_WATCH_MANAGED_BINDING, p: process.env.PIAGENT_BINDING };
  t.after(() => { for (const [key, value] of [['AGENT_WATCH_MANAGED_BINDING', saved.a], ['PIAGENT_BINDING', saved.p]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  delete process.env.PIAGENT_BINDING;
  process.env.AGENT_WATCH_MANAGED_BINDING = write('aw.json', 'https://aw.example.test');
  assert.equal(readBinding().origin, 'https://aw.example.test');
  process.env.PIAGENT_BINDING = write('pa.json', 'https://pa.example.test');
  assert.equal(readBinding().origin, 'https://pa.example.test');
});

test('the binding is read, not written, and only a sound one is accepted', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binding-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, value) => { const file = path.join(dir, name); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  const good = { schema_version: 1, model: 'agent-watch-auto', profile_id: 'c'.repeat(64), origin: 'https://studio.example.test/', broker: '/x/broker' };
  const binding = readBinding(write('ok.json', good));
  assert.equal(binding.origin, 'https://studio.example.test');
  // The bundle runtime's binding (Agent Watch, runtime = pi) has no `model` and extra keys.
  const { model, ...bundleBinding } = good;
  assert.equal(readBinding(write('pi.json', { ...bundleBinding, runtime: 'pi', bundle_root: '/x' })).broker, '/x/broker');
  const bads = [['v.json', { ...good, schema_version: 2 }], ['m.json', { ...good, model: 'other' }], ['p.json', { ...good, profile_id: 'zz' }],
    ['junk.json', 'nope'], ['big.json', ' '.repeat(20_000)]];
  for (const [name, bad] of bads)
    assert.throws(() => readBinding(write(name, bad)), /managed-binding-invalid/, name);
  assert.throws(() => readBinding(write('o.json', { ...good, origin: 'http://studio.example.test' })), /managed-origin-invalid/);
  const link = path.join(dir, 'link.json');
  fs.symlinkSync(path.join(dir, 'ok.json'), link);
  assert.throws(() => readBinding(link), /managed-binding-invalid/);
});
