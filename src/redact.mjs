// Run grants and keys never reach a log, a file or an error shown to the
// member: any text that leaves a module passes through here first. The secret
// shapes live in secret-patterns.mjs (the same file in every Piagent package).
import { redactSecrets } from './secret-patterns.mjs';

export function redact(text) {
  return redactSecrets(text, '[redacted]');
}
