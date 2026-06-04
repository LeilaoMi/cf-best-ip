# cf-best-ip 阶段三续接文档（2026-06-05）

## 任务目标
实施 `docs/roadmap-2026-06-04.md` 阶段 3（`v3.6.3`）：降低滥用和资源消耗。

## 项目路径
`/home/workspace/Projects/cf-best-ip`

## 当前分支/commit
- 分支：`main`
- 起始 commit：`d9dc11c`
- 当前已有阶段一、阶段二本地改动，未部署、未 push。

## 阶段三待实施事项
1. `/sub` 增加 `Cache-Control: public, max-age=300`，管理/API 保持 no-store。
2. 首页客户端测速只测前 10 个，移动端低并发，页面不可见时暂停。
3. `ALLOW_PUBLIC_REFRESH=1` 时首页和 `/api/stats` 标记高危警告。
4. DNS 同步优先按 managed name 查询，减少全 zone A 记录扫描。
5. Telegram 通知检查 `r.ok`，失败写入 KV。
6. `ip-api.com` HTTP fallback 标记为不可信，不参与国家黑名单/DNS 决策。
7. 更新 README、verify、CHANGELOG、行为测试。

## 重要约束
- 不部署、不 push，除非用户后续确认。
- 不做阶段四拆模块。
- 不泄露任何 token/secret。

## 当前状态
未完成；阶段三刚开始。

## 中途进度更新
- 已开始阶段三 Worker 改动，版本目标 `3.6.3`。
- 已添加订阅缓存头、DNS managed names 查询策略、Telegram 通知结果检查、公开刷新状态暴露、客户端测速限量/移动端低并发/页面不可见暂停。
- 已修正国家黑名单：`geoTrusted=false` 的 HTTP fallback 地理结果只用于展示，不参与拦截决策。
- 当前未完成：README、verify、CHANGELOG、阶段三行为测试、最终 diff 检查。

## 阶段三最终状态
已完成本地实现与验证；未部署，未 push。

## 已修改文件
- `src/worker.js`
  - 版本升级到 `3.6.3`。
  - 新增 `SUB_CACHE_HEADERS`，`/sub`、`/sub.txt`、`/api/ips.txt`、`/ips.txt` 返回 `Cache-Control: public, max-age=300`。
  - DNS 同步新增 `listManagedARecords()`：managed names ≤ 10 时逐域名查询，超过 10 才全 Zone 扫描；`dns:lastSync` 增加 `cfApiRequests`。
  - Telegram 通知检查 HTTP 状态和 Telegram JSON `ok`，失败写入 `notify:lastError`。
  - `/api/stats` 增加 `publicRefreshEnabled`。
  - 首页在 `ALLOW_PUBLIC_REFRESH=1` 时显示红色警告。
  - 客户端测速：移动端并发 2、桌面 6；每次只测当前 tab 前 10 个；页面隐藏时暂停。
  - `ipwho.is` 标记 `geoTrusted=true`；`ip-api.com` HTTP fallback 标记 `geoTrusted=false`；国家黑名单不使用不可信 HTTP geo 做拦截依据。
- `README.md`
  - 版本 badge 更新到 `3.6.3`。
  - 补充 `/sub` 缓存、DNS 查询降压、Telegram 失败记录、公开刷新风险、客户端测速限量、HTTP fallback 不可信说明。
- `scripts/verify-worker.mjs`
  - 增加阶段三检查：缓存头、DNS 请求数、通知错误、公开刷新警告、客户端测速防护、HTTP geo untrusted、版本。
- `CHANGELOG-3.6.3.md`
  - 新增阶段三变更说明。

## 验证结果
```text
stage3 behavior tests passed
node -c src/worker.js ✅
node scripts/verify-worker.mjs ✅
git diff --check ✅
```

`node scripts/verify-worker.mjs` 输出关键项：
```text
ok: sub cache headers
ok: dns managed query request count
ok: notify error persistence
ok: public refresh warning
ok: client test resource guard
ok: http geo untrusted display only
ok: version 3.6.3
```

## 当前 git 状态
```text
 M README.md
 M scripts/verify-worker.mjs
 M src/worker.js
?? CHANGELOG-3.6.1.md
?? CHANGELOG-3.6.2.md
?? CHANGELOG-3.6.3.md
?? docs/audit-2026-06-04.md
?? docs/continue-2026-06-05-stage1.md
?? docs/continue-2026-06-05-stage2.md
?? docs/continue-2026-06-05-stage3.md
?? docs/roadmap-2026-06-04.md
```

## 重要决策
- 不改变公开订阅格式，只加缓存头，避免客户端兼容风险。
- DNS 同步按 managed name 查询只在托管域名少时启用；超过 10 个仍保留全 Zone 扫描，避免请求数反而变多。
- `ip-api.com` HTTP fallback 保留用于展示补充，但不作为国家黑名单拦截依据，避免 HTTP 明文结果污染策略。

## 未完成事项
- 未 commit。
- 未 push。
- 未部署 Cloudflare。

## 安全注意事项
- 不记录任何真实 token、Cloudflare API key、Telegram token。
- 部署、DNS、线上 Worker 修改必须再次确认。
