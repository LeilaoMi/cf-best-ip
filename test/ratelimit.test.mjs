import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_LOCAL_KEYS, WRITE_INTERVAL_MS, createRateLimitState, hitRateLimit } from '../src/ratelimit.js';
import worker from '../src/worker.js';

/**
 * 模拟 Workers KV 的同 key 写入限制：同一个 key 在 1 秒内第二次 put 会抛错（KV 429）。
 * clock() 返回当前毫秒；failGet / failPut 强制读写失败。
 */
function strictKv(clock = () => Date.now(), init = {}) {
  const store = new Map(Object.entries(init).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  const lastPut = new Map();
  return {
    store,
    puts: 0,
    rejectedPuts: 0,
    failGet: false,
    failPut: false,
    async get(key, type) {
      if (this.failGet) throw new Error('KV GET failed: 503');
      const v = store.get(key);
      if (v == null) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) {
      const now = clock();
      if (this.failPut || (lastPut.has(key) && now - lastPut.get(key) < 1000)) {
        this.rejectedPuts++;
        throw new Error('KV PUT failed: 429 Too Many Requests');
      }
      lastPut.set(key, now);
      this.puts++;
      store.set(key, String(value));
    },
    async delete(key) { store.delete(key); },
  };
}

test('hitRateLimit coalesces same-key writes to at most one per second', async () => {
  let t = 1_000_000;
  const kv = strictKv(() => t);
  const state = createRateLimitState();
  const hit = () => hitRateLimit({ kv, key: 'rate:x:1:ip', limit: 100, state, now: t });
  for (let i = 1; i <= 10; i++) {
    const r = await hit();
    assert.equal(r.limited, false);
    assert.equal(r.count, i);
    assert.equal(r.degraded, null);
  }
  assert.equal(kv.puts, 1);
  assert.equal(kv.rejectedPuts, 0);
  t += WRITE_INTERVAL_MS;
  const r = await hit();
  assert.equal(r.count, 11);
  assert.equal(r.wrote, true);
  assert.equal(kv.store.get('rate:x:1:ip'), '11');
});

test('hitRateLimit still limits within one isolate and picks up counts from KV', async () => {
  const t = 2_000_000;
  const state = createRateLimitState();
  const kv = strictKv(() => t);
  const results = [];
  for (let i = 0; i < 5; i++) results.push((await hitRateLimit({ kv, key: 'k', limit: 3, state, now: t })).limited);
  assert.deepEqual(results, [false, false, false, true, true]);
  // exempt callers are counted but never limited
  assert.equal((await hitRateLimit({ kv, key: 'k', limit: 3, state, now: t, exempt: true })).limited, false);

  // another isolate (fresh state) sees the count written to KV
  const kv2 = strictKv(() => t, { k2: '7' });
  const r = await hitRateLimit({ kv: kv2, key: 'k2', limit: 8, state: createRateLimitState(), now: t });
  assert.equal(r.count, 8);
  assert.equal(r.limited, false);
  assert.equal((await hitRateLimit({ kv: kv2, key: 'k2', limit: 8, state: createRateLimitState(), now: t + 5000 })).limited, true);
});

test('hitRateLimit fails open on KV write errors and degrades to local counting on read errors', async () => {
  const t = 3_000_000;
  const kv = strictKv(() => t);
  kv.failPut = true;
  const state = createRateLimitState();
  const r = await hitRateLimit({ kv, key: 'p', limit: 5, state, now: t });
  assert.deepEqual({ limited: r.limited, wrote: r.wrote, degraded: r.degraded }, { limited: false, wrote: false, degraded: 'kv-put-failed' });

  kv.failPut = false;
  kv.failGet = true;
  const out = [];
  for (let i = 0; i < 6; i++) out.push(await hitRateLimit({ kv, key: 'g', limit: 3, state, now: t + i * WRITE_INTERVAL_MS }));
  assert.deepEqual(out.map(x => x.limited), [false, false, false, true, true, true]);
  assert.ok(out.every(x => x.degraded?.startsWith('kv-get-failed')));
});

test('hitRateLimit concurrent hits in one isolate count correctly and write once', async () => {
  const t = 4_000_000;
  const kv = strictKv(() => t);
  const state = createRateLimitState();
  const rs = await Promise.all(Array.from({ length: 8 }, () => hitRateLimit({ kv, key: 'c', limit: 5, state, now: t })));
  assert.deepEqual(rs.map(r => r.count).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(rs.filter(r => r.limited).length, 3);
  assert.equal(kv.puts, 1);
  assert.equal(kv.rejectedPuts, 0);
});

test('hitRateLimit bounds its in-memory state', async () => {
  const state = createRateLimitState();
  const kv = strictKv();
  for (let i = 0; i < MAX_LOCAL_KEYS + 10; i++) await hitRateLimit({ kv, key: `k${i}`, limit: 10, state, now: i });
  assert.equal(state.size, MAX_LOCAL_KEYS);
  assert.equal(state.has('k0'), false);
});

const POOL = {
  updatedAt: Date.now(),
  ips: [
    { ip: '104.16.0.195', port: 443, family: 'v4', _score: 90 },
    { ip: '162.159.136.89', port: 443, family: 'v4', _score: 80 },
  ],
};

/** 用「同 key 每秒一次写」的严格 KV 跑 worker.fetch。 */
async function fetchWith(env, path, ip) {
  const res = await worker.fetch(new Request('https://bestip.example.com' + path, { headers: { 'cf-connecting-ip': ip } }), env, { waitUntil() {} });
  await res.arrayBuffer();
  return res.status;
}

test('back-to-back /api/ips and /sub requests never 500 on KV same-key write limits', async () => {
  const env = { KV: strictKv(() => Date.now(), { 'ips:latest': POOL }), ALLOWED_HOSTS: 'bestip.example.com', API_IPS_RATE_LIMIT: '5', SUB_RATE_LIMIT: '120' };
  const statuses = [];
  for (let i = 0; i < 8; i++) statuses.push(await fetchWith(env, '/api/ips', '198.51.100.7'));
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429, 429]);
  const sub = await Promise.all(Array.from({ length: 10 }, () => fetchWith(env, '/sub', '198.51.100.8')));
  assert.ok(sub.every(s => s === 200), String(sub));
  assert.equal(env.KV.rejectedPuts, 0);
});

test('KV write outage does not turn rate-limited endpoints into 500s', async () => {
  const kv = strictKv(() => Date.now(), { 'ips:latest': POOL });
  kv.failPut = true;
  const env = { KV: kv, ALLOWED_HOSTS: 'bestip.example.com' };
  assert.equal(await fetchWith(env, '/api/ips', '198.51.100.9'), 200);
  assert.equal(await fetchWith(env, '/sub', '198.51.100.9'), 200);
});

test('rate limit variables keep their meaning ("0" disables)', async () => {
  const env = { KV: strictKv(() => Date.now(), { 'ips:latest': POOL }), ALLOWED_HOSTS: 'bestip.example.com', API_IPS_RATE_LIMIT: '0' };
  const statuses = [];
  for (let i = 0; i < 70; i++) statuses.push(await fetchWith(env, '/api/ips', '198.51.100.10'));
  assert.ok(statuses.every(s => s === 200));
  assert.equal([...env.KV.store.keys()].some(k => k.startsWith('rate:')), false);
});
