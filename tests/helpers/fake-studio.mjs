// A simulated Agent Watch broker and Studio for offline tests. Nothing here
// talks to a real Studio, broker or model; every id and token is synthetic.
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const AUTHORITY = { studio_instance_id: '00000000-0000-4000-8000-000000000001', dataset_epoch: '00000000-0000-4000-8000-000000000002', auth_generation: 1 };
export const MODELS = [
  { id: 'claude-sonnet-5-5', display_name: 'Sonnet', owned_by: 'claude', protocol: 'messages', provider_model_id: 'claude-sonnet-5-5', context_mode: 'provider_default' },
  { id: 'gpt-6.1-sol', display_name: 'Sol', owned_by: 'codex', protocol: 'responses', provider_model_id: 'gpt-6.1-sol', context_mode: 'provider_default' },
  { id: 'deepseek-v4-pro', display_name: 'DeepSeek', owned_by: 'deepseek', protocol: 'chat', provider_model_id: 'deepseek-v4-pro', context_mode: 'provider_default' },
];
export function manifestFor(origin, { main = ['claude-sonnet-5-5'], thinking = ['off', 'low', 'medium', 'high'], extra = {} } = {}) {
  return { schema_version: 2, credential_mode: 'managed', authority: AUTHORITY, key_id: '00000000-0000-4000-8000-0000000000a1', user: { id: '00000000-0000-4000-8000-0000000000b1' },
    models: MODELS, thinking_levels: thinking, broker_features: ['process', 'close-retry'], origin,
    harness: { id: 'h', team_id: 't', revision: '1', configuration: { main: { mode: 'auto', model_ids: main }, scout: { mode: 'fixed', model_ids: ['claude-sonnet-5-5'] }, ...extra } } };
}

// The world both fakes share: which token is the valid one for which role.
export class FakeWorld {
  constructor(manifest) { this.manifest = manifest; this.valid = new Map(); this.calls = []; this.route = 'claude-sonnet-5-5'; this.fail = new Map(); this.runs = 0; }
  token(roleID) { const t = `as_run_${roleID}_${randomBytes(32).toString('base64url')}`; this.valid.set(roleID, t); return t; }
  grant(role, slot) {
    const entry = this.manifest.models.find(m => m.id === this.route), key = slot ? `${role}#${slot}` : role;
    this.roles ??= new Map();
    const prior = this.roles.get(key), roleID = prior?.role_id ?? randomUUID(), fence = (prior?.fence ?? 0) + 1;
    const grant = { ...AUTHORITY, run_id: this.runID, role_id: roleID, role, model_id: entry.id, provider: entry.owned_by, provider_model_id: entry.provider_model_id,
      effort: this.effort ?? 'medium', fence, token: this.token(roleID), expires_at: '2030-01-01T00:00:00Z', profile_id: randomUUID(), ...(slot ? { slot } : {}) };
    this.roles.set(key, grant);
    return grant;
  }
}

export class FakeBroker {
  constructor(world) { this.world = world; this.log = []; this.disposed = false; }
  async request(action, args = {}) {
    this.log.push({ action, ...args });
    const w = this.world, failure = w.fail.get(action)?.shift();
    if (failure) throw Object.assign(Error(failure.message), failure.studioCode ? { studioCode: failure.studioCode } : {});
    switch (action) {
      case 'config': return w.manifest;
      case 'start': w.runs += 1; w.runID = randomUUID(); w.roles = new Map(); w.effort = args.effort || undefined; return w.grant('main');
      case 'renew': return w.grant(args.role, args.slot);
      case 'child': return w.grant(args.role, args.slot);
      case 'close': if (!args.role || args.role === 'main') { w.runID = null; w.roles = new Map(); w.valid.clear(); } return true;
      default: throw Error('managed-broker:permissionDenied');
    }
  }
  async dispose() { this.disposed = true; }
  count(action) { return this.log.filter(e => e.action === action).length; }
}

const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [name, data] of events) res.write(`${name ? `event: ${name}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  res.end();
};
const anthropic = text => [['message_start', { type: 'message_start',
  message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
  ['message_stop', { type: 'message_stop' }]];
const responses = text => { const item = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const usage = { input_tokens: 7, output_tokens: 5, total_tokens: 12, input_tokens_details: { cached_tokens: 0 } };
  const done = { id: 'resp_1', object: 'response', status: 'completed', model: 'm', output: [item], usage };
  return [['response.created', { type: 'response.created', response: { ...done, status: 'in_progress', output: [] } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } }],
    ['response.content_part.added', { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text }],
    ['response.output_text.done', { type: 'response.output_text.done', item_id: 'msg_1', output_index: 0, content_index: 0, text }],
    ['response.content_part.done', { type: 'response.content_part.done', item_id: 'msg_1', output_index: 0, content_index: 0, part: item.content[0] }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
    ['response.completed', { type: 'response.completed', response: done }]]; };
const completions = text => [[null, { id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }],
  [null, { id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 } }], [null, '[DONE]']];
const WIRES = { '/claude/v1/messages': anthropic, '/v1/responses': responses, '/openai/v1/chat/completions': completions };

// Plan items, one per inference request: 'ok' (default), { status, code } a
// refusal before the stream, 'cut' a connection dropped before any event,
// 'midstream' an error event after the first content.
export class FakeStudio {
  constructor(world, { reply = 'Xin chào từ Studio giả.' } = {}) {
    Object.assign(this, { world, requests: [], disconnects: [], events: [], plan: [], reply, state: 'ready', boot: randomUUID(), version: '0.40.0',
      capabilities: ['requests.cancel.v1'], sockets: new Set() });
  }
  async listen(port = 0) {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.on('connection', s => { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)); });
    await new Promise(resolve => this.server.listen(port, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    this.origin = `http://127.0.0.1:${this.port}`;
    return this;
  }
  // Studio goes away (the port stops answering) and comes back on the same port.
  async stop() { for (const s of this.sockets) s.destroy(); await new Promise(resolve => this.server.close(resolve)); }
  async start() { await this.listen(this.port); }
  async close() { await this.stop().catch(() => {}); }
  async handle(req, res) {
    const url = new URL(req.url, this.origin), chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks), gzip = req.headers['content-encoding'] === 'gzip';
    const raw = (gzip ? gunzipSync(bytes) : bytes).toString('utf8');
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? req.headers['x-api-key'];
    if (this.advertiseGzip) res.setHeader('x-studio-accept-encoding', 'gzip');
    res.setHeader('x-studio-boot', this.boot); res.setHeader('x-studio-version', this.version); res.setHeader('x-request-id', randomUUID());
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/__test/grant') { const g = JSON.parse(raw); this.world.valid.set(g.role_id, g.token); this.events.push(g); return json(200, {}); }
    if (url.pathname === '/__test/event') { this.events.push(JSON.parse(raw)); return json(200, {}); }
    if (url.pathname === '/v1/heartbeat') return json(this.state === 'ready' ? 200 : 503, { status: this.state, boot_id: this.boot, version: this.version, started_at: new Date().toISOString() });
    const authorized = [...this.world.valid.values()].includes(token);
    const record = { path: url.pathname, method: req.method, headers: req.headers, body: raw, raw: bytes, authorized, token };
    this.requests.push(record);
    if (url.pathname === '/v1/capabilities') return json(200, { capabilities: this.capabilities });
    if (url.pathname === '/studio/v1/managed/disconnects') { this.disconnects.push(JSON.parse(raw)); res.writeHead(204); return res.end(); }
    if (url.pathname.endsWith('/cancel')) { res.writeHead(202); return res.end(); }
    if (url.pathname.startsWith('/studio/v1/managed/')) return json(authorized ? 200 : 401, { ok: authorized });
    const wire = WIRES[url.pathname];
    if (!wire) return json(404, { error: { code: 'not_found' } });
    if (!authorized) return json(401, { error: { type: 'authentication_error', code: 'invalid_run_grant', message: 'grant lapsed' } });
    const step = this.plan.shift() ?? 'ok';
    if (step === 'cut') return req.socket.destroy();
    if (step.status) return json(step.status, { error: { type: step.code ? 'api_error' : 'invalid_request_error', ...(step.code ? { code: step.code } : {}), message: step.message ?? step.code } });
    record.parsed = JSON.parse(raw);
    sse(res, wire(this.reply));
  }
  inference() { return this.requests.filter(r => r.parsed); }
}
