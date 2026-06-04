# cf-best-ip 阶段四续接文档（2026-06-05）

## 任务目标
实施 `docs/roadmap-2026-06-04.md` 阶段 4（`v3.7.0`）：拆模块 + 真测试。

## 项目路径
`/home/workspace/Projects/cf-best-ip`

## 当前分支/commit
- 分支：`main`
- 起始 commit：`d9dc11c`
- 当前已有阶段一/二/三本地改动，未 commit、未 push、未部署。

## 阶段四计划
1. 先拆纯逻辑模块：`src/cidr.js`、`src/scoring.js`。
2. 新增 `test/cidr.test.js`、`test/scoring.test.js`。
3. 更新 `scripts/verify-worker.mjs`，加入模块和测试检查。
4. 尽量不先拆 DNS 大逻辑，避免阶段四一次改动过大；如果 CIDR/scoring 和测试稳定，再评估是否拆 `dns.js`。
5. 更新 README、CHANGELOG。

## 重要约束
- 不部署、不 push，除非用户后续确认。
- 拆模块阶段不改变业务策略。
- 每拆一个模块都跑验证。
- 不泄露任何 token/secret。

## 当前状态
未完成；阶段四刚开始。

## 阶段四最终状态
已完成本地实现与验证；未部署，未 push。

## 已修改/新增文件
- `src/worker.js`
  - 版本升级到 `3.7.0`。
  - 移除内联 CIDR 与 scoring 纯逻辑，改为从 `./cidr.js`、`./scoring.js` 导入。
  - 保留路由、抓源、DNS、渲染等主入口逻辑，避免一次性大拆造成风险。
- `src/cidr.js`
  - 新增 Cloudflare IPv4/IPv6 CIDR 判断纯逻辑。
  - 导出 `CF_IPV4_CIDRS`、`CF_IPV6_CIDRS`、`ipToInt()`、`ipv6ToBigInt()`、`isCfNativeIp()`、`isCfNativeIpV6()`。
- `src/scoring.js`
  - 新增评分/稳定性/健康判断纯逻辑。
  - 导出 `carrierKey()`、`countByCarrier()`、`scoreIp()`、`applyStabilityScores()`、`qualityGuard()`、`sourceHealth()`。
- `test/cidr.test.mjs`
  - 覆盖 IPv4 输入校验、CF IPv4 边界、CF IPv6 判断。
- `test/scoring.test.mjs`
  - 覆盖 carrier 归一化、稳定分排序、质量保护、核心源 degraded、独立信号统计。
- `.github/workflows/scheduled-test.yml`
  - 在 CI 中新增 `node --test`。
- `scripts/verify-worker.mjs`
  - 增加模块拆分、workflow 跑测试、`v3.7.0` 校验。
- `README.md`
  - 版本同步为 `3.7.0`，说明模块化 Worker 与 `node --test`。
- `CHANGELOG-3.7.0.md`
  - 新增阶段四变更说明。

## 验证结果

```bash
node -c src/cidr.js
node -c src/scoring.js
node -c src/worker.js
node --test
node scripts/verify-worker.mjs
git diff --check
```

结果：全部通过。

`node --test` 输出摘要：

```text
# tests 8
# pass 8
# fail 0
```

`node scripts/verify-worker.mjs` 输出摘要：

```text
ok: cidr module extracted
ok: scoring module extracted
ok: workflow runs node test
ok: version 3.7.0
```

## 遇到的问题与处理
- 第一次 `node --test` 中 `applyStabilityScores` 测试预期错误：原算法允许“实测低延迟”分数高于“上一批存在”，已修正测试为验证现有计算分数排序。
- diff 审查发现 `worker.js` 有两个拼接错误：`const DEFAULT_CFG = {const DEFAULT_CFG = {` 和重复 `function staleInfo...`；已修复，并重新跑完整验证。

## 重要决策
- 本阶段只拆 `cidr.js` 和 `scoring.js` 两个纯逻辑模块。
- DNS 模块暂不拆：DNS 涉及 Cloudflare API、KV、env、运行时副作用，适合下一阶段单独拆并用 mock fetch 测试，避免一次性大改。

## 后续建议
1. 下一步若继续阶段四加强版：拆 `dns.js` 并补 mock fetch 测试。
2. 如果要发布：先 commit，再 push，再经用户确认后部署。
3. 线上部署前建议先本地/CI 确认 ESM import 在 Wrangler Worker 环境正常打包。

## Git 状态
见当前 `git status --short`。本阶段未部署、未 push。
