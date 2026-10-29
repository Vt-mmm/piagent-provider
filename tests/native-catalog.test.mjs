import test from 'node:test';
import assert from 'node:assert/strict';
import * as ai from '@earendil-works/pi-ai/compat';
import { isVendor, nativeManagedModel, piProvider, studioAPI, studioModel, studioPath } from '../src/native-catalog.mjs';

const lookup = (provider, id) => ai.getModel(provider, id);

test('each Studio provider has its own wire, path and Pi provider', () => {
  assert.deepEqual(['claude', 'codex', 'deepseek'].map(studioAPI), ['anthropic-messages', 'openai-responses', 'openai-completions']);
  assert.deepEqual(['claude', 'codex', 'deepseek'].map(studioPath), ['/claude', '/v1', '/openai/v1']);
  assert.deepEqual(['claude', 'codex', 'kimi-coding'].map(piProvider), ['anthropic', 'openai-codex', 'kimi-coding']);
  assert.equal(isVendor('deepseek'), true); assert.equal(isVendor('claude'), false); assert.equal(isVendor('Bad Name'), false);
});

test('a model missing from Pi\'s catalog comes from the reviewed gaps; an unknown one is not guessed', () => {
  const none = () => undefined;
  assert.equal(nativeManagedModel(none, 'anthropic', 'claude-sonnet-5-5').contextWindow, 1000000);
  assert.equal(nativeManagedModel(none, 'anthropic', 'claude-haiku-5-5').maxTokens, 128000);
  assert.equal(nativeManagedModel(none, 'anthropic', 'claude-future-9'), undefined);
});

test("Sol keeps Codex's 272k window even when Pi's catalog allows more", () => {
  const sol = nativeManagedModel(lookup, 'openai-codex', 'gpt-6.1-sol');
  assert.equal(sol.contextWindow, 272000);
});

test('studioModel: the key\'s output ceiling caps Claude and vendors, not Codex; vendors lose foreign thinking parameters', () => {
  const claude = nativeManagedModel(lookup, 'anthropic', 'claude-sonnet-5-5');
  assert.equal(studioModel(claude, { owned_by: 'claude', max_output_tokens: 4096 }, 'http://o').maxTokens, 4096);
  const sol = nativeManagedModel(lookup, 'openai-codex', 'gpt-6.1-sol');
  const codex = studioModel(sol, { owned_by: 'codex', max_output_tokens: 10 }, 'http://o');
  assert.equal(codex.maxTokens, sol.maxTokens); assert.equal(codex.compat.supportsMaxOutputTokens, false);
  assert.equal(codex.api, 'openai-responses'); assert.equal(codex.baseUrl, 'http://o/v1');
  const grok = { id: 'g', api: 'openai-responses', reasoning: true, thinkingLevelMap: { low: 'low' }, compat: { x: 1 }, maxTokens: 1000 };
  const vendor = studioModel(grok, { owned_by: 'xai' }, 'http://o');
  assert.deepEqual([vendor.reasoning, vendor.api, vendor.baseUrl], [false, 'openai-completions', 'http://o/openai/v1']);
  assert.throws(() => studioModel(claude, { owned_by: 'claude', max_output_tokens: 0 }, 'http://o'), /managed-output-limit-invalid/);
});
