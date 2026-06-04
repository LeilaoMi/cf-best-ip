# CHANGELOG 3.6.3

## 降低滥用和资源消耗

- `/sub`、`/sub.txt`、`/api/ips.txt`、`/ips.txt` 增加 `Cache-Control: public, max-age=300`，降低重复抓取压力。
- 首页客户端测速改为只自动测试当前线路前 10 个；移动端并发降到 2，桌面端并发 4，页面隐藏时暂停队列。
- `ALLOW_PUBLIC_REFRESH=1` 会在首页展示红色警告，并在 `/api/stats` 返回 `publicRefreshEnabled: true`。
- DNS 同步新增 `listManagedARecords()`：托管域名较少时按 name 查询，域名较多时才全 Zone 扫描；同步摘要记录 `cfApiRequests`。
- Telegram 通知会检查 API 返回结果；失败写入 KV `notify:lastError`，`/api/stats` 可查看最近通知错误。
- `ip-api.com` HTTP fallback 明确标记 `geoTrusted=false`，仅用于展示，不参与国家黑名单拦截决策。

## 验证

```bash
node -c src/worker.js
node scripts/verify-worker.mjs
node /home/.z/workspaces/con_ZSlQnjmz5wHG9bmK/test_stage3.mjs
git diff --check
```
