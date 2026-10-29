# piagent-provider

Studio model provider for Piagent company mode: one 'Auto (company)' model, run grants through Agent Watch, Harness-driven thinking.

Part of the Piagent company-mode bundle for stock [Pi](https://github.com/earendil-works) (pinned: `@earendil-works/pi-coding-agent` 1.4.0). See `piagent-bundle/docs` for the plan, contracts and runbook.

Status: phase 2.1, implemented against simulated Studio and broker only. Not yet run against a real Agent Watch or Studio.

## What it does

- Registers one model, `studio/agent-watch-auto` ("Auto (công ty)"). The Harness picks the real model per run; the registered model takes that model's limits at run start, and the request goes to Studio on the right wire (Anthropic Messages, OpenAI Responses or Chat Completions for API-key vendors) through Pi's own stream implementations.
- Takes a grant (run token) per role from Agent Watch's broker (`config`, `start`, `renew`, `close`, `child`). At every `turn_start` it renews the grant and re-registers the provider with the new token. The token is never put in `process.env`, a file or a log.
- Resets its round state only at `before_agent_start` with `messageType === 'user'`; Pi's auto-retry and harness send-backs keep the run.
- Keeps the conversation's session id fixed, so Studio binds it to one company account.
- Waits for Studio with no limit when it stops or restarts (`studio-link`), writes `logs/studio-link.jsonl` (`kind: studio_disconnect`) and reports the wait to Studio.
- Puts a thinking level the Harness does not allow back to the right one (`thinking_level_select`).
- Blocks `/login`, `/logout`, `/model`, `/scoped-models`, `/share` and `/bug` with a message in Vietnamese (editor `onSubmit` wrapper).
- Talks to the sandbox and harness packages only over Pi's event bus (`piagent-bundle/docs/package-contract.md`).

## Setup

The launcher (piagent-bundle) starts Pi with its own agent dir and this settings file, so Pi shows one model:

```json
{ "enabledModels": ["studio/agent-watch-auto"], "retry": { "enabled": true, "maxRetries": 3 } }
```

The binding is read from `~/.pi/agent/agent-watch-managed.json` (written by Agent Watch; never written here), or from the file named by `PIAGENT_BINDING` or, when that is unset, `AGENT_WATCH_MANAGED_BINDING` (the bundle launcher sets it; its binding has no `model` key). State and logs go to `PI_CODING_AGENT_DIR`.

## Development

```bash
npm ci
npm test
```

Tests run offline: a simulated Studio and broker, and real Pi 1.4.0 in a temporary agent dir (`tests/pi-smoke.test.mjs`). No real Studio, model, Keychain or `~/.pi/agent` is touched.

## Security

See [SECURITY.md](SECURITY.md). Report vulnerabilities privately.
