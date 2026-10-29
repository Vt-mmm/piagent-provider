import test from 'node:test';
import assert from 'node:assert/strict';
import { baseRole, releaseGrant, seedGrant, shareGrant, slotArgs } from '../src/grant-share.mjs';

const owner = () => { const renews = []; return { renews, broker: { request: async (action, args) => { renews.push([action, args]); return { token: `t${renews.length}` }; } } }; };

test('requests of one role share one renew while one of them still runs', async () => {
  const o = owner(), a = shareGrant(o, 'main'), b = shareGrant(o, 'main');
  assert.equal(a, b);
  assert.deepEqual(o.renews, [['renew', { role: 'main' }]]);
  assert.equal((await a.grant).token, 't1');
  releaseGrant(o, 'main', a);
  assert.equal(o.sharedGrants.get('main'), a, 'one user is left');
  releaseGrant(o, 'main', b);
  assert.equal(o.sharedGrants.has('main'), false);
  assert.notEqual(shareGrant(o, 'main'), a, 'a new renew once all let go');
});

test('a share older than a minute is renewed again; a failed renew is forgotten', async () => {
  const o = owner(), first = shareGrant(o, 'main', 0);
  assert.notEqual(shareGrant(o, 'main', 61_000), first);
  const bad = { broker: { request: async () => { throw Error('managed-broker:offline'); } } };
  const failed = shareGrant(bad, 'review');
  await assert.rejects(failed.grant, /offline/);
  await new Promise(r => setImmediate(r));
  assert.equal(bad.sharedGrants.has('review'), false);
});

test("the turn start's grant joins the share, so the request does not renew again", async () => {
  const o = owner();
  seedGrant(o, 'main', Promise.resolve({ token: 'turn' }));
  const entry = shareGrant(o, 'main');
  assert.equal((await entry.grant).token, 'turn');
  assert.equal(o.renews.length, 0);
});

test('helper slots: role#slot keys map to the broker arguments', () => {
  assert.deepEqual(slotArgs('scout'), { role: 'scout' });
  assert.deepEqual(slotArgs('scout#2'), { role: 'scout', slot: 2 });
  assert.equal(baseRole('scout#3'), 'scout');
});
