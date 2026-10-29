// Just enough of Pi's extension API for the provider: handlers, the event bus,
// provider registration and the few setters the provider calls. Real Pi runs
// in tests/pi-smoke.test.mjs.
export function createBus() {
  const handlers = new Map();
  return { emit(channel, data) { for (const fn of handlers.get(channel) ?? []) fn(data); },
    on(channel, fn) { handlers.set(channel, [...(handlers.get(channel) ?? []), fn]); return () => handlers.set(channel, handlers.get(channel).filter(f => f !== fn)); } };
}

export class FakePi {
  constructor() {
    Object.assign(this, { handlers: new Map(), events: createBus(), providers: new Map(), entries: [], level: 'medium', levelsSet: [], models: [], seen: [], registrations: 0 });
    this.events.on('piagent:notice', e => this.seen.push(e));
  }
  on(name, fn) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]); }
  registerProvider(name, config) { this.providers.set(name, config); this.registrations += 1; }
  appendEntry(customType, data) { this.entries.push({ type: 'custom', customType, data }); }
  getThinkingLevel() { return this.level; }
  setThinkingLevel(level) { this.level = level; this.levelsSet.push(level); }
  async setModel(model) { this.models.push(model); return true; }
  async fire(name, event = {}, ctx = this.ctx) { for (const fn of this.handlers.get(name) ?? []) await fn({ type: name, ...event }, ctx); }
  get provider() { return this.providers.get('studio'); }
  // The model object Pi would hand to the provider's stream.
  get model() { return { ...this.provider.models[0], provider: 'studio', baseUrl: this.provider.baseUrl }; }
  stream(context, options = {}) { return this.provider.streamSimple(this.model, context, { apiKey: this.provider.apiKey, ...options }); }
  makeContext() {
    const notices = [];
    this.ctx = { ui: { notify: (text, kind) => notices.push({ text, kind }), setEditorComponent() {}, setWorkingMessage() {} }, notices, signal: undefined,
      sessionManager: { getSessionId: () => 'session-0001-fixed', getEntries: () => this.entries }, modelRegistry: { find: () => this.model }, model: undefined };
    return this.ctx;
  }
}

export async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return { events, message: await stream.result() };
}
