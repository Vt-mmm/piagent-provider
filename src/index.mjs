// piagent-provider: Studio model provider for Piagent company mode on stock Pi.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrokerClient } from './broker-client.mjs';
import { CHANNEL } from './bus.mjs';
import { restoreFast } from './fast-mode.mjs';
import { guardedEditor } from './guard.mjs';
import { parseJson } from './json.mjs';
import { safeOrigin } from './manifest.mjs';
import { DISPLAY_NAME, PROVIDER, StudioProvider } from './provider.mjs';
import { createThinkingGuard } from './thinking.mjs';

const BINDING_BYTES = 16_384;

// Agent Watch writes the binding of the member's key; it is only read here.
// PIAGENT_BINDING names another file (tests, a second profile).
export function readBinding(file = process.env.PIAGENT_BINDING ?? path.join(os.homedir(), '.pi', 'agent', 'agent-watch-managed.json')) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > BINDING_BYTES) throw Error('managed-binding-invalid');
  const binding = parseJson(fs.readFileSync(file, 'utf8'));
  if (binding?.schema_version !== 1 || binding.model !== 'agent-watch-auto' || !/^[a-f0-9]{64}$/.test(binding.profile_id ?? '')) throw Error('managed-binding-invalid');
  return { ...binding, origin: safeOrigin(binding.origin) };
}

// Pi's own stream implementations of the three wires Studio serves, and the
// catalog; loaded here so tests can hand in simulated ones.
async function defaultDeps() {
  const ai = await import('@earendil-works/pi-ai/compat');
  const apis = { 'anthropic-messages': ai.anthropicMessagesApi().streamSimple, 'openai-responses': ai.openAIResponsesApi().streamSimple,
    'openai-completions': ai.openAICompletionsApi().streamSimple };
  const { CustomEditor } = await import('@earendil-works/pi-coding-agent');
  return { ai, apis, lookup: (provider, id) => ai.getModel(provider, id), CustomEditor };
}

export default async function piagentProvider(pi, deps = {}) {
  const binding = deps.binding ?? readBinding();
  const base = { ...(await defaultDeps()), ...deps };
  const broker = deps.broker ?? new BrokerClient({ executable: binding.broker, profileID: binding.profile_id });
  const provider = await StudioProvider.create({ pi, ai: base.ai, apis: base.apis, broker, origin: binding.origin, lookup: base.lookup,
    stateDir: deps.stateDir ?? process.env.PI_CODING_AGENT_DIR ?? null, fetchImpl: deps.fetchImpl, briefPauseMs: deps.briefPauseMs, linkOptions: deps.linkOptions });
  const thinking = createThinkingGuard(pi, { allowed: () => provider.allowed, log: entry => provider.studioLink.log(entry) });
  const stops = provider.listen();
  const model = ctx => ctx.modelRegistry.find(PROVIDER, provider.model.id);

  pi.on('session_start', async (_event, ctx) => {
    provider.ctx = ctx;
    provider.fast = restoreFast(provider.entries);
    ctx.ui.setEditorComponent?.((tui, theme, keybindings) => new (guardedEditor(base.CustomEditor, (text, kind) => ctx.ui.notify(text, kind)))(tui, theme, keybindings));
    const found = model(ctx);
    if (found) await pi.setModel(found);
    thinking.force('medium');
  });
  // A member's message starts the round over; Pi's auto-retry and the harness's
  // own send-backs start new agent runs of the same message and keep its run.
  pi.on('before_agent_start', async (event, ctx) => {
    provider.ctx = ctx;
    if (event.messageType === 'user') { provider.nextPurpose = null; provider.sharedGrants.clear(); }
    const had = provider.grant;
    await provider.startRun({ text: event.prompt, level: pi.getThinkingLevel(), signal: ctx.signal });
    // The run's route may carry other limits than the last one: Pi takes the new model object.
    if (provider.grant && !had) {
      const found = model(ctx);
      if (found) await pi.setModel(found);
      if (provider.grant.effort) thinking.force(provider.grant.effort);
    }
  });
  pi.on('turn_start', () => provider.turnStart());
  pi.on('thinking_level_select', event => thinking.onSelect(event));
  pi.on('model_select', async (event, ctx) => {
    if (event.model?.provider === PROVIDER) return;
    const found = model(ctx);
    if (found) { await pi.setModel(found); ctx.ui.notify(`Chế độ công ty chỉ có một model "${DISPLAY_NAME}".`, 'warning'); }
  });
  pi.on('agent_settled', () => provider.close());
  pi.on('session_shutdown', async () => { for (const stop of stops) stop(); await provider.dispose(); });
  pi.events.emit(CHANNEL.notice, { v: 1, type: 'provider_ready' });
  return provider;
}
