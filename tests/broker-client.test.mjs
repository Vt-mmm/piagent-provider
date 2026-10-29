import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrokerClient } from '../src/broker-client.mjs';
import { script } from './helpers/broker-script.mjs';

const PROFILE = 'b'.repeat(64);
function broker(t, mode = 'ok', options = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'broker-')));
  const file = path.join(dir, 'broker.mjs');
  fs.writeFileSync(file, script(mode), { mode: 0o700 });
  const client = () => new BrokerClient({ executable: file, profileID: PROFILE, ...options });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { file, dir, client };
}

test('requests go through in order and the broker is started with its profile', async t => {
  const b = broker(t), client = b.client();
  t.after(() => client.dispose());
  const [first, second] = await Promise.all([client.request('config'), client.request('renew', { role: 'main' })]);
  assert.equal(first.echo, 'config');
  assert.deepEqual(first.args, ['managed-broker', '--profile', PROFILE]);
  assert.equal(second.echo, 'renew');
});

test('the broker child gets a minimal environment, not ours', async t => {
  process.env.AS_TEST_SECRET = 'not-for-the-broker';
  t.after(() => { delete process.env.AS_TEST_SECRET; });
  const b = broker(t), client = b.client();
  t.after(() => client.dispose());
  const names = await client.request('env');
  assert.ok(!names.includes('AS_TEST_SECRET'));
  assert.ok(names.includes('PATH') && names.includes('LANG'));
});

test("Agent Watch's coarse error stays the message and Studio's reason rides along", async t => {
  const b = broker(t), client = b.client();
  t.after(() => client.dispose());
  await assert.rejects(client.request('fail'), error => error.message === 'managed-broker:serverUnavailable' && error.studioCode === 'harness_route_unavailable');
});

test('a broker that talks garbage fails the waiting request and every later one', async t => {
  const b = broker(t, 'garbage'), client = b.client();
  await assert.rejects(client.request('config'), /managed-broker-disconnected/);
  await assert.rejects(client.request('config'), /managed-broker-disconnected/);
});

test('an executable that is not an absolute real path, or a bad profile, is refused', t => {
  const b = broker(t);
  assert.throws(() => new BrokerClient({ executable: 'broker', profileID: PROFILE }), /managed-broker-binding-invalid/);
  assert.throws(() => new BrokerClient({ executable: b.file, profileID: 'short' }), /managed-broker-binding-invalid/);
  const link = path.join(b.dir, 'link.mjs');
  fs.symlinkSync(b.file, link);
  assert.throws(() => new BrokerClient({ executable: link, profileID: PROFILE }), /managed-broker-binding-invalid/);
});
