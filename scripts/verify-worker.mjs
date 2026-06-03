import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const toml = fs.readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const checks = [
  ['has ipwho.is https', source.includes('https://ipwho.is/batch')],
  ['has csp header', source.includes('content-security-policy')],
  ['admin login no url token', !source.includes("/admin?token=" ) && !source.includes('URLSearchParams(location.search).get(\'token\')')],
  ['cron offset 15 min', toml.includes('crons = ["15 */6 * * *"]')],
  ['version 3.6.0', source.includes('const VERSION = "3.6.0"')],
];
for (const [name, ok] of checks) {
  if (!ok) throw new Error(`check failed: ${name}`);
  console.log(`ok: ${name}`);
}
