export function buildWantedIps(ips, topN) {
  const wanted = [];
  const seen = new Set();
  for (const x of ips || []) {
    if (!x?.ip || seen.has(x.ip)) continue;
    seen.add(x.ip);
    wanted.push(x.ip);
    if (wanted.length >= topN) break;
  }
  return wanted;
}

export function planDnsRecordSync(name, ips, topN, existing, maxChangeRatio = 0.3, type = "A") {
  if (!ips?.length) return { skipped: true, name, type };
  const current = Array.isArray(existing) ? existing : [];
  const ratio = Math.min(Math.max(Number(maxChangeRatio || 0.3), 0.05), 1);
  const maxChanges = current.length ? Math.max(1, Math.floor(topN * ratio)) : topN;
  const candidatePool = buildWantedIps(ips, Math.max(topN * 3, topN));
  const candidateSet = new Set(candidatePool);
  const existingContents = current.map(r => r.content);
  const existingSet = new Set(existingContents);
  const final = [];
  const addFinal = (ip) => { if (ip && !final.includes(ip) && final.length < topN) final.push(ip); };

  for (const ip of existingContents) if (candidateSet.has(ip)) addFinal(ip);

  let addedNew = 0;
  for (const ip of candidatePool) {
    if (final.length >= topN) break;
    if (existingSet.has(ip)) continue;
    if (addedNew >= maxChanges && current.length) break;
    addFinal(ip);
    addedNew++;
  }

  if (final.length < topN) {
    for (const ip of existingContents) { addFinal(ip); if (final.length >= topN) break; }
  }
  if (final.length < topN) {
    for (const ip of candidatePool) { addFinal(ip); if (final.length >= topN) break; }
  }

  const wanted = final.slice(0, topN);
  const wantedSet = new Set(wanted);
  const existingMap = new Map(current.map(r => [r.content, r.id]));
  const deletes = [];
  for (const r of current) if (!wantedSet.has(r.content)) deletes.push(r.id);
  const posts = [];
  for (const ip of wanted) {
    if (!existingMap.has(ip)) posts.push({ type, name, content: ip, ttl: 60, proxied: false });
  }
  return { name, type, ips: wanted, deletes, posts, kept: current.length - deletes.length, added: posts.length, removed: deletes.length, maxChanges };
}
