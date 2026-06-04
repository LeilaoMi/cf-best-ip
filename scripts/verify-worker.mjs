import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const toml = fs.readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const cidr = fs.readFileSync(new URL('../src/cidr.js', import.meta.url), 'utf8');
const scoring = fs.readFileSync(new URL('../src/scoring.js', import.meta.url), 'utf8');
const dns = fs.readFileSync(new URL('../src/dns.js', import.meta.url), 'utf8');
const scheduledWorkflow = fs.readFileSync(new URL('../.github/workflows/scheduled-test.yml', import.meta.url), 'utf8');
const checks = [
  ['has ipwho.is https', source.includes('https://ipwho.is/batch')],
  ['has csp header', source.includes('content-security-policy')],
  ['admin api no query token', source.includes('function adminToken(request)') && source.includes('return bearerToken(request);')],
  ['config sanitizer', source.includes('function sanitizeConfigPatch') && source.includes('dangerous config requires confirm=I_UNDERSTAND')],
  ['config raw confirm', source.includes('x-config-raw-confirm')],
  ['500 hides stack', source.includes('error: "internal-error"') && !source.includes('stack: e?.stack')],
  ['health status reasons', source.includes('status, reasons') && source.includes('lastErrorAt')],
  ['cron offset 15 min', toml.includes('crons = ["15 */6 * * *"]') && readme.includes('Cron `15 */6 * * *`')],
  ['readme module structure current', !readme.includes('~1580 行') && readme.includes('src/cidr.js') && readme.includes('src/scoring.js') && readme.includes('src/dns.js')],
  ['readme config auth', readme.includes('Authorization: Bearer <ADMIN_TOKEN>')],
  ['readme api parameter table', readme.includes('常用查询参数') && readme.includes('perCountryN=2') && readme.includes('comment=0')],
  ['readme subscription formats', readme.includes('format=plain/csv/jsonl')],
  ['readme cf token least privilege', readme.includes('目标域名 Zone') && readme.includes('DNS Edit') && readme.includes('不要写进 `wrangler.toml`')],
  ['readme robots not access control', readme.includes('robots.txt') && readme.includes('不是访问控制')],
  ['readme dns only records', readme.includes('DNS only A 记录')],
  ['quality metadata', source.includes('function qualityForIp') && source.includes('testedBy=hostmonit') && source.includes('confidence')],
  ['post-geo country blocklist', source.includes('地理补全后再执行一次国家黑名单')],
  ['critical source health', source.includes('criticalSourcesOk') && source.includes('critical-source-failed')],
  ['source alias signal stats', source.includes('sourceSignalName') && source.includes('independentSignals')],
  ['sub cache headers', source.includes('SUB_CACHE_HEADERS') && source.includes('public, max-age=300')],
  ['dns managed query request count', source.includes('function listManagedARecords') && source.includes('cfApiRequests')],
  ['notify error persistence', source.includes('notify:lastError') && source.includes('Telegram notify failed')],
  ['public refresh warning', source.includes('publicRefreshEnabled') && source.includes('public-refresh-warning')],
  ['client test resource guard', source.includes('getClientTestConcurrency') && source.includes('MAX_CLIENT_TEST_ROWS') && source.includes('document.hidden')],
  ['http geo untrusted display only', source.includes('geoTrusted === false')],
  ['cidr module extracted', source.includes('from "./cidr.js"') && cidr.includes('export function isCfNativeIp')],
  ['scoring module extracted', source.includes('from "./scoring.js"') && scoring.includes('export function qualityGuard')],
  ['dns diff module extracted', source.includes('from "./dns.js"') && dns.includes('export function planDnsRecordSync')],
  ['workflow runs node test', scheduledWorkflow.includes('node --test')],
  ['stage5 csv/jsonl subscription', source.includes('function fmtSubCsv') && source.includes('function fmtSubJsonl') && source.includes('format === "csv"') && source.includes('format === "jsonl"')],
  ['stage5 plain homepage', source.includes('function renderPlainHome') && source.includes('params.get("plain") === "1"')],
  ['stage5 network card', source.includes('我的网络信息') && source.includes('visitor.asn') && source.includes('visitor.colo')],
  ['stage5 admin trend svg', source.includes('trendSvg') && source.includes('7天节点数量趋势')],
  ['refresh running lock', source.includes('refresh:running') && source.includes('refresh-running')],
  ['admin tokens memory only', !source.includes('sessionStorage') && source.includes('__cfBestIpAdminToken') && source.includes('let refreshToken')],
  ['config import export', source.includes('params.get("export") === "1"') && source.includes('format: "cf-best-ip-config-v1"') && source.includes('imported: Boolean')],
  ['readme security batch 1', readme.includes('refresh:running') && readme.includes('仅保存在当前 JS 内存') && readme.includes('导入运行时配置')],
  ['version 3.8.1', source.includes('const VERSION = "3.8.1"') && readme.includes('version-3.8.1-blue')],
];
for (const [name, ok] of checks) {
  if (!ok) throw new Error(`check failed: ${name}`);
  console.log(`ok: ${name}`);
}
