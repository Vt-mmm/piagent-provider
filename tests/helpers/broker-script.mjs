// A stand-in for Agent Watch's `managed-broker` executable: JSON lines on stdio.
// `mode` picks a misbehaviour; the script is written to a temp file by the test.
export const script = mode => `#!${process.execPath}
import readline from 'node:readline';
const mode = ${JSON.stringify(mode)};
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const request = JSON.parse(line);
  const reply = body => process.stdout.write(JSON.stringify({ id: request.id, ...body }) + '\\n');
  if (mode === 'garbage') return void process.stdout.write('not json\\n');
  if (request.action === 'fail') return reply({ error: 'server Unavailable!', studio_code: 'harness_route_unavailable' });
  if (request.action === 'env') return reply({ result: Object.keys(process.env).sort() });
  reply({ result: { echo: request.action, args: process.argv.slice(2) } });
});
`;
