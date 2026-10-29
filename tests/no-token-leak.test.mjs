import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collect } from './helpers/fake-pi.mjs';
import { setup } from './helpers/setup.mjs';

const TOKEN = /as_run_/;
function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

// A run token authenticates a role; it may live in the provider's memory and in
// the request's Authorization header, nowhere else: not in the environment
// (so not in a tool's child process), not in a file, not in a log, not in
// anything a stream, the bus, the UI or the conversation shows.
test('no run token (the as run prefix) in process.env, files, logs, stream output, bus, UI or conversation', async () => {
  const written = [];
  const out = process.stdout.write.bind(process.stdout), err = process.stderr.write.bind(process.stderr);
  const spy = original => (chunk, ...rest) => { written.push(String(chunk)); return original(chunk, ...rest); };
  process.stdout.write = spy(out); process.stderr.write = spy(err);
  const envBefore = JSON.stringify(process.env);
  const t = await setup({ deps: { linkOptions: { pause: async () => {} } } });
  const outputs = [];
  try {
    const run = async (text, extra) => { const result = await collect(await t.turn(text, extra)); outputs.push(JSON.stringify(result)); await t.finish(); return result; };
    await run('thành công');
    // Studio echoes the caller's token in the words of a failure no code names.
    const leaked = t.world.roles.get('main')?.token ?? 'as_run_00000000-0000-4000-8000-0000000000b1_' + 'x'.repeat(43);
    t.studio.plan = [{ status: 400, message: `bad request for Bearer ${leaked} and ${leaked}` }];
    const failed = await run('lỗi không tên');
    assert.equal(failed.message.stopReason, 'error');
    t.studio.plan = [{ status: 429, code: 'concurrency_limit' }, { status: 401, code: 'invalid_run_grant' }];
    await run('từ chối rồi hỏi lại');
    t.world.fail.set('start', [{ message: 'managed-broker:offline' }]);
    await t.studio.stop();
    t.studio.state = 'ready';
    setTimeout(() => void t.studio.start(), 50);
    await run('Studio tắt rồi bật');
    await t.provider.studioLink.flush(t.pi.provider.apiKey);
    await t.pi.fire('turn_start', { turnIndex: 0 });
    outputs.push(JSON.stringify(await t.provider.studioCall({ path: '/studio/v1/managed/tool-failures', body: { a: 1 } }).catch(e => String(e.message))));

    const seen = { streams: outputs, bus: JSON.stringify(t.pi.seen), ui: JSON.stringify(t.ctx.notices), conversation: JSON.stringify(t.pi.entries),
      registrations: JSON.stringify([...t.pi.providers.values()].map(({ apiKey, streamSimple, ...rest }) => rest)), console: written.join('') };
    for (const [where, text] of Object.entries(seen)) assert.doesNotMatch(Array.isArray(text) ? text.join('\n') : text, TOKEN, where);
    const files = filesUnder(t.stateDir);
    assert.ok(files.some(f => f.endsWith('studio-link.jsonl')), 'the link log was written');
    for (const file of files) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), TOKEN, file);
    assert.equal(JSON.stringify(process.env), envBefore, 'the environment is untouched');
    for (const [name, value] of Object.entries(process.env)) assert.doesNotMatch(String(value), TOKEN, name);
    // Before and after a run the provider's key is a placeholder; the token is only a run's.
    assert.doesNotMatch(t.pi.provider.apiKey, TOKEN);
  } finally { process.stdout.write = out; process.stderr.write = err; await t.cleanup(); }
});
