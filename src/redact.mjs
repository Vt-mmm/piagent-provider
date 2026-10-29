// Run grants and keys never reach a log, a file or an error shown to the
// member: any text that leaves a module passes through here first.
const SECRETS = [
  /as_(?:run|device)_[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{12,}/g,
];
export function redact(text) {
  return SECRETS.reduce((out, pattern) => out.replace(pattern, '[redacted]'), String(text ?? ''));
}
