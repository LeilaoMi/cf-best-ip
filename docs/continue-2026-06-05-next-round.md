# cf-best-ip 下一轮推进记录（2026-06-05）

## 任务目标
用户要求“开始下一轮”。本轮在 v3.8.0 已部署且线上健康的基础上，先做状态复检，再推进低风险本地增强：完善 README 文档、增加 verify 文档漂移检查、补充 DNS only UI 标识。

## 项目路径
`/home/workspace/Projects/cf-best-ip`

## 当前分支 / commit
- 分支：`main`
- 起始 commit：`3be4666`

## 线上复检结果
- `/health`：`ok=true`，`status=ok`，`reasons=[]`，`total=331`，`dnsOk=true`，`criticalSourcesOk=true`
- `/api/stats`：`version=3.8.0`，`publicRefreshEnabled=false`，`qualityStats.tested=15`，`qualityStats.sourceOnly=316`
- GitHub Actions 最近 5 次：均为 `completed success`

## 已完成改动
- `README.md`
  - API 列表补充 `/?plain=1` 和 `/sub?format=plain/csv/jsonl`
  - 新增常用查询参数表：`carrier/country/colo/family/port/maxDelay/minMbps/exclude/smart/perCountry/perCountryN/top/limit/format/comment`
  - `CF_API_TOKEN` 文档改为目标 Zone 最小权限：只给 DNS Edit
  - 运维建议补充：`robots.txt` 不是访问控制，敏感接口必须 Bearer 鉴权
  - 运维建议补充：只同步托管白名单 DNS only A 记录
- `scripts/verify-worker.mjs`
  - 新增 README 漂移检查：API 参数表、订阅格式、CF token 最小权限、robots 非访问控制、DNS only 记录
- `src/worker.js`
  - 首页 DNS 同步详情显示 `DNS only · 保留/新增/删除...`
  - admin DNS 同步详情显示 `DNS only · 保留/新增/删除...`

## 验证结果
已通过：

```bash
node -c src/cidr.js
node -c src/scoring.js
node -c src/dns.js
node -c src/worker.js
node --test              # 13 passed
node scripts/verify-worker.mjs
a node /home/.z/workspaces/con_ZSlQnjmz5wHG9bmK/test_stage5.mjs # stage5 behavior tests passed
git diff --check
```

> 注：上一段命令记录中 `a node ...` 是文档手误，实际执行的是 `node /home/.z/workspaces/con_ZSlQnjmz5wHG9bmK/test_stage5.mjs`。

## 外部操作状态
- 本轮不部署 Cloudflare
- 本轮不触发刷新
- 本轮不改 DNS
- 本轮仅准备提交并 push GitHub，让文档/verify 与代码保持同步

## 未完成/下一步候选
仍建议单独确认后再做：
- `ROOT_DOMAIN` 显式域名保护
- host 白名单
- `/api/dns/current` 是否改为管理鉴权
- CSP nonce 化
- refresh Durable Object 强锁
- admin 配置导入/导出
- IPv6 AAAA 可选同步
