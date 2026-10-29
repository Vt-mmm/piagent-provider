import fs from 'node:fs';
import { parseJson } from './json.mjs';

// How the provider names itself to Studio on every company request, so
// Studio's reports show the tool and its version ("piagent/0.1.0").
const manifest = parseJson(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'), {});
export const CLIENT_AGENT = `piagent/${manifest.version ?? '0.0.0'}`;
