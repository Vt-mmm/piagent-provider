// Reviewed gaps in Pi's bundled catalog. Never infer context/output limits
// for an unknown future model.
const ADAPTIVE = { forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true, supportsMidConvoEffort: true };
const CLAUDE_LEVELS = { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
const claude = fields => ({ provider: 'anthropic', api: 'anthropic-messages', reasoning: true, input: ['text', 'image'], contextWindow: 1000000, maxTokens: 128000,
  thinkingLevelMap: CLAUDE_LEVELS, compat: ADAPTIVE, promptCache: { short: 300, long: 3600 }, ...fields });

// Claude Sonnet 5.5 and Haiku 5.5, checked 2026-09-30 and 2026-10-08:
// https://platform.claude.com/docs/en/models/overview
// Haiku prices rise fivefold above 100k input tokens.
const sonnet55 = claude({ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } });
const haiku55 = claude({ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5',
  cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, tiers: [{ inputTokensAbove: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }] } });
// GPT-6.1 Sol through Codex, checked 2026-10-01: Codex keeps the 272k window of
// its pricing tier; 128k output; efforts low to max, no none/minimal.
// https://developers.openai.com/api/docs/models/gpt-6.1-sol
const sol61 = {
  id: 'gpt-6.1-sol', provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api',
  name: 'GPT-6.1 Sol', reasoning: true, input: ['text', 'image'], contextWindow: 272000, maxTokens: 128000,
  cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] },
  thinkingLevelMap: { off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  compat: { supportsOpenAIGrammarTools: true, supportsAdditionalTools: true, supportsToolSearch: true, supportsMidConvoSystemMessages: true },
  inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 } } },
};
const GAPS = { anthropic: [sonnet55, haiku55], 'openai-codex': [sol61] };

// Studio's providers: the Claude and Codex subscriptions, or an API-key vendor
// (DeepSeek, Kimi, GLM, MiMo, Qwen, OpenCode, Grok) whose id is Pi's own
// provider id; Studio runs vendors as OpenAI Chat Completions.
const VENDOR = /^[a-z][a-z0-9-]{1,39}$/;
export const isVendor = provider => typeof provider === 'string' && provider !== 'claude' && provider !== 'codex' && VENDOR.test(provider);
export const piProvider = provider => provider === 'claude' ? 'anthropic' : provider === 'codex' ? 'openai-codex' : provider;
export const studioAPI = provider => provider === 'claude' ? 'anthropic-messages' : provider === 'codex' ? 'openai-responses' : 'openai-completions';
export const studioPath = provider => provider === 'claude' ? '/claude' : provider === 'codex' ? '/v1' : '/openai/v1';

// Reviewed limits that win over a newer host catalog: company sessions keep
// Sol's 272k window (Codex's base price, doubled above it).
const CAPS = { 'openai-codex': { 'gpt-6.1-sol': 272000 } };

// `lookup(provider, id)` is Pi's catalog (ctx.modelRegistry.find or pi-ai's).
export function nativeManagedModel(lookup, provider, id) {
  const gap = GAPS[provider]?.find(model => model.id === id);
  const model = lookup(provider, id);
  if (!model) return gap ? structuredClone(gap) : undefined;
  const cap = CAPS[provider]?.[id];
  return cap && model.contextWindow > cap ? { ...model, contextWindow: cap } : model;
}

// The model Pi registers for one Studio route: the native limits, on the wire
// Studio serves for the provider, capped by the key's output ceiling.
export function studioModel(native, entry, origin) {
  const vendor = isVendor(entry.owned_by);
  // A vendor model Pi drives over another API keeps its limits but not its
  // thinking parameters, which Chat Completions would not accept.
  const base = vendor && native.api !== 'openai-completions' ? { ...native, reasoning: false, thinkingLevelMap: undefined, compat: {} } : native;
  const cap = entry.max_output_tokens;
  if (cap !== undefined && (!Number.isSafeInteger(cap) || cap < 1)) throw Error('managed-output-limit-invalid');
  const compat = { ...base.compat };
  delete compat.allowedFallbackModels;
  // Codex subscription requests carry no output-token cap.
  if (entry.owned_by === 'codex') compat.supportsMaxOutputTokens = false;
  const maxTokens = (entry.owned_by === 'claude' || vendor) && cap ? Math.min(base.maxTokens, cap) : base.maxTokens;
  return { ...base, compat, maxTokens, api: studioAPI(entry.owned_by), baseUrl: origin + studioPath(entry.owned_by) };
}
