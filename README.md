# freebuff2api-workers

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

把 **freebuff / codebuff** 免费模型暴露成 **OpenAI 兼容 API**，推荐 Docker 部署。适配任意 OpenAI SDK / 客户端（ChatGPT-Next-Web、LobeChat、one-api、QwenPaw 等），并支持 Anthropic Messages API。

> ⚠️ 不推荐 Cloudflare Workers 部署：官方已检测 `cf-worker` 边缘标记，封号风险显著。**推荐 Docker 容器 / VPS 直跑**。

## ✨ 特性

- 🔑 **Admin 面板一键加号**：`/admin` 里点「Google 一键登录」，浏览器授权后 token 自动写入账号池（授权码轮询，与官方 CLI 同流程），也保留手动粘贴 token 入口
- 👥 **多账号自动切换**：撞额度自动冷却换号；优先复用活跃 session（约 1 小时），创建才扣额度
- 🌐 **每账号独立出口**：内置 mihomo 多区域出口方案（见下文），同账号永远同出口 IP/时区/locale 设备画像，防关联
- 🛡️ **防封细节**：非 chat 请求用官方 `Bun` UA、chat 用 ai-sdk UA、`x-codebuff-api-key` 双认证头、`foreign_toolset` 工具签名、官方广告/streak 模拟流程、`free_mode_capacity_deferred` 不冷却不换号
- 🧠 **思维强度**：`reasoning_effort`（顶层）与 `reasoning.effort`（嵌套）自动归一，按官方模型 efforts 表 clamp；不传则用上游默认档。输出预算抬升防思考截断
- 📜 **独立日志页**：`/admin/logs` 支持筛选 / 导出 JSON / 一键清空
- ❤️ 免鉴权健康检查 `GET /healthz`；Anthropic `/v1/messages` 系列路由

## 🚀 快速部署（Docker）

```bash
git clone https://github.com/Keeperorowner/freebuff2api-wokers.git
cd freebuff2api-wokers

# 配置 .env
cat > .env <<'EOF'
FREEBUFF_API_KEY=改成你自己的key
ADMIN_KEY=面板访问密钥(本地用可留空)
EOF

docker compose up -d
```

启动后：

| 入口 | 地址 |
|---|---|
| API Base URL | `http://localhost:8877/v1` |
| API Key | `.env` 里的 `FREEBUFF_API_KEY` |
| 管理面板 | `http://localhost:8877/admin` |
| 日志页面 | `http://localhost:8877/admin/logs` |
| 健康检查 | `http://localhost:8877/healthz` |

更新：`docker compose restart`（容器启动自动拉取最新 worker.js，拉取失败用本地副本）。

## 🔑 添加账号（三选一）

1. **一键登录（推荐）**：面板 → 账号区「＋」→「🔑 Google 一键登录」→ 点授权链接用 Google/GitHub 登录 → 服务端轮询拿到 token 自动入池，无需重启
2. **手动粘贴**：同一表单填邮箱 + authToken（可用 `freebuff_tools/extract_freebuff.py login` 本地提取）
3. **凭据文件**：放 `credentials/<邮箱>.json`（`{"email":"..","authToken":".."}`）后重启

## 🌐 多区域代理出口（可选，强烈建议）

免费模型对出口 IP 有地区限制，且同账号换 IP 有关联风险。本项目用 **mihomo 容器**做每账号固定区域出口：

```bash
# 1) .env 里填你的机场订阅
echo 'SUB_URL=https://你的订阅地址' >> .env

# 2) 生成 mihomo 配置（自动:防污染DNS + 每区域一个HTTP出口 + 健康检查快速切换）
node scripts/gen-mihomo-config.mjs

# 3) 启动 mihomo 容器（含 24001-24010 区域端口 + 9090 控制 API）
cd deploy/mihomo && docker compose -f docker-compose.mihomo.yml up -d && cd ../..

# 4) gen 脚本已把生效区域/端口写回 .env（PROXY_HOST=host.docker.internal,
#    PROXY_PORT_BASE=24001, PROXY_REGIONS=...），重启生效
docker compose restart
```

- 出口只走 freebuff 支持的 25 个国家（US/CA/UK/AU/NZ/NO/SE/NL/DK/DE/FR/IT/ES/PT/FI/BE/LU/LI/CH/AT/SG/MT/IL/IE/IS），HK/JP/KR 等不在列表的节点永远不会被使用
- 账号按哈希绑定区域；某节点挂掉 mihomo 120 秒内自动切换（`max-failed-times: 1`）
- 配置内置防污染 DNS（DoH），容器内节点域名解析不受 DNS 污染影响
- 也可以偷懒不装 mihomo，`PROXY_HOST` 直接指向宿主机已开的 Clash 混合端口（`PROXY_PORT_BASE=7890`，`PROXY_REGIONS=US`，需开"允许局域网连接"）

## 💬 调用示例

```bash
curl http://localhost:8877/v1/chat/completions \
  -H "Authorization: Bearer <FREEBUFF_API_KEY>" -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"你好"}]}'

# 思维强度（可选）：low / medium / high / max（超出模型支持档位自动就近降档）
# "reasoning_effort": "high"
```

流式加 `"stream": true`。模型列表 `GET /v1/models`。

## 📋 模型与额度

- 特殊非 Premium 模型：`deepseek/deepseek-v4-flash`、`mimo/mimo-v2.5`（完整访问模式下探测未见基础日限额）
- 其余普通模型按 **每日 6 次 session / 太平洋日**（北京时间约 15:00 重置）理解；一次 session 约 1 小时，多轮对话不重复扣
- 单账号同一时间仅一个客户端在线；上游请求串行执行
- 完整模型表见 [MODELS.md](MODELS.md)

## 🙏 致谢与许可

- 参考 [freebuff2api](https://github.com/XxxXTeam/freebuff2api)、[freebuff-proxy](https://github.com/HengXin666/freebuff-proxy)（reasoning 归一、输出预算治理、`free_mode_capacity_deferred` 处理、登录轮询设计借鉴）、[freebuff](https://github.com/CodebuffAI/freebuff) 官方源码
- [AGPL-3.0](LICENSE)

## ⚠️ 免责声明

仅供技术交流与学习。本项目通过逆向协议实现代理，**违反 freebuff 官方 ToS**，存在账号被封（终态不可恢复）风险；请勿商用或大规模滥用，后果自负。
