import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as ai from '@earendil-works/pi-ai/compat';
import piagentProvider from '../../src/index.mjs';
import { FakeBroker, FakeStudio, FakeWorld, manifestFor } from './fake-studio.mjs';
import { FakePi } from './fake-pi.mjs';

export const apis = { 'anthropic-messages': ai.anthropicMessagesApi().streamSimple, 'openai-responses': ai.openAIResponsesApi().streamSimple,
  'openai-completions': ai.openAICompletionsApi().streamSimple };

// A provider on a fake Pi, a fake broker and a fake Studio, with a temporary state dir.
export async function setup({ manifestOptions, studioOptions, deps = {}, beforeLoad } = {}) {
  const studio = await new FakeStudio(new FakeWorld(null), studioOptions).listen();
  const world = studio.world;
  world.manifest = manifestFor(studio.origin, manifestOptions);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piagent-provider-'));
  const broker = new FakeBroker(world), pi = new FakePi();
  pi.makeContext();
  const binding = { origin: studio.origin, broker: '/unused', profile_id: 'a'.repeat(64) };
  beforeLoad?.(pi); // what loads before the provider (the harness's bus secret)
  const provider = await piagentProvider(pi, { binding, broker, stateDir, briefPauseMs: 1, CustomEditor: class { setText() {} }, ...deps });
  return { studio, world, broker, pi, provider, stateDir, ctx: pi.ctx,
    async turn(text = 'xin chào', extra = {}) {
      await pi.fire('before_agent_start', { messageType: 'user', prompt: text });
      await pi.fire('turn_start', { turnIndex: 0 });
      return pi.stream({ messages: [{ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }] }, extra);
    },
    async finish() { await pi.fire('agent_settled'); },
    async cleanup() { await pi.fire('session_shutdown'); await studio.close(); fs.rmSync(stateDir, { recursive: true, force: true }); } };
}
