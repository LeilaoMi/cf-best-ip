# cf-best-ip v3.8.0 部署续接记录

> 记录时间：2026-06-05（Asia/Shanghai）  
> 项目路径：`/home/workspace/Projects/cf-best-ip`  
> 目标：将阶段一至阶段五改进后的 `cf-best-ip` 发布到 Cloudflare 同名 Worker，并同步 GitHub。

## 当前状态

已完成。

- 本地分支：`main`
- GitHub 仓库：`LeilaoMi/cf-best-ip`
- 代码发布提交：`f065d11` (`release: harden cf-best-ip for v3.8.0`)
- Cloudflare Worker：`cf-best-ip`
- Cloudflare Version ID：`d4281f50-d99c-417c-aaa5-898b8ae90e0e`
- 自定义域名：`bestip.leilaomi.cc.cd`
- Cron：`15 */6 * * *`

## 密钥与安全说明

- 本机环境变量检查结果：`CLOUDFLARE_API_TOKEN=present`，`CF_API_TOKEN=missing`。
- 已使用 `CLOUDFLARE_API_TOKEN` 执行 Wrangler 部署认证。
- 已将同一个 token 写入 Worker 运行时 secret 名称：`CF_API_TOKEN`。
- 本文档没有记录任何 token 值、cookie 或完整凭证。

## 部署前验证

执行并通过：

```bash
node -c src/cidr.js
node -c src/scoring.js
node -c src/dns.js
node -c src/worker.js
node --test
node scripts/verify-worker.mjs
git diff --check
```

关键结果：

```text
13 tests passed
0 failed
ok: version 3.8.0
```

## GitHub 同步

已提交并推送：

```text
[f065d11] release: harden cf-best-ip for v3.8.0
23 files changed, 2808 insertions(+), 266 deletions(-)
d9dc11c..f065d11 main -> main
```

## Cloudflare 部署

已执行：

```bash
printf '%s' "$CLOUDFLARE_API_TOKEN" | npx wrangler@latest secret put CF_API_TOKEN --config wrangler.toml
npx wrangler@latest deploy --config wrangler.toml
```

关键输出：

```text
✨ Success! Uploaded secret CF_API_TOKEN
Worker Startup Time: 1 ms
Uploaded cf-best-ip
Current Version ID: d4281f50-d99c-417c-aaa5-898b8ae90e0e
```

## 线上验证

### `/health`

```bash
curl -fsS --max-time 20 https://bestip.leilaomi.cc.cd/health | jq .
```

关键结果：

```json
{
  "ok": true,
  "status": "ok",
  "reasons": [],
  "total": 331,
  "stale": false,
  "dnsOk": true,
  "sourceHealth": {
    "ok": 18,
    "total": 19,
    "failed": 1,
    "criticalSourcesOk": true,
    "independentSignals": 19
  },
  "lastErrorAt": null
}
```

### `/api/stats`

```bash
curl -fsS --max-time 20 https://bestip.leilaomi.cc.cd/api/stats | jq '{ok,version,total,publicRefreshEnabled,sourceHealth,qualityStats,lastDnsSync: (.lastDnsSync|{ok,cfApiRequests,topN,finishedAt})}'
```

关键结果：

```json
{
  "ok": true,
  "version": "3.8.0",
  "total": 331,
  "publicRefreshEnabled": false,
  "sourceHealth": {
    "total": 19,
    "ok": 18,
    "failed": 1,
    "critical": 0,
    "criticalFailed": 0,
    "criticalSourcesOk": true,
    "independentSignals": 19
  },
  "qualityStats": {
    "tested": 15,
    "sourceOnly": 316
  },
  "lastDnsSync": {
    "ok": true,
    "cfApiRequests": null,
    "topN": 10
  }
}
```

### CSV 订阅

```bash
curl -fsS --max-time 20 'https://bestip.leilaomi.cc.cd/sub?format=csv&top=2' | head -5
```

返回 CSV 表头与数据，表头包含：

```text
ip,port,carrier,country,colo,delay,loss,mbps,score,testedBy,confidence
```

### 极简页

```bash
curl -fsS --max-time 20 'https://bestip.leilaomi.cc.cd/?plain=1' | head -5
```

返回正常 HTML，包含总数、更新时间、推荐域名与 IP 列表。

## 后续注意

- 当前 `lastDnsSync.cfApiRequests` 在线上返回 `null`，表示最近一次 DNS 同步记录仍可能是旧结构或该次统计未写入；不影响本次 `dnsOk=true`，后续 cron/手动刷新后可再观察。
- 不建议公开开启 `ALLOW_PUBLIC_REFRESH=1`；当前线上 `/api/stats` 显示 `publicRefreshEnabled=false`。
- 若新对话继续，先读取本文件，再运行：

```bash
cd /home/workspace/Projects/cf-best-ip
git status --short
curl -fsS --max-time 20 https://bestip.leilaomi.cc.cd/health | jq .
```
