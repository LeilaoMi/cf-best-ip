# v3.6.0 变更清单

## 已改（已验证、已部署）

| \# | 文件 | 改动 | 原因 | 验证 |
| --- | --- | --- | --- | --- |
| 1 |  | `enrichGeo` 从 `ip-api.com` HTTP → `ipwho.is` HTTPS（ip-api.com 作 fallback） | 明文传输可被篡改国家代码，导致 IP 被误过滤 | ✅ grep `https://ipwho.is` |
| 2 |  | 响应头加 `content-security-policy` | 原无 CSP，XSS 攻击面大 | ✅ grep CSP |
| 3 |  | `syncRecordFromExisting` 删除两行死代码 | 绕过了 `maxChanges` 限制，违反设计意图 | ✅ grep 已不存在 |
| 4 |  | `enrichGeo` 后不再丢弃无国家 IP（`alive = enriched`） | Geo API 失败时丢失有效候选 | ✅ grep L862 |
| 5 |  | `/api/stats` + `/api/diagnostics` + `/health` 用 `Promise.all` 并行读 KV | 多个串行 await 浪费 CPU 时间 | ✅ grep Promise.all |
| 6 |  | 客户端测速队列用 `Set` 去重（`clientTestEnqueued`） | `Array.includes` O(n) 重复检查 | ✅ grep Set |
| 7 |  | `/health` 增加 `sourceHealth` 并纳入 ok 判断 | 之前 source 全挂也不报不健康 | ✅ curl 验证 |
| 8 |  | DNS 同步写 `dns:history:${day}`（7 天 TTL） | 只存 lastSync，排障看不到历史 | ✅ grep dns:history |
| 9 |  | `/api/config` 管理接口（GET/POST，需 ADMIN_TOKEN） | 运行时只能改 KV，缺统一配置入口 | ✅ grep /api/config |
| 10 |  | `CMLiussss/cm` 源加 `aliasOf: "addressesapi/cmcc"` | 同一数据源无别名标记，统计可能重复计数 | ✅ grep aliasOf |
| 11 |  | 首页加 `prefers-color-scheme: light` CSS 变量 | 深色主题在强光下可读性差 | ✅ grep prefers |
| 12 |  | 管理登录改用 `fetch('/admin', { Authorization })` 替代 URL token | `/admin?token=xxx` 泄露到浏览器历史/剪贴板 | ✅ grep fetch('/admin') |
| 13 |  | 首页倒计时修正为 15 分钟偏移 | 与新 cron 对齐 | ✅ |
| 14 |  | 版本号 `3.5.2` → `3.6.0` | — | ✅ |
| 15 |  | cron `0 */6 * * *` → `15 */6 * * *` | 避开 hostmonit 整点更新，拿到最新数据 | ✅ |
| 16 |  | 新增 Source Health Gate step | source 大面积失败时 CI 能发现 | ✅ |
| 17 |  | 新增 `/api/config` 接口说明 + 验证脚本说明 | — | ✅ |
| 18 |  | 新增文本检查脚本（5 项） | 持续验证关键改动不被覆盖 | ✅ 全部 ok |

## 仍建议后续做（未动）

| \# | 建议 | 原因 |
| --- | --- | --- |
| A | 拆分单文件为模块（sources/dns/scoring/templates） | 单文件 Worker 部署简单，暂无痛点 |
| B | 首页深色 hero gradient 在浅色模式下仍为黑色 | 需要更多 CSS 变量化，风险较高 |
| C | 每日一次刷新测试覆盖 | GitHub Actions 可做，但需要 token |
| D | IPv6 支持 | 15 个 CIDR 全是 v4，项目本身限制 |

## 线上状态

```markdown
https://bestip.leilaomi.cc.cd/health
ok: true  total: 298  stale: false  dnsOk: true  sourceHealth: 17/18 ok
```