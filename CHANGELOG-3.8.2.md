# CHANGELOG 3.8.2

## 页面主题切换

- 首页新增主题切换：跟随系统、深海、浅色、极光、琥珀。
- 主题选择保存在浏览器本地 `localStorage`，不影响 Worker KV、DNS 或接口行为。
- README 和 verify 同步主题切换检查。

## 验证

```bash
node -c src/cidr.js
node -c src/scoring.js
node -c src/dns.js
node -c src/worker.js
node --test
node scripts/verify-worker.mjs
git diff --check
```
