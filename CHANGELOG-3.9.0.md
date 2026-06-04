# CHANGELOG 3.9.0

## 安全与兼容增强

- HTML 页面脚本改为 CSP nonce，移除 `script-src 'unsafe-inline'`，保留 inline style 以避免大规模模板拆分。
- `/api/refresh` 增加 Durable Object 刷新锁 `REFRESH_LOCK`，不可用时仍回退到 KV `refresh:running`。
- 新增 `CF_DNS_IPV6=1` 可选 AAAA 同步；默认关闭，避免客户端兼容性突变。
- `/api/ips` 增加轻量访问保护：默认每 IP 每分钟 `API_IPS_RATE_LIMIT=60`，可设置 `API_IPS_REQUIRE_TOKEN=1` 强制 Bearer token。
- DNS diff 计划支持 A/AAAA 类型，并补充 AAAA 单元测试。
- README、Wrangler 配置和 verify 脚本同步到 3.9.0。

## 验证

```bash
node -c src/cidr.js
node -c src/scoring.js
node -c src/dns.js
node -c src/worker.js
node --test
node scripts/verify-worker.mjs
git diff --check
npx wrangler deploy --dry-run
```

本版本只提交代码，不自动部署 Cloudflare。
