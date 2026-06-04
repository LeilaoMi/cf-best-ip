# CHANGELOG 3.6.1

## 安全止血与防误操作

- `/api/config` POST 增加运行时配置校验：限制数字范围、布尔值格式、国家代码数组和 HTTPS URL。
- 开启可用性检测、风险检测等高风险配置时，必须提交 `confirm: "I_UNDERSTAND"`。
- `/api/config` GET 默认返回脱敏配置；`raw=1` 必须额外提供 `X-Config-Raw-Confirm: I_UNDERSTAND`。
- 管理接口只接受 `Authorization: Bearer <ADMIN_TOKEN>`，不再接受 URL `?token=`。
- 全局 500 响应不再暴露 stack，只返回 `internal-error` 和 `requestId`，详细错误进入日志。
- `/health` 增加 `status`、`reasons`、`lastErrorAt`，便于监控判断降级原因。

## 文档与验证

- README 修正 Dashboard Cron 为 `15 */6 * * *`。
- README 项目结构不再写死过时行数。
- README 补充 `/api/config` 鉴权、脱敏、raw 确认和配置写入校验说明。
- `scripts/verify-worker.mjs` 增加 README 漂移、配置校验、500 stack 隐藏、health 字段和版本一致性检查。

## 验证

```bash
node -c src/worker.js
node scripts/verify-worker.mjs
node /home/.z/workspaces/con_ZSlQnjmz5wHG9bmK/test_stage1.mjs
```

验证结果：全部通过。
