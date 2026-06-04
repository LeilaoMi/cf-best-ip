# cf-best-ip 安全增强包 2 续接记录（2026-06-05）

## 任务目标
制定计划并开始推进下一轮安全增强，优先完成：
1. `ROOT_DOMAIN` 显式域名保护。
2. `ALLOWED_HOSTS` Host 白名单。
3. `/api/dns/current` 管理鉴权。

## 项目路径
`/home/workspace/Projects/cf-best-ip`

## 起始状态
- 起始提交：`c08a2ac ui: add homepage theme switcher`
- 工作区起始状态：干净。
- 本轮不部署 Cloudflare、不触发刷新、不改 DNS。

## 已完成
- 新增计划文档：`docs/roadmap-2026-06-05-security-next.md`
- `src/worker.js`
  - 版本升级为 `3.8.3`。
  - 新增 `normalizeHostname()`、`getRootDomain()`、`isHostnameUnderRoot()`、`assertManagedDnsNamesAllowed()`。
  - `ROOT_DOMAIN` 可选显式限制 DNS 同步根域；所有 managed DNS name 必须在根域下，否则同步/查询会失败。
  - 新增 `allowedHosts()`、`isAllowedHost()`、`requireAllowedHost()`。
  - `ALLOWED_HOSTS` 可选限制页面/API 入口 host；`/health` 仍放行。
  - `/api/dns/current` 增加 `ADMIN_TOKEN` 鉴权。
- `wrangler.toml`
  - 新增 `ROOT_DOMAIN = "leilaomi.cc.cd"`。
  - 新增 `ALLOWED_HOSTS = "bestip.leilaomi.cc.cd"`。
- `README.md`
  - 增加 `ROOT_DOMAIN`、`ALLOWED_HOSTS` 说明。
  - `/api/dns/current` 标注需要 `ADMIN_TOKEN`。
  - 增加域名边界保护说明。
- `scripts/verify-worker.mjs`
  - 增加 root domain guard、allowed hosts guard、dns current admin auth 检查。
- 新增 `CHANGELOG-3.8.3.md`。

## 验证结果
已通过：

```bash
node -c src/cidr.js
node -c src/scoring.js
node -c src/dns.js
node -c src/worker.js
node --test                  # 13 passed
node scripts/verify-worker.mjs
node /home/.z/workspaces/con_ZSlQnjmz5wHG9bmK/test_security_batch2.mjs
git diff --check
```

行为测试覆盖：
- `ALLOWED_HOSTS` 会阻止非白名单 host。
- `/health` 不受 host 白名单影响。
- `/api/dns/current` 未带 admin token 返回 401。
- `/api/dns/current` 带 admin token 可访问。
- `ROOT_DOMAIN` 与 `CF_RECORD_NAME` 不匹配时会拦截。

> 验证期间 stderr 出现 `managed DNS name outside ROOT_DOMAIN example.com: cf.other.com`，这是行为测试故意触发越界域名保护，不是失败；命令最终退出码为 0。

## 外部操作状态
- 未部署 Cloudflare。
- 未触发刷新。
- 未改线上 DNS。

## 下一步建议
下一批可推进：
1. CSP nonce 化（较大 UI/HTML 改动）。
2. Durable Object 强锁（需要 Cloudflare 资源绑定，需单独确认）。
3. IPv6 AAAA 可选同步（DNS 行为变更，必须默认关闭并单独部署验证）。
4. 公开 `/api/ips` 限制/鉴权（兼容性变更，需确认策略）。
