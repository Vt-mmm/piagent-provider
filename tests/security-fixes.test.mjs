import assert from 'node:assert/strict';
import { test } from 'node:test';
import { busCallAllowed } from '../src/bus.mjs';
import { purposeHeaders } from '../src/call-purpose.mjs';
import { redact } from '../src/redact.mjs';
import { NEEDLES, SECRETS } from './fixtures/secret-corpus.mjs';

// Regression tests for docs/security-review.md (T1 studio.call, T5). Synthetic strings only.
test('T1: piagent:studio.call reaches only the paths the harness uses, so another extension cannot spend the run on a model call', () => {
  for (const path of ['/studio/v1/managed/tool-failures', '/v1/managed/settle', '/v1/memory/search', '/v1/memory/retain']) assert.ok(busCallAllowed(path), path);
  for (const path of ['/v1/chat/completions', '/v1/messages', '/v1/requests/abc/cancel', '/v1/models', '/studio/v1/managed/disconnects', '/v1/memory/', '/v1/memory/search?x=1', '/v1/memory/../x',
    '/studio/v1/managed/x', '/v1/', undefined, 7]) assert.ok(!busCallAllowed(path), String(path));
});

test('T5: every secret shape of the corpus is redacted from text that leaves the provider', () => {
  for (const [i, secret] of SECRETS.entries()) assert.ok(!redact(`upstream said ${secret} end`).includes(NEEDLES[i]), `leaked: ${NEEDLES[i]}`);
});

test('T5: no prompt text goes to Studio in a call header: a helper\'s brief title is never sent', () => {
  const owner = { jobTitles: new Map([['scout', 'Find where the login token is kept']]), nextPurpose: null };
  const headers = purposeHeaders(owner, 'scout', { messages: [{ role: 'user', content: 'x' }] });
  assert.deepEqual(Object.keys(headers), ['X-Agent-Purpose']);
  assert.ok(!JSON.stringify(headers).includes('login'));
});
