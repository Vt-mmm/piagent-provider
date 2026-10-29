// Why a company request failed, as one stable code and one sentence a member
// can act on. Studio answers with a machine code; the broker and this package
// have their own. The Terminal shows the sentence, nothing names the model.
//
// Kinds: refused, quota, provider-limit, account, busy, trial-limit, key,
// policy, new-session, rejected, unreachable, service, config-changed, update,
// failed.
import { redact } from './redact.mjs';

const CODES = {
  token_quota_exhausted: ['quota', "this key's token quota is used up"],
  upstream_rate_limited: ['provider-limit', "the company's model account is rate limited or out of usage at the provider"],
  account_capacity_unavailable: ['provider-limit', 'no company model account has capacity for this model right now'],
  concurrency_limit: ['busy', 'this key already runs its maximum number of requests'],
  request_rate_limit: ['busy', 'this key sends requests too fast'],
  helper_capacity_exhausted: ['busy', 'this key already runs its maximum number of subagents'],
  connector_busy: ['busy', "Studio's model gateway is at capacity"],
  gateway_busy: ['busy', "Studio's model gateway is at capacity"],
  operation_unavailable: ['busy', 'Studio could not check this request in time'],
  account_recovering: ['busy', 'the company model account is being checked after an earlier failure'],
  session_account_busy_retry_later: ['busy', "this conversation's model account is busy"],
  session_account_not_ready_retry_later: ['busy', "this conversation's model account is not ready yet"],
  live_trial_limit_reached: ['trial-limit', "Studio's live-test request ceiling is used up; an administrator has to raise it"],
  authentication_required: ['key', 'the company key is no longer valid'],
  invalid_run_grant: ['key', 'the company key or this run is no longer valid'],
  run_grant_required: ['key', 'this key only works through Agent Watch'],
  policy_denied: ['policy', 'this key may not use this model, thinking level or output size'],
  thinking_level_unavailable: ['policy', 'this thinking level is not available for the harness'],
  harness_model_unsupported: ['policy', 'the harness uses a model Studio cannot run'],
  harness_profile_unavailable: ['policy', "the team's harness has no model for this role"],
  harness_route_unavailable: ['provider-limit', "no company model account serves this role's model for the team right now"],
  execution_capability_unavailable: ['policy', 'no company model account can run this model'],
  session_account_unavailable_start_new_session: ['new-session', "this conversation's model account is gone"],
  run_state_conflict: ['config-changed', 'this run was closed or replaced'],
  run_recovery_pending_usage: ['busy', 'an earlier request of this run is still being accounted'],
  invalid_request: ['rejected', 'Studio rejected the request as invalid'],
  upstream_request_rejected: ['rejected', 'the model rejected the request (too long or not valid for it)'],
  upstream_policy_refusal: ['refused', "the model's provider declined this request under its usage policy"],
  request_too_large: ['rejected', 'the conversation is larger than Studio accepts in one request (4 MiB)'],
  execution_precondition_failed: ['service', 'the chosen company model account changed before the request started'],
  connector_unavailable: ['service', "Studio's model gateway is not available"],
  connector_execution_failed: ['service', "Studio's model gateway failed"],
  inference_unavailable: ['service', 'Studio could not run the request'],
  managed_service_unavailable: ['service', 'Studio could not start the run'],
  upstream_interrupted: ['service', 'the model response was interrupted'],
  upstream_incomplete: ['service', 'the model returned no response'],
  upstream_server_error: ['service', 'the model provider failed while answering (a passing error on its side)'],
  output_limit_exceeded: ['service', 'the model kept writing past its output limit and was stopped'],
  client_cancelled: ['service', 'the request was ended at Studio'],
  superseded: ['service', 'the request was replaced by a newer one'],
  upstream_timeout: ['service', 'the model did not answer in time'],
  upstream_unavailable: ['service', 'the model provider is not answering'],
  upstream_auth_required: ['account', "the company's model account has to sign in again in Studio"],
  'studio-unreachable': ['unreachable', 'Studio could not be reached'],
  'managed-broker:offline': ['unreachable', 'Agent Watch could not reach Studio'],
  'managed-broker-timeout': ['unreachable', 'Agent Watch did not answer in time'],
  'managed-broker-disconnected': ['unreachable', 'the Agent Watch helper stopped'],
  'managed-broker:serverUnavailable': ['service', 'Studio could not start the run'],
  'managed-broker:upstreamUnavailable': ['service', 'Studio could not start the run'],
  'managed-broker:invalidKey': ['key', 'the company key is no longer valid'],
  'managed-broker:permissionDenied': ['key', 'Agent Watch no longer holds a usable company key'],
  'managed-broker:keychainApprovalRequired': ['key', 'macOS has not allowed Agent Watch to read the company key'],
  'managed-broker:quotaExceeded': ['quota', "this key's token quota is used up"],
  'managed-broker:rateLimited': ['busy', 'Studio is limiting this key right now'],
  'managed-broker:identityChanged': ['config-changed', 'the key, harness or run changed in Studio'],
  'managed-broker:invalidResponse': ['config-changed', 'Studio refused to start the run with the current harness'],
  'managed-route-changed': ['config-changed', 'the harness model changed while this run was active'],
  'managed-grant-invalid': ['config-changed', 'the harness changed and this conversation still has the old one'],
  'managed-configuration-unavailable': ['config-changed', 'the key has no usable harness'],
  'managed-main-model-unavailable': ['policy', 'the harness main model is not available to this key'],
  'managed-native-catalog-update-required': ['update', 'this package does not know the harness model; update it'],
  'managed-run-required': ['config-changed', 'no company run is active'],
  'managed-fast-unavailable': ['policy', "the team's Harness does not allow fast mode"],
  'managed-request-failed': ['failed', 'the request could not be sent'],
  'studio-request-failed': ['failed', 'Studio answered with an error'],
  'studio-gateway-unavailable': ['unreachable', "Studio's gateway answered that Studio is not reachable"],
};
const ROLES = { main: 'main agent', scout: 'scout subagent', research: 'research subagent', verify: 'verify subagent', review: 'review subagent' };
const REQUEST = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/;
const PROVIDER_SERVER_ERROR = new RegExp([
  '^(?:Error Code )?(?:server_error|api_error|internal_error|internal_server_error|overloaded_error|undefined):',
  'An error occurred while processing your request',
  '"type"\\s*:\\s*"(?:api_error|overloaded_error)"',
  '\\bOverloaded\\b',
].join('|'), 'i');
const NETWORK = /fetch failed|econnrefused|econnreset|enotfound|ehostunreach|etimedout|socket hang up|network|connection error|terminated|timed? ?out|aborted due to timeout/i;

export const failureKind = code => CODES[code]?.[0] ?? 'failed';
// Studio said no at admission, before any model account was asked: the same
// request can be asked again later and nothing reaches the model twice. A
// failure after admission is never in this list: replaying it could repeat
// billed work.
const ADMISSION = new Set(['session_account_busy_retry_later', 'session_account_not_ready_retry_later',
  'concurrency_limit', 'account_capacity_unavailable', 'request_rate_limit', 'gateway_busy', 'connector_busy']);
export const failureIsAdmissionRefusal = code => ADMISSION.has(code);
// Refused before the model did any work, for a reason that passes in seconds
// (a sign-in being renewed, a lapsed two-minute grant): each ask renews the
// grant first, and only a few times.
const BRIEF = new Set(['execution_precondition_failed', 'upstream_auth_required', 'invalid_run_grant', 'operation_unavailable']);
export const failureIsBriefRefusal = code => BRIEF.has(code);
// The words of a failure no code names, redacted, for a record nobody is shown.
export function unnamedFailureText(raw) {
  return ['managed-request-failed', 'studio-request-failed'].includes(failureCode(raw)) ? redact(raw).slice(0, 600) : null;
}
export const failureReason = code => (CODES[code] ?? CODES['managed-request-failed'])[1];
// A failure Studio never saw: nothing was sent, so it is not a model request.
export const failureIsLocal = code => code.startsWith('managed-') || code === 'studio-unreachable' || code === 'studio-gateway-unavailable';
const known = code => typeof code === 'string' && Object.hasOwn(CODES, code) ? code : null;

// The stable code inside any error text this package can produce or receive.
export function failureCode(raw) {
  const text = String(raw ?? '');
  const tagged = /\[([A-Za-z0-9_:.-]{1,80})\](?: \(request [0-9a-f-]{36}\))?\s*$/.exec(text)?.[1];
  if (known(tagged)) return tagged;
  const studio = /"code"\s*:\s*"([a-z0-9_]{1,80})"/.exec(text)?.[1];
  if (studio === 'initial_request_limit_reached') return 'live_trial_limit_reached';
  if (known(studio)) return studio;
  const local = /(managed-broker:[A-Za-z_]{1,80}|managed-[a-z-]{1,80})/.exec(text)?.[1];
  if (known(local)) return local;
  if (!studio && /\bAPI error \((?:50[234]|52\d|530)\)|^(?:50[234]|52\d|530)\b/.test(text)) return 'studio-gateway-unavailable';
  if (PROVIDER_SERVER_ERROR.test(text)) return 'upstream_server_error';
  if (studio || /\bAPI error \(\d{3}\)|^\d{3} \{/.test(text)) return 'studio-request-failed';
  if (/usage policy|violative|refusals-and-fallback/i.test(text)) return 'upstream_policy_refusal';
  if (/stream ended without a (terminal event|stop reason)|response has no body/i.test(text)) return 'upstream_incomplete';
  if (/^Request interrupted\b/i.test(text)) return 'upstream_interrupted';
  if (/^The answer ran past its output limit\b/i.test(text)) return 'output_limit_exceeded';
  if (NETWORK.test(text)) return 'studio-unreachable';
  return 'managed-request-failed';
}

// An error's text with Studio's own reason for a refusal Agent Watch passed
// on (error.studioCode), in the shape failureCode reads first.
export function failureText(error) {
  const text = String(error?.message ?? error ?? '');
  return typeof error?.studioCode === 'string' ? `${text} {"code":"${error.studioCode}"}` : text;
}

// "Agent Watch main agent: <what failed> [code] (request <id>)".
export function describeFailure(role, raw) {
  const code = failureCode(raw), request = REQUEST.exec(String(raw ?? ''))?.[1];
  return redact(`Agent Watch ${ROLES[role] ?? ROLES.main}: ${CODES[code][1]} [${code}]${request && !failureIsLocal(code) ? ` (request ${request})` : ''}`);
}
