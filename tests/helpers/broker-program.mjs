// A broker executable that speaks the whole managed-broker protocol for the
// smoke test with real Pi: it makes grants itself and tells the fake Studio
// (a test-only route) which token is valid, since it is a separate process.
export const brokerProgram = (origin, manifest) => `#!${process.execPath}
import readline from 'node:readline';
import { randomBytes, randomUUID } from 'node:crypto';
const origin = ${JSON.stringify(origin)}, manifest = ${JSON.stringify(manifest)};
const authority = manifest.authority, roles = new Map();
let run = null;
const post = (path, body) => fetch(origin + path, { method: 'POST', body: JSON.stringify(body) }).then(r => r.arrayBuffer());
async function grant(role, slot) {
  const entry = manifest.models[0], key = slot ? role + '#' + slot : role, prior = roles.get(key);
  const role_id = prior?.role_id ?? randomUUID(), token = 'as_run_' + role_id + '_' + randomBytes(32).toString('base64url');
  const g = { ...authority, run_id: run, role_id, role, model_id: entry.id, provider: entry.owned_by, provider_model_id: entry.provider_model_id, effort: 'medium',
    fence: (prior?.fence ?? 0) + 1, token, expires_at: '2030-01-01T00:00:00Z', profile_id: randomUUID(), ...(slot ? { slot } : {}) };
  roles.set(key, g);
  await post('/__test/grant', { role_id, token });
  await post('/__test/event', { action: 'grant', role, fence: g.fence });
  return g;
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async line => {
  const request = JSON.parse(line);
  const reply = body => process.stdout.write(JSON.stringify({ id: request.id, ...body }) + '\\n');
  try {
    if (request.action === 'config') return reply({ result: manifest });
    if (request.action === 'start') { run = randomUUID(); roles.clear(); return reply({ result: await grant('main') }); }
    if (request.action === 'renew' || request.action === 'child') return reply({ result: await grant(request.role, request.slot) });
    if (request.action === 'close') {
      await post('/__test/event', { action: 'close', role: request.role ?? 'main' });
      if (!request.role || request.role === 'main') run = null;
      return reply({ result: true });
    }
    reply({ error: 'permissionDenied' });
  } catch { reply({ error: 'broker_failed' }); }
});
`;
