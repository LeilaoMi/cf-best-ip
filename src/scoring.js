export function carrierKey(x) {
  return x?.carrier === "CMCC" ? "CM" : (x?.carrier || "CF");
}

export function countByCarrier(ips) {
  const out = { CT: 0, CU: 0, CM: 0, CF: 0 };
  for (const x of ips || []) {
    const k = carrierKey(x);
    out[out[k] == null ? "CF" : k]++;
  }
  return out;
}

export function scoreIp(item, previousMap) {
  const prev = previousMap.get(`${item.ip}:${carrierKey(item)}`) || previousMap.get(`${item.ip}:CF`);
  let score = 0;
  if (prev) score += 40;
  if (item.tested) score += 30;
  score += Math.min((item.sources?.length || 0) * 6, 30);
  if (item.delay != null) score += Math.max(0, 30 - item.delay / 10);
  if (item.loss != null) score += Math.max(0, 20 - item.loss * 100);
  if (item.mbps != null) score += Math.min(item.mbps, 30) / 2;
  return Math.round(score * 10) / 10;
}

export function applyStabilityScores(ips, previous) {
  const previousMap = new Map();
  for (const x of previous?.ips || []) previousMap.set(`${x.ip}:${carrierKey(x)}`, x);
  return ips.map(x => ({ ...x, _score: scoreIp(x, previousMap) })).sort((a, b) => {
    if ((b._score || 0) !== (a._score || 0)) return (b._score || 0) - (a._score || 0);
    if (a.tested && b.tested) return (a.delay || 9999) - (b.delay || 9999);
    if (a.tested) return -1;
    if (b.tested) return 1;
    return (b.sources?.length || 0) - (a.sources?.length || 0);
  });
}

export function testedCount(ips) {
  return (ips || []).filter(x => x.tested || x.quality?.testedBy === "hostmonit").length;
}

export function criticalSourceFailed(sourceStats = []) {
  return sourceStats.some(x => x.critical && (x.error || !x.count));
}

export function qualityGuard(alive, previous, sourceStats = [], carrierName = c => c || "通用") {
  const prevIps = previous?.ips || [];
  if (prevIps.length < 50) return null;
  if (alive.length < Math.floor(prevIps.length * 0.6)) {
    return { error: "pool-shrank", message: `本次可用池 ${alive.length} 个，低于上一批 ${prevIps.length} 个的 60%，已保留上一批结果。` };
  }
  const prevTested = testedCount(prevIps);
  const nextTested = testedCount(alive);
  const criticalFailed = criticalSourceFailed(sourceStats);

  // hostmonit/critical speed-test sources can temporarily fail from Workers egress.
  // Do not block a refresh if the overall pool is still healthy enough; otherwise
  // KV becomes stale and /health stays degraded forever.
  if (!criticalFailed && prevTested >= 10 && nextTested < Math.floor(prevTested * 0.5)) {
    return { error: "tested-pool-shrank", message: `真实测速 IP 从 ${prevTested} 个降到 ${nextTested} 个，已保留上一批结果。` };
  }
  if (criticalFailed) {
    const prevBy = countByCarrier(prevIps);
    const nextBy = countByCarrier(alive);
    for (const k of ["CT", "CU", "CM"]) {
      if (prevBy[k] >= 10 && nextBy[k] < Math.floor(prevBy[k] * 0.4)) {
        return { error: "critical-source-degraded", message: `核心测速源异常且${carrierName(k)}池严重减少，已保留上一批结果。` };
      }
    }
  }
  const prevBy = countByCarrier(prevIps);
  const nextBy = countByCarrier(alive);
  for (const k of ["CT", "CU", "CM"]) {
    if (prevBy[k] >= 10 && nextBy[k] < Math.floor(prevBy[k] * 0.4)) {
      return { error: "carrier-pool-shrank", message: `${carrierName(k)}池从 ${prevBy[k]} 个降到 ${nextBy[k]} 个，已保留上一批结果。` };
    }
  }
  return null;
}

export function sourceHealth(sourceStats = []) {
  const total = sourceStats.length;
  const failed = sourceStats.filter(x => x.error).length;
  const empty = sourceStats.filter(x => !x.error && !x.count).length;
  const critical = sourceStats.filter(x => x.critical).length;
  const criticalFailed = sourceStats.filter(x => x.critical && (x.error || !x.count)).length;
  const independentSignals = new Set(sourceStats.map(x => x.signal || x.name)).size;
  return { total, ok: Math.max(0, total - failed), failed, empty, critical, criticalFailed, criticalSourcesOk: criticalFailed === 0, independentSignals };
}
