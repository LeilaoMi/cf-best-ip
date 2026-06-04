# CHANGELOG 3.6.2

## 数据可信度和健康状态

- 每条 IP 增加 `quality.testedBy/confidence`：区分 `hostmonit` 来源实测和普通来源推荐。
- 首页表格增加“测速来源”列，并说明 `ms*` 是浏览器临时连接耗时，不等于业务可用保证。
- `/api/ips` 增加 `qualityNote`，避免把来源推荐误解为 Worker 实测。
- `sourceStats` 增加 `critical/aliasOf/signal`，`sourceHealth` 增加 `criticalSourcesOk/independentSignals`。
- `hostmonit/三网实测` 标记为核心源；核心源异常时 `/health` 返回 `critical-source-failed` 并进入 degraded。
- `qualityGuard` 增加真实测速池缩水保护；核心源异常且线路池减少时保留上一批结果。
- 地理补全后再次执行 `countryBlocklist`，避免来源未带国家的 IP 在补全后漏过黑名单。
- 地理补全结果标记 `geoSource/geoTrusted`，HTTP fallback 结果仅标记为非可信来源。

## 验证

```bash
node -c src/worker.js
node scripts/verify-worker.mjs
node /home/.z/workspaces/con_ZSlQnjmz5wHG9bmK/test_stage2.mjs
git diff --check
```
