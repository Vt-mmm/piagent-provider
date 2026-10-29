import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJson } from './json.mjs';

// The Pi host company sessions are qualified on: this package's peer
// dependency, so moving to a new host is one change.
const own = parseJson(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'), {});
export const PI_HOST_VERSION = own.peerDependencies?.['@earendil-works/pi-coding-agent'];
const HOST_NAME = '@earendil-works/pi-coding-agent';
const readManifest = dir => parseJson(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));

// A package the host depends on (pi-ai), found the way Node finds it from the
// host: in its own node_modules, else in a parent's (1.x hoists it).
export function hostPackage(sdk, name) {
  for (let dir = sdk; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(dir) === dir) throw Error(`managed-sdk-dependency-missing: ${name}`);
  }
}

// A member may run a newer Pi than the pinned host and Piagent never replaces
// it: the pinned host is installed beside it under ~/.piagent/pi-host/<version>.
export const privateHostPrefix = (version = PI_HOST_VERSION, home = os.homedir()) => path.join(home, '.piagent', 'pi-host', version);

// The private host's package root when it holds exactly `version`, else null.
export function privateHostRoot(version = PI_HOST_VERSION, home = os.homedir()) {
  const root = path.join(privateHostPrefix(version, home), 'node_modules', ...HOST_NAME.split('/'));
  try {
    const manifest = readManifest(root);
    return manifest?.name === HOST_NAME && manifest.version === version ? fs.realpathSync(root) : null;
  } catch { return null; }
}

// The host's command line entry (`pi`), as its manifest names it.
export function hostCli(root) {
  const bin = readManifest(root).bin;
  return path.join(root, typeof bin === 'string' ? bin : bin.pi);
}

const parts = version => String(version).split(/[+-]/)[0].split('.').map(Number);
export function compareVersions(a, b) {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

// What setup does with the `pi` on PATH: nothing when it is the pinned host;
// keep a newer one (the member's own) and install the pinned host privately;
// replace a missing or older one.
export function hostPlan(current, pinned = PI_HOST_VERSION) {
  if (current === pinned) return 'current';
  return current && compareVersions(current, pinned) > 0 ? 'private' : 'global';
}

// Installs the pinned host into its private prefix, without install scripts.
// Returns the package root.
export function installPrivateHost({ version = PI_HOST_VERSION, home = os.homedir(), npm = 'npm', dryRun = false, log = () => {} } = {}) {
  const existing = privateHostRoot(version, home);
  if (existing) return existing;
  const prefix = privateHostPrefix(version, home);
  const args = ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', `${HOST_NAME}@${version}`];
  log(`${dryRun ? 'DRY RUN: ' : ''}${npm} ${args.join(' ')}`);
  if (dryRun) return path.join(prefix, 'node_modules', ...HOST_NAME.split('/'));
  fs.mkdirSync(prefix, { recursive: true, mode: 0o700 });
  const result = spawnSync(npm, args, { stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });
  const root = privateHostRoot(version, home);
  if (result.status !== 0 || !root) throw Error(`pi-host-private-install-failed: ${HOST_NAME}@${version}`);
  return root;
}
