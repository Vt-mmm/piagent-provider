// The provider's side of the contract with the sandbox and harness packages
// (piagent-bundle/docs/package-contract.md). Packages never import each other;
// they talk over Pi's event bus. Every payload carries `v`; a token never
// crosses the bus: a helper gets a stream bound to its grant, and Studio calls
// go through the provider (`piagent:studio.call`).
export const BUS_VERSION = 1;
export const CHANNEL = {
  grantRequest: 'piagent:grant.request',
  grantClose: 'piagent:grant.close',
  runState: 'piagent:run.state',
  runProcess: 'piagent:run.process',
  studioCall: 'piagent:studio.call',
  notice: 'piagent:notice',
};

// Only Studio's run and managed APIs, on the provider's own origin.
const ALLOWED_PATH = /^\/(?:v1|studio\/v1\/managed)\/[A-Za-z0-9_./-]*(?:\?[A-Za-z0-9_=&.%-]*)?$/;
export const callPathAllowed = path => typeof path === 'string' && ALLOWED_PATH.test(path) && !path.includes('..') && !path.includes('//');

export function reply(payload, answer) {
  try { payload?.reply?.({ v: BUS_VERSION, ...answer }); } catch { /* a listener that throws does not stop the provider */ }
}
