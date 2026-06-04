# cf-best-ip 安全增强包 3 续接记录（2026-06-05）

## 任务目标
用户要求“下一批推进全做 / Continue”。本轮推进剩余高价值增强项：

1. CSP nonce 化。
2. Refresh Durable Object 强锁。
3. IPv6 AAAA 可选同步，默认关闭。
4. `/api/ips` 轻量访问保护和可选 Bearer 鉴权。

## 项目路径
`/home/workspace/Projects/cf-best-ip`

## 当前状态
已完成本地代码实现、文档同步、验证与 dry-run；未部署 Cloudflare，未触发线上 refresh，未改线上 DNS。

## 已修改文件
- `src/worker.js`
  - 版本升级为 `3.9.0`。
  - `html()` 自动生成 nonce，HTML 页面 `<script>` 带 nonce。
  - CSP 改为 `script-src 'nonce-...'`，并增加 `base-uri 'self'`、`frame-ancestors 'none'`、`form-action 'self'`。
  - 新增 `RefreshLock` Durable Object 类。
  - `/api/refresh` 优先使用 `env.REFRESH_LOCK`，不可用时回退 KV `refresh:running`。
  - `/api/ips` 增加 `requireApiIpsAccess()`：默认每 IP 每分钟限额，支持 `API_IPS_REQUIRE_TOKEN=1` 强制 token。
  - DNS 查询/同步支持 `A` / `AAAA` 类型；`CF_DNS_IPV6=1` 时额外同步 `auto.` / `cf.` 的 AAAA。
- `src/dns.js`
  - `planDnsRecordSync()` 增加 `type` 参数，输出 A/AAAA 记录。
- `wrangler.toml`
  - 新增 `CF_DNS_IPV6 = "0"`。
  - 新增 `API_IPS_RATE_LIMIT = "60"`。
  - 新增 Durable Object binding `REFRESH_LOCK` 和 migration `v1-refresh-lock`。
- `test/dns.test.mjs`
  - 新增 AAAA 计划测试。
  - 更新 empty candidate 期望包含 `type: "A"`。
- `scripts/verify-worker.mjs`
  - 新增 CSP nonce、API guard、AAAA、Durable Object 锁校验。
  - 版本校验更新到 3.9.0。
- `README.md`
  - 更新 version badge 到 3.9.0。
  - 增加 `CF_DNS_IPV6`、`API_IPS_RATE_LIMIT`、`API_IPS_REQUIRE_TOKEN` 说明。
  - 更新 CSP、refresh lock、AAAA、`/api/ips` 保护说明。
- `CHANGELOG-3.9.0.md`
  - 新增本批改动记录。

## 验证结果
已通过：

```bash
node -c src/cidr.js
node -c src/scoring.js
node -c src/dns.js
node -c src/worker.js
node --test              # 14 passed
node scripts/verify-worker.mjs
git diff --check
npx wrangler deploy --dry-run
```

Wrangler dry-run 关键结果：

```text
Total Upload: 123.90 KiB / gzip: 35.44 KiB
env.REFRESH_LOCK (RefreshLock) Durable Object
env.CF_DNS_IPV6 ("0")
env.API_IPS_RATE_LIMIT ("60")
--dry-run: exiting now.
```

## 外部操作状态
- 未部署 Cloudflare。
- 未触发 `/api/refresh`。
- 未改线上 DNS。
- 准备提交并 push GitHub。

## 下一步
如果用户确认部署，应先执行：

```bash
cd /home/workspace/Projects/cf-best-ip
npx wrangler deploy --config wrangler.toml
curl -fsS --max-time 20 https://bestip.leilaomi.cc.cd/health | jq .
curl -fsS --max-time 20 https://bestip.leilaomi.cc.cd/api/stats | jq '{ok,version,total,publicRefreshEnabled,lastDnsSync}'
```

部署后重点验证：
- 页面可打开。
- CSP 不阻断主题切换/复制按钮/手动刷新按钮。
- `/api/ips` 正常返回，超过限额才 429。
- `/api/dns/current` 仍需要 admin token。
- `CF_DNS_IPV6` 默认为 `0`，不会主动写 AAAA。
