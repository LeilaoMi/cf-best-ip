import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ECH_FRESH_MS,
  ECH_MAX_BODY_BYTES,
  ECH_MAX_RESULTS,
  ECH_MAX_STORED,
  ECH_RETAIN_MS,
  ECH_STATUS_KEY,
  canonicalIp,
  echFlag,
  makeEchLookup,
  mergeEchStatus,
  readBodyLimited,
  validateEchReport,
} from '../src/ech.js';
import worker from '../src/worker.js';

const HOUR = 60 * 60 * 1000;
const report = (results, extra = {}) => ({ runId: '123456', sentinels: ['doh.example.com'], results, ...extra });

test('canonicalIp validates IPv4 strictly', () => {
  assert.equal(canonicalIp('1.2.3.4'), '1.2.3.4');
  assert.equal(canonicalIp(' 162.159.136.89 '), '162.159.136.89');
  assert.equal(canonicalIp('1.2.3'), null);
  assert.equal(canonicalIp('1.2.3.256'), null);
  assert.equal(canonicalIp('01.2.3.4'), null);
  assert.equal(canonicalIp('1.2.3.4.5'), null);
  assert.equal(canonicalIp(16909060), null);
  assert.equal(canonicalIp(''), null);
});

test('canonicalIp validates and normalizes IPv6 (RFC 5952)', () => {
  assert.equal(canonicalIp('2606:4700:0000:0000:0000:0000:0000:0001'), '2606:4700::1');
  assert.equal(canonicalIp('2606:4700::1'), '2606:4700::1');
  assert.equal(canonicalIp('2606:4700:3036::6815:4944'.toUpperCase()), '2606:4700:3036::6815:4944');
  assert.equal(canonicalIp('::1'), '::1');
  assert.equal(canonicalIp('::'), '::');
  assert.equal(canonicalIp('1:0:0:2:0:0:0:3'), '1:0:0:2::3');
  assert.equal(canonicalIp('1::2::3'), null);
  assert.equal(canonicalIp('12zz::1'), null);
  assert.equal(canonicalIp('1:2:3:4:5:6:7:8:9'), null);
  assert.equal(canonicalIp('1:2:3:4:5:6:7::8'), null);
  assert.equal(canonicalIp('::ffff:1.2.3.4'), null);
});

test('validateEchReport accepts a well-formed report and normalizes it', () => {
  const r = validateEchReport(report([
    { ip: '1.2.3.4', status: 'ok' },
    { ip: '2606:4700:0::1', status: 'unknown' },
  ], { sentinels: ['DOH.Example.com.', 'doh.example.com', 'www.cloudflare.com'] }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.report.sentinels, ['doh.example.com', 'www.cloudflare.com']);
  assert.deepEqual(r.report.results, [
    { ip: '1.2.3.4', status: 'ok' },
    { ip: '2606:4700::1', status: 'unknown' },
  ]);
});

test('validateEchReport keeps the most conservative status for duplicate IPs', () => {
  const r = validateEchReport(report([
    { ip: '1.2.3.4', status: 'ok' },
    { ip: '1.2.3.4', status: 'restricted' },
    { ip: '1.2.3.4', status: 'unknown' },
  ]));
  assert.deepEqual(r.report.results, [{ ip: '1.2.3.4', status: 'restricted' }]);
});

test('validateEchReport rejects malformed input', () => {
  const bad = [
    null,
    [],
    report([], { runId: '' }),
    report([], { runId: 'has space' }),
    report([], { runId: 12 }),
    report([], { sentinels: [] }),
    report([], { sentinels: 'doh.example.com' }),
    report([], { sentinels: ['not a host'] }),
    report([], { sentinels: ['localhost'] }),
    report([], { sentinels: Array.from({ length: 17 }, (_, i) => `h${i}.example.com`) }),
    report('nope'),
    report([{ ip: '1.2.3.999', status: 'ok' }]),
    report([{ ip: '1.2.3.4', status: 'blocked' }]),
    report([{ ip: '1.2.3.4' }]),
    report(['1.2.3.4']),
    report(Array.from({ length: ECH_MAX_RESULTS + 1 }, () => ({ ip: '1.2.3.4', status: 'ok' }))),
  ];
  for (const b of bad) assert.equal(validateEchReport(b).ok, false, JSON.stringify(b)?.slice(0, 80));
  assert.equal(validateEchReport(report(Array.from({ length: ECH_MAX_RESULTS }, () => ({ ip: '1.2.3.4', status: 'ok' })))).ok, true);
});

test('mergeEchStatus: definitive results overwrite, unknown never downgrades a conclusion', () => {
  const now = 10 * 24 * HOUR;
  const prev = {
    updatedAt: now - HOUR,
    runId: 'old',
    sentinels: ['a.example.com'],
    ips: {
      '1.1.1.1': { s: 'ok', t: now - HOUR },
      '2.2.2.2': { s: 'restricted', t: now - HOUR },
      '3.3.3.3': { s: 'unknown', t: now - HOUR },
      '4.4.4.4': { s: 'ok', t: now - HOUR },
      '5.5.5.5': { s: 'ok', t: now - ECH_RETAIN_MS - 1 },   // stale → pruned
      '6.6.6.6': { s: 'weird', t: now },                     // corrupt → pruned
    },
  };
  const { report: rep } = validateEchReport(report([
    { ip: '1.1.1.1', status: 'unknown' },     // keeps ok, old timestamp
    { ip: '2.2.2.2', status: 'ok' },          // overwrite
    { ip: '3.3.3.3', status: 'unknown' },     // refresh unknown
    { ip: '4.4.4.4', status: 'restricted' },  // overwrite
    { ip: '7.7.7.7', status: 'unknown' },     // new unknown
  ], { runId: 'new' }));
  const { next, accepted, counts, pruned } = mergeEchStatus(prev, rep, now);
  assert.equal(next.updatedAt, now);
  assert.equal(next.runId, 'new');
  assert.deepEqual(next.sentinels, ['doh.example.com']);
  assert.deepEqual(next.ips, {
    '1.1.1.1': { s: 'ok', t: now - HOUR },
    '2.2.2.2': { s: 'ok', t: now },
    '3.3.3.3': { s: 'unknown', t: now },
    '4.4.4.4': { s: 'restricted', t: now },
    '7.7.7.7': { s: 'unknown', t: now },
  });
  assert.equal(accepted, 4);
  assert.deepEqual(counts, { ok: 1, restricted: 1, unknown: 3 });
  assert.equal(pruned, 2);
});

test('mergeEchStatus tolerates a missing or corrupt previous value', () => {
  const { report: rep } = validateEchReport(report([{ ip: '1.2.3.4', status: 'ok' }]));
  for (const prev of [null, undefined, {}, { ips: null }, { ips: 'x' }]) {
    const { next } = mergeEchStatus(prev, rep, 1000);
    assert.deepEqual(next.ips, { '1.2.3.4': { s: 'ok', t: 1000 } });
  }
});

test('echFlag maps fresh ok/restricted to true/false and everything else to null', () => {
  const now = 100 * HOUR;
  assert.equal(echFlag({ s: 'ok', t: now - HOUR }, now), true);
  assert.equal(echFlag({ s: 'restricted', t: now - HOUR }, now), false);
  assert.equal(echFlag({ s: 'unknown', t: now - HOUR }, now), null);
  assert.equal(echFlag({ s: 'ok', t: now - ECH_FRESH_MS }, now), true);
  assert.equal(echFlag({ s: 'ok', t: now - ECH_FRESH_MS - 1 }, now), null);
  assert.equal(echFlag({ s: 'restricted', t: now - 37 * HOUR }, now), null);
  assert.equal(echFlag({ s: 'ok', t: now + HOUR }, now), null);
  assert.equal(echFlag(undefined, now), null);
  assert.equal(echFlag({ s: 'ok' }, now), null);
});

test('makeEchLookup canonicalizes lookups and survives bad input', () => {
  const now = 100 * HOUR;
  const lookup = makeEchLookup({ ips: { '2606:4700::1': { s: 'restricted', t: now }, '1.2.3.4': { s: 'ok', t: now } } }, now);
  assert.equal(lookup('2606:4700:0:0::1'), false);
  assert.equal(lookup('1.2.3.4'), true);
  assert.equal(lookup('9.9.9.9'), null);
  assert.equal(lookup('toString'), null);
  assert.equal(makeEchLookup(null, now)('1.2.3.4'), null);
  assert.equal(makeEchLookup({ ips: 5 }, now)('1.2.3.4'), null);
});

test('readBodyLimited enforces the byte limit even without content-length', async () => {
  const small = new Request('https://x.example/', { method: 'POST', body: '{"a":1}' });
  assert.equal(await readBodyLimited(small, 100), '{"a":1}');
  const declared = new Request('https://x.example/', { method: 'POST', body: 'x', headers: { 'content-length': '999999' } });
  await assert.rejects(readBodyLimited(declared, 100), { code: 'body-too-large' });
  const stream = new ReadableStream({
    pull(c) { c.enqueue(new Uint8Array(64)); },
  });
  const chunked = new Request('https://x.example/', { method: 'POST', body: stream, duplex: 'half' });
  await assert.rejects(readBodyLimited(chunked, 1000), { code: 'body-too-large' });
});

// ---------------------------------------------------------------- Worker routes

/** 内存版 KV：支持 get(json)/put/delete，并可通过 failGet 模拟读取失败。 */
function memoryKv(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    store,
    failGet: new Set(),
    async get(key, type) {
      if (this.failGet.has(key)) throw new Error('kv get failed');
      const v = store.get(key);
      if (v == null) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) { store.set(key, String(value)); },
    async delete(key) { store.delete(key); },
  };
}

const HOST = 'https://bestip.example.com';
const POOL = {
  updatedAt: Date.now(),
  ips: [
    { ip: '104.16.0.195', port: 443, family: 'v4', _score: 90 },
    { ip: '162.159.136.89', port: 443, family: 'v4', _score: 80 },
    { ip: '172.67.145.96', port: 443, family: 'v4', _score: 70 },
    { ip: '2606:4700::1', port: 443, family: 'v6', _score: 60 },
  ],
};

/** 带示例池子与 ALLOWED_HOSTS 的测试 env。 */
function makeEnv(extra = {}, kvInit = {}) {
  return { KV: memoryKv({ 'ips:latest': POOL, ...kvInit }), ALLOWED_HOSTS: 'bestip.example.com', ...extra };
}

/** 直接调用 worker.fetch 并解析 JSON 响应。 */
async function call(env, path, init = {}) {
  const res = await worker.fetch(new Request(HOST + path, init), env, { waitUntil() {} });
  return { status: res.status, body: await res.json() };
}

/** 构造带可选 Bearer token 的 JSON POST 请求参数。 */
function post(token, body, headers = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

test('POST /api/ech-report is disabled (503) without ECH_REPORT_TOKEN', async () => {
  const env = makeEnv({ ADMIN_TOKEN: 'admin-secret', REFRESH_TOKEN: 'refresh-secret' });
  const r = await call(env, '/api/ech-report', post('admin-secret', report([])));
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'ech-report-disabled');
});

test('POST /api/ech-report rejects other tokens, wrong method and wrong host', async () => {
  const env = makeEnv({ ECH_REPORT_TOKEN: 'ech-secret', ADMIN_TOKEN: 'admin-secret', REFRESH_TOKEN: 'refresh-secret' });
  for (const t of [null, 'admin-secret', 'refresh-secret', 'ech-secre', 'ech-secret2']) {
    assert.equal((await call(env, '/api/ech-report', post(t, report([])))).status, 401, String(t));
  }
  assert.equal((await call(env, '/api/ech-report?token=ech-secret', post(null, report([])))).status, 401);
  assert.equal((await call(env, '/api/ech-report', { method: 'GET', headers: { authorization: 'Bearer ech-secret' } })).status, 405);
  const res = await worker.fetch(new Request('https://evil.example.com/api/ech-report', post('ech-secret', report([]))), env, {});
  assert.equal(res.status, 421);
});

test('POST /api/ech-report validates body and size', async () => {
  const env = makeEnv({ ECH_REPORT_TOKEN: 'ech-secret', ECH_REPORT_RATE_LIMIT: '0' });
  assert.equal((await call(env, '/api/ech-report', post('ech-secret', '{not json'))).status, 400);
  const bad = await call(env, '/api/ech-report', post('ech-secret', report([{ ip: '1.2.3.4', status: 'maybe' }])));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid-report');
  const huge = 'x'.repeat(ECH_MAX_BODY_BYTES + 1);
  assert.equal((await call(env, '/api/ech-report', post('ech-secret', huge))).status, 413);
  assert.equal(env.KV.store.has(ECH_STATUS_KEY), false);
});

test('POST /api/ech-report merges into KV and /api/ips exposes the ech flag', async () => {
  const old = Date.now() - 40 * HOUR;
  const env = makeEnv({ ECH_REPORT_TOKEN: 'ech-secret' }, {
    [ECH_STATUS_KEY]: { updatedAt: old, runId: 'old', sentinels: ['a.example.com'], ips: { '172.67.145.96': { s: 'ok', t: old } } },
  });
  const r = await call(env, '/api/ech-report', post('ech-secret', report([
    { ip: '104.16.0.195', status: 'ok' },
    { ip: '162.159.136.89', status: 'restricted' },
    { ip: '172.67.145.96', status: 'unknown' }, // keeps the old (now expired) ok
  ], { runId: '987' })));
  assert.equal(r.status, 200);
  assert.deepEqual({ ok: r.body.ok, accepted: r.body.accepted, counts: r.body.counts },
    { ok: true, accepted: 2, counts: { ok: 1, restricted: 1, unknown: 1 } });
  const stored = JSON.parse(env.KV.store.get(ECH_STATUS_KEY));
  assert.equal(stored.runId, '987');
  assert.equal(stored.ips['172.67.145.96'].s, 'ok');

  const all = await call(env, '/api/ips?limit=10');
  assert.equal(all.status, 200);
  const flags = Object.fromEntries(all.body.ips.map(x => [x.ip, x.ech]));
  assert.deepEqual(flags, { '104.16.0.195': true, '162.159.136.89': false, '172.67.145.96': null, '2606:4700::1': null });
  assert.equal(all.body.echUpdatedAt, stored.updatedAt);

  const echOnly = await call(env, '/api/ips?limit=10&ech=1');
  assert.deepEqual(echOnly.body.ips.map(x => x.ip), ['104.16.0.195', '172.67.145.96', '2606:4700::1']);
  assert.equal(echOnly.body.returned, 3);
  // ech=1 applies before limit, so limit still returns usable rows
  const top2 = await call(env, '/api/ips?limit=2&ech=1');
  assert.deepEqual(top2.body.ips.map(x => x.ip), ['104.16.0.195', '172.67.145.96']);
});

test('/api/ips keeps working with ech=null when the ech KV read fails', async () => {
  const env = makeEnv();
  env.KV.failGet.add(ECH_STATUS_KEY);
  const r = await call(env, '/api/ips?ech=1&limit=10');
  assert.equal(r.status, 200);
  assert.equal(r.body.ips.length, 4);
  assert.ok(r.body.ips.every(x => x.ech === null));
  assert.equal(r.body.echUpdatedAt, null);
});

/** 生成 n 个 IPv4 行的大池子（超过公共上限 200）。 */
function bigPool(n) {
  const ips = [];
  for (let i = 0; i < n; i++) ips.push({ ip: `104.16.${Math.floor(i / 250)}.${(i % 250) + 1}`, port: 443, family: 'v4', _score: 1000 - i });
  return { updatedAt: Date.now(), ips };
}

test('/api/ips lifts the 200-row cap only for a valid ECH_REPORT_TOKEN', async () => {
  const env = makeEnv({ ECH_REPORT_TOKEN: 'ech-secret', ADMIN_TOKEN: 'admin-secret', API_IPS_RATE_LIMIT: '0' }, { 'ips:latest': bigPool(2300) });
  const auth = t => ({ headers: { authorization: `Bearer ${t}` } });

  const pub = await call(env, '/api/ips?limit=2000');
  assert.equal(pub.status, 200);
  assert.equal(pub.body.returned, 200);
  assert.equal(pub.body.total, 2300);

  // 错误 token / 其它 token / query token 一律按公共请求处理（200 行），不返回 401
  for (const t of ['ech-secre', 'ech-secret2', 'admin-secret']) {
    const r = await call(env, '/api/ips?limit=2000', auth(t));
    assert.equal(r.status, 200, t);
    assert.equal(r.body.returned, 200, t);
  }
  assert.equal((await call(env, '/api/ips?limit=2000&token=ech-secret')).body.returned, 200);

  const full = await call(env, '/api/ips?limit=2000&perCountry=0', auth('ech-secret'));
  assert.equal(full.status, 200);
  assert.equal(full.body.returned, 2000);
  assert.equal(new Set(full.body.ips.map(x => x.ip)).size, 2000);
  const over = await call(env, '/api/ips?limit=5000', auth('ech-secret'));
  assert.equal(over.body.returned, 2000);
  // 默认 limit 不变
  assert.equal((await call(env, '/api/ips', auth('ech-secret'))).body.returned, 20);
});

test('ECH_REPORT_TOKEN never lifts the cap when the secret is not configured', async () => {
  const env = makeEnv({ API_IPS_RATE_LIMIT: '0' }, { 'ips:latest': bigPool(300) });
  const r = await call(env, '/api/ips?limit=2000', { headers: { authorization: 'Bearer ' } });
  assert.equal(r.body.returned, 200);
  const r2 = await call(env, '/api/ips?limit=2000', { headers: { authorization: 'Bearer undefined' } });
  assert.equal(r2.body.returned, 200);
});

test('/sub stays capped at 200 even with ECH_REPORT_TOKEN', async () => {
  const env = makeEnv({ ECH_REPORT_TOKEN: 'ech-secret', SUB_RATE_LIMIT: '0' }, { 'ips:latest': bigPool(300) });
  const res = await worker.fetch(new Request(HOST + '/sub?limit=2000', { headers: { authorization: 'Bearer ech-secret' } }), env, { waitUntil() {} });
  assert.equal(res.status, 200);
  assert.equal((await res.text()).split('\n').length, 200);
});

test('API_IPS_REQUIRE_TOKEN accepts ECH_REPORT_TOKEN for /api/ips and still rejects wrong tokens', async () => {
  const env = makeEnv({ ECH_REPORT_TOKEN: 'ech-secret', API_IPS_REQUIRE_TOKEN: '1', API_IPS_RATE_LIMIT: '0' });
  assert.equal((await call(env, '/api/ips')).status, 401);
  assert.equal((await call(env, '/api/ips', { headers: { authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await call(env, '/api/ips', { headers: { authorization: 'Bearer ech-secret' } })).status, 200);
});

test('public /api/ips rate limit is unchanged and the ECH token does not bypass it', async () => {
  const env = makeEnv({ ECH_REPORT_TOKEN: 'ech-secret', API_IPS_RATE_LIMIT: '2' });
  const h = { headers: { 'cf-connecting-ip': '203.0.113.9' } };
  assert.equal((await call(env, '/api/ips', h)).status, 200);
  assert.equal((await call(env, '/api/ips', h)).status, 200);
  assert.equal((await call(env, '/api/ips', h)).status, 429);
  const t = { headers: { 'cf-connecting-ip': '203.0.113.9', authorization: 'Bearer ech-secret' } };
  assert.equal((await call(env, '/api/ips', t)).status, 429);
});

test('mergeEchStatus caps the stored entry count and drops the oldest first', () => {
  const now = Date.now();
  const prevIps = {};
  for (let i = 0; i < 5; i++) prevIps[`10.0.0.${i + 1}`] = { s: 'ok', t: now - (i + 1) * HOUR };
  const r = mergeEchStatus({ ips: prevIps }, report([{ ip: '10.0.1.1', status: 'restricted' }, { ip: '10.0.1.2', status: 'ok' }]), now, undefined, 4);
  assert.deepEqual(Object.keys(r.next.ips).sort(), ['10.0.0.1', '10.0.0.2', '10.0.1.1', '10.0.1.2']);
  assert.equal(r.pruned, 3);
  assert.equal(r.accepted, 2);
  assert.ok(ECH_MAX_STORED >= 2 * ECH_MAX_RESULTS);
});
