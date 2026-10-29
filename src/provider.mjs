// The Studio provider: one model, "Auto (công ty)", that Studio's Harness
// routes per run. Agent Watch's broker gives a grant (run token) per role; the
// token is never put in the environment, a file or a log. It authenticates
// Pi's requests by re-registering the provider with the new token at every
// turn start (a header hook cannot replace the provider's own auth, and a
// `context` hook stalls Pi's startup).
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { BUS_VERSION, CHANNEL, busCallAllowed, reply } from './bus.mjs';
import { claimNonce, nonceOk, withNonce } from './bus-nonce.mjs';
import { CLIENT_AGENT } from './client-agent.mjs';
import { STALE, failureCode, failureText } from './failure.mjs';
import { seedGrant, shareGrant, releaseGrant, slotArgs } from './grant-share.mjs';
import { allowedThinkingLevels, nearestLevel, taskClass, usableManifest, verifyGrant } from './manifest.mjs';
import { nativeManagedModel, piProvider, studioModel } from './native-catalog.mjs';
import { MODEL_ID, studioStream } from './request-stream.mjs';
import { refreshCapabilities } from './studio-capabilities.mjs';
import { StudioLink, closeRun } from './studio-link.mjs';
import { redact } from './redact.mjs';

export const PROVIDER = 'studio';
export const API_NAME = 'piagent-studio';
export const DISPLAY_NAME = 'Auto (công ty)';
export const PLACEHOLDER_KEY = 'studio-run-required';
const BUSY = /^managed-broker:(serverUnavailable|upstreamUnavailable|rateLimited)$/;
const CALL_BYTES = 1024 * 1024;

export class StudioProvider {
  // `apis` maps a wire ('anthropic-messages', 'openai-responses',
  // 'openai-completions') to Pi's streamSimple for it; `ai` is pi-ai's
  // stream factory; `lookup(provider, id)` is Pi's model catalog.
  constructor({ pi, ai, apis, broker, renewBroker = null, origin, manifest, lookup, stateDir = null, fetchImpl = (...a) => globalThis.fetch(...a), briefPauseMs, linkOptions = {} }) {
    Object.assign(this, { pi, ai, apis, broker, renewBroker, origin, manifest, lookup, stateDir, fetchImpl, briefPauseMs });
    Object.assign(this, { providerName: PROVIDER, routes: new Map(), capacityWaits: new Set(), sharedGrants: new Map(), grant: null, token: null,
      preflight: null, fast: false, allowed: null, ui: () => this.ctx?.ui ?? null, notify: event => this.notice(event) });
    this.studioLink = new StudioLink({ origin, agentDir: stateDir, fetchImpl, ui: this.ui, notify: event => this.notice(event), ...linkOptions });
    this.sessionId = () => this.ctx?.sessionManager?.getSessionId?.() ?? null;
    this.entries = { list: () => this.ctx?.sessionManager?.getEntries?.() ?? [], append: (type, data) => this.pi.appendEntry(type, data) };
    this.shutdown = new AbortController();
  }

  static async create(options) {
    const manifest = usableManifest(await patiently(() => options.broker.request('config'), 3));
    const self = new StudioProvider({ ...options, manifest });
    const candidate = manifest.models.find(m => manifest.harness.configuration.main.model_ids.includes(m.id));
    if (!candidate) throw Error('managed-main-model-unavailable');
    self.installRoute({ model_id: candidate.id, provider: candidate.owned_by, provider_model_id: candidate.provider_model_id });
    return self;
  }

  nativeOf = entry => nativeManagedModel(this.lookup, piProvider(entry.owned_by), entry.provider_model_id);
  routeEntry = route => this.manifest.models.find(m => m.id === route.model_id && m.owned_by === route.provider);

  // What Pi sees for a route: the native model's limits on Studio's wire.
  modelFor(route) {
    const entry = this.routeEntry(route), native = entry && this.nativeOf(entry);
    if (!native) throw Error('managed-native-catalog-update-required');
    const { provider, ...fields } = studioModel(native, entry, this.origin);
    return { native, model: { ...fields, api: API_NAME, id: MODEL_ID, name: DISPLAY_NAME } };
  }

  // Makes the route the main role's: registers the one model with its limits.
  installRoute(route) {
    const { native, model } = this.modelFor(route);
    this.routes.set('main', { provider: route.provider, model_id: route.model_id, native: route.provider_model_id });
    this.model = model;
    this.allowed = allowedThinkingLevels(this.manifest, this.nativeOf, native);
    this.register(this.token);
  }

  register(token) {
    this.token = token ?? null;
    this.pi.registerProvider(PROVIDER, { name: 'Studio (công ty)', api: API_NAME, baseUrl: this.origin, apiKey: token ?? PLACEHOLDER_KEY,
      authHeader: true, streamSimple: studioStream(this, 'main'), models: [this.model] });
  }

  notice(event) {
    this.pi.events.emit(CHANNEL.notice, { v: BUS_VERSION, ...event });
    if (event?.type !== 'managed_studio_wait' || event.state !== 'start') return;
    this.ctx?.ui?.notify?.(`Studio không phản hồi (${event.code}); sẽ tự tiếp tục khi Studio hoạt động lại.`, 'warning');
  }

  // A run per member message, started for its first request. A run that cannot
  // start becomes a turn answered with the reason (preflight), not a crash.
  async startRun({ text, level, signal }) {
    if (this.grant) return this.grant;
    // A start that failed before is not asked again with what failed it: the
    // Harness may have changed since, so the configuration is read again.
    const failedBefore = this.preflight !== null;
    this.preflight = null; this.sharedGrants.clear(); this.capabilitiesAsked = false;
    this.lastStart = { text, level };
    let reread = false;
    try {
      if (failedBefore) { await this.refreshManifest().catch(() => {}); reread = true; }
      for (;;) {
        try { this.grant = await this.#start(text, level); break; }
        catch (error) {
          const code = failureCode(failureText(error));
          // The Harness or the key changed after this conversation read it: read it again, once.
          if (!reread && STALE.test(code)) { reread = true; this.notifyMember('Cấu hình công ty vừa đổi, đang tạo phiên mới…'); await this.refreshManifest(); continue; }
          if (!(await this.studioLink.waitUntilBack({ phase: 'broker', code, conversation: this.conversation(), signal: signal ?? this.shutdown.signal }).catch(() => null))) throw error;
        }
      }
      this.token = this.grant.token;
      const route = { provider: this.grant.provider, model_id: this.grant.model_id, provider_model_id: this.grant.provider_model_id };
      this.installRoute(route);
      this.emitRunState();
    } catch (error) { this.preflight = redact(failureText(error)); }
    return this.grant;
  }

  notifyMember(text) { try { this.ctx?.ui?.notify?.(text, 'info'); } catch { /* no Terminal */ } }

  // The key's configuration as Studio has it now: the main model, the thinking
  // levels, the helper roles. A fresh Agent Watch helper reads it where the
  // host gave a way to start one (the old one may hold the old Harness).
  async refreshManifest() {
    let broker = this.broker, fresh = null;
    if (this.renewBroker) { fresh = this.renewBroker(); broker = fresh; }
    let manifest;
    try { manifest = usableManifest(await patiently(() => broker.request('config'), 3)); }
    catch (error) { await fresh?.dispose().catch(() => {}); throw error; }
    if (fresh) { const old = this.broker; this.broker = fresh; await old.dispose().catch(() => {}); }
    this.manifest = manifest;
    const candidate = manifest.models.find(m => manifest.harness.configuration.main.model_ids.includes(m.id));
    if (!candidate) throw Error('managed-main-model-unavailable');
    this.installRoute({ model_id: candidate.id, provider: candidate.owned_by, provider_model_id: candidate.provider_model_id });
    this.emitRunState();
  }

  // The run a request holds is not the key's Harness any more (Studio refused
  // its grant, or the grant names another route): the old run is closed and a
  // new one started for the same message, same conversation. The request is
  // then sent again by the caller, once.
  async rebuildRun({ signal } = {}) {
    this.notifyMember('Cấu hình công ty vừa đổi, đang tạo phiên mới…');
    await this.close();
    await this.refreshManifest();
    const { text, level } = this.lastStart ?? {};
    await this.startRun({ text, level, signal });
    if (!this.grant) throw Error(this.preflight ?? 'managed-run-required');
    await this.onRebuilt?.(this.grant);
    return this.grant;
  }

  async #start(text, level) {
    const thinking = nearestLevel(level ?? 'medium', this.manifest.thinking_levels);
    const grant = await patiently(() => this.broker.request('start', { operation_id: randomUUID(), effort: thinking === 'off' ? '' : thinking, task_class: taskClass(text ?? '') }), 2);
    try { verifyGrant(grant, this.manifest, 'main'); }
    catch (error) { try { await this.broker.request('close'); } catch { /* the run expires on its own */ } throw error; }
    return grant;
  }

  conversation() { return this.sessionId(); }

  // Everything the harness needs of the run, with no token. Sent when a run
  // starts and again when Studio's capability list refreshes.
  emitRunState() {
    const m = this.manifest, configuration = m.harness.configuration, authority = m.authority ?? {}, features = m.broker_features ?? [];
    this.pi.events.emit(CHANNEL.runState, withNonce(this.pi.events, { v: BUS_VERSION, runId: this.grant?.run_id ?? null,
      capabilities: this.capabilities ? [...this.capabilities] : [], team: m.user?.team_name ?? null,
      scope: { studio_instance_id: authority.studio_instance_id, dataset_epoch: authority.dataset_epoch, auth_generation: authority.auth_generation, key_id: m.key_id },
      harness: { thinking: { allowed: this.allowed, effort: this.grant?.effort ?? null }, bypassMode: configuration.bypass_mode === true,
        helperCalls: ['scout', 'research', 'verify', 'review'].filter(role => configuration[role]?.model_ids?.length),
        protocol: processVersion(features), features, workflow: configuration.workflow ?? null,
        ...(Number.isInteger(m.helper_slots) ? { helperLimit: m.helper_slots } : {}) } }));
  }

  // Every request of a turn is authenticated by the grant renewed here: the
  // renewed token joins the role's share (so the request does not renew again)
  // and becomes the provider's key. A renew that fails is left to the request,
  // which waits for Studio and asks again.
  async turnStart() {
    if (!this.grant) return;
    const renewal = this.broker.request('renew', slotArgs('main'));
    seedGrant(this, 'main', renewal);
    try {
      const grant = await renewal;
      this.register(grant.token);
      // Asked with a renewed token: the start grant's is replaced by the first renew.
      if (!this.capabilitiesAsked) { this.capabilitiesAsked = true; void refreshCapabilities(this, grant).then(() => this.emitRunState()); }
    } catch { /* the request itself renews and waits */ }
  }

  // The harness package hands over the run's process report to close with.
  setProcess(process) { this.process = process && typeof process === 'object' ? process : null; }

  async close() {
    if (!this.grant) return true;
    const grant = this.grant, features = this.manifest.broker_features ?? [];
    try {
      const sent = await closeRun(this.studioLink, this.broker, features, this.process && features.includes('process') ? this.process : null,
        { conversation: this.conversation(), runId: grant.run_id });
      if (sent) this.entries.append('agent-watch-run', { run_id: grant.run_id, state: 'closed' });
      return sent;
    } catch (error) { this.ctx?.ui?.notify?.(`Không đóng được run: ${failureCode(failureText(error))}`, 'warning'); return false; }
    finally { this.grant = null; this.process = null; this.preflight = null; this.sharedGrants.clear(); this.register(null); }
  }

  // A helper's grant for the harness package: a stream bound to it, not the token.
  async grantFor({ role, slot, signal }) {
    if (!this.grant) throw Error('managed-run-required');
    const key = slot > 1 ? `${role}#${slot}` : role;
    const grant = await this.broker.request('child', slotArgs(key));
    verifyGrant(grant, this.manifest, key);
    const route = { provider: grant.provider, model_id: grant.model_id, provider_model_id: grant.provider_model_id };
    const { native, model } = this.modelFor(route);
    this.routes.set(key, { provider: route.provider, model_id: route.model_id, native: route.provider_model_id });
    const stream = studioStream(this, key);
    return { effort: grant.effort, models: [{ id: route.provider_model_id, contextWindow: model.contextWindow, maxTokens: model.maxTokens, reasoning: native.reasoning === true }],
      // Studio refuses a request whose thinking differs from the role's effort.
      stream: (context, options) => stream({ ...model, provider: PROVIDER }, context,
        { ...(grant.effort ? { reasoning: grant.effort } : {}), ...options, signal: options?.signal ?? signal }) };
  }

  async closeChild({ role, slot }) {
    const key = slot > 1 ? `${role}#${slot}` : role;
    this.routes.delete(key); this.sharedGrants.delete(key);
    await this.broker.request('close', slotArgs(key));
  }

  // A call to Studio for the harness package, with the grant of `role` (main by
  // default), which never leaves this package. Only Studio's own run and managed paths.
  async studioCall({ method = 'POST', path, body, role = 'main' }) {
    if (!this.grant) throw Error('managed-run-required');
    if (!busCallAllowed(path) || !['GET', 'POST'].includes(method) || !this.routes.has(role)) throw Error('managed-call-refused');
    // A helper's call (settle) uses that helper's grant, not main's.
    const share = shareGrant(this, role);
    try {
      const grant = await share.grant;
      const response = await this.fetchImpl(`${this.origin}${path}`, { method, signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': CLIENT_AGENT },
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) });
      const text = (await response.text()).slice(0, CALL_BYTES);
      return { ok: response.ok, status: response.status, body: redact(text) };
    } finally { releaseGrant(this, role, share); }
  }

  // Wires the harness-facing channels of the bus.
  listen() {
    const { events } = this.pi;
    claimNonce(events, 'provider'); // the bus secret of the harness, when there is one (bus-nonce.mjs)
    const checked = handler => p => { if (nonceOk(events, p)) handler(p); else reply(p, { ok: false, error: 'managed-bus-nonce' }); };
    const answer = (payload, work) => work().then(result => reply(payload, { ok: true, ...result }), error => reply(payload, { ok: false, error: failureCode(failureText(error)) }));
    return [
      events.on(CHANNEL.grantRequest, checked(p => void answer(p, async () => ({ role: p.role, ...(await this.grantFor({ role: p.role, slot: p.slot })) })))),
      events.on(CHANNEL.grantClose, checked(p => void this.closeChild(p).catch(() => {}))),
      events.on(CHANNEL.runProcess, checked(p => this.setProcess(p?.process))),
      events.on(CHANNEL.studioCall, checked(p => void answer(p, () => this.studioCall(p)))),
    ];
  }

  async dispose() {
    this.shutdown.abort(); this.studioLink.cancel();
    await this.close();
    await this.broker.dispose();
  }
}

export const processVersion = features => features.includes('process-v3') ? 3 : features.includes('process-v2') ? 2 : features.includes('process') ? 1 : 0;

// Studio too busy to answer in time (many requests of one key at once): a read
// of the key's configuration, or a run start, is asked again shortly.
async function patiently(ask, times, pause = 1500) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await ask(); }
    catch (error) { if (attempt >= times || !BUSY.test(String(error?.message))) throw error; await sleep(pause * attempt); }
  }
}
