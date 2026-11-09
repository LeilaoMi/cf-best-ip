// 每 IP 每分钟限流计数（KV 实现）。
//
// Workers KV 对同一个 key 每秒只允许写一次，超出时 put() 直接抛错。旧实现每个请求都
// put 同一个 `rate:<prefix>:<minute>:<ip>`，同一 IP 连续请求时 put 抛错 → 整个请求 500。
//
// 取舍（fail-open + 降级）：
// - 限流只是防刷，不是鉴权。KV 读/写失败时放行请求，绝不因为计数失败返回 500。
// - 同一 isolate 内用内存计数合并写入：同一个 key 至少间隔 WRITE_INTERVAL_MS 才写一次 KV，
//   远离「同 key 每秒 1 次」的上限，也省免费版每天 1000 次的写入额度。
// - 计数取 max(KV 值, 本 isolate 内存值) + 1。KV 读取失败时只用内存值，仍能在单个 isolate
//   内限流（降级而不是完全放开）。
// - 代价：计数是近似值。跳过的写入要等下一次写入时才落到 KV，不同 isolate / 机房之间可能
//   少算几次；KV 本身最终一致（最长约 60 秒），旧实现同样是近似限流。

/** 同一个 key 两次 KV 写入的最小间隔（KV 限制同 key 每秒 1 次写）。 */
export const WRITE_INTERVAL_MS = 1000;
/** 每个 isolate 内存里最多保留的计数 key 数，超出时淘汰最早的。 */
export const MAX_LOCAL_KEYS = 5000;

/**
 * 新建一份 isolate 内的计数状态（Map: key → {count, writtenAt}）。
 * @returns {Map<string, {count: number, writtenAt: number}>}
 */
export function createRateLimitState() {
  return new Map();
}

/**
 * 计一次请求并判断是否超限；任何 KV 异常都不会抛出。
 * @param {object} opts
 * @param {{get: Function, put: Function}} opts.kv KV namespace
 * @param {string} opts.key 计数 key（已含时间窗口与 IP）
 * @param {number} opts.limit 窗口内允许的次数
 * @param {Map} opts.state createRateLimitState() 的结果
 * @param {boolean} [opts.exempt=false] 豁免（持 token 的调用方）：照常计数但不拦截
 * @param {number} [opts.now=Date.now()] 当前毫秒时间
 * @param {number} [opts.ttl=120] KV expirationTtl（秒）
 * @returns {Promise<{limited: boolean, count: number, wrote: boolean, degraded: string | null}>}
 */
export async function hitRateLimit({ kv, key, limit, state, exempt = false, now = Date.now(), ttl = 120 }) {
  let degraded = null;
  let stored = 0;
  try {
    stored = Number(await kv.get(key)) || 0;
  } catch {
    degraded = "kv-get-failed";
  }
  let entry = state.get(key);
  if (!entry) {
    while (state.size >= MAX_LOCAL_KEYS) state.delete(state.keys().next().value);
    entry = { count: 0, writtenAt: 0 };
    state.set(key, entry);
  }
  // 同步更新内存计数，同一 isolate 内并发的请求能看到彼此
  const count = Math.max(stored, entry.count) + 1;
  entry.count = count;
  if (count > limit && !exempt) return { limited: true, count, wrote: false, degraded };

  let wrote = false;
  if (now - entry.writtenAt >= WRITE_INTERVAL_MS) {
    // 先占位再 await，避免并发请求在同一秒内重复写同一个 key
    entry.writtenAt = now;
    try {
      await kv.put(key, String(count), { expirationTtl: ttl });
      wrote = true;
    } catch {
      degraded = degraded ? `${degraded},kv-put-failed` : "kv-put-failed";
    }
  }
  return { limited: false, count, wrote, degraded };
}
