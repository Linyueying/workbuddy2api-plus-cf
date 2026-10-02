# workbuddy2api-panel-plus · Cloudflare Pages 云原生重构

把原 Go 后端（多账号 OpenAI 兼容网关 + 管理面板）**完整重写为 JavaScript/TypeScript**，前端静态资源与后端 API **全部由 Cloudflare Pages 托管**。后端使用 Pages Functions 高级模式 `_worker.js` + Hono + Durable Objects。

> 本重构是**云原生重写**而非逐行翻译：原 Go 的「进程内存状态 + 本地文件 + 常驻 goroutine 调度器」整体外移到 **Durable Objects / D1 / KV / R2**。前端（相对路径 + Bearer 鉴权）**零改动**部署。

---

## 1. 架构总览

```
请求 → _worker.js(Hono)
        ├─ /v1/*、/status、/panel/api/* ──→ Hono 路由
        │        └─ 账号池状态/选号/冷却/刷新 ──→ Durable Object PoolDO（单实例，顺序单线程）
        │        └─ 上行 SSE/代理/OAuth ──→ fetch（上游 copilot.tencent.com / workbuddy.ai）
        │        └─ 用量/日志/子密钥 ──→ D1
        │        └─ 模型缓存/登录态 ──→ KV
        │        └─ 日志归档 ──→ R2
        └─ /panel/*（静态） ──→ env.ASSETS.fetch（dist/panel/index.html、app.js）
```

| 原 Go 形态 | Pages 落点 |
|---|---|
| 全局 `map[uid]*Auth` + 锁 | 单实例 Durable Object `PoolDO`（顺序单线程 = 天然锁）|
| `auths/*.json` / `state.json` | PoolDO Storage |
| `usage.json` / `request-logs/*.jsonl` | D1（查询）+ R2（归档）|
| `keys.json` | D1 |
| `model.json` / `output_probes.json` | KV（TTL 缓存）|
| `scheduler.Run` 常驻 goroutine | DO `alarm()` 自调度 **或** 外部 cron → `/panel/api/*_all` |
| Upstash/Redis | 已移除（纯 DO Storage）|
| `os.Getenv` / `config.json` | Pages Secrets（敏感）+ KV（非敏感）|

---

## 2. 项目结构

```
workbuddy2api-pages/
├── wrangler.toml              # Pages 配置（构建输出 + KV/D1/R2/DO 绑定）
├── package.json
├── tsconfig.json
├── worker-configuration.d.ts  # Env 绑定类型
├── _worker.js                 # 构建产物（esbuild 由 src/index.ts 生成）
├── src/
│   ├── index.ts               # 入口（导出 default.fetch + PoolDO）
│   ├── config.ts              # 配置加载/归一（替代 config.go）
│   ├── router.ts              # Hono 路由装配 + CORS + 鉴权
│   ├── types.ts
│   ├── routes/{api,panel,login,admin}.ts
│   ├── durable/{account-pool,session,persist}.ts   # PoolDO
│   ├── services/{upstream,sse,oauth,proxy,classify,resolveModel,compat,prompt,tasks}.ts
│   ├── storage/{kv,d1,r2,auth,usage,reqlog}.ts
│   └── alarms.ts              # PoolDO alarm 调度
├── migrations/0001_init.sql   # D1 schema
├── scripts/{import-config,import-auths,copy-frontend}.mjs
├── vendor/frontend/           # 原面板 index.html + app.js（零改动）
├── dist/                      # 构建输出（_worker.js + panel/）
└── test/                      # Miniflare + Vitest
```

---

## 3. 本地开发

```bash
npm install
cp vendor/frontend dist/panel    # 或 npm run copy-frontend（已挂到 build）

# 本地用默认 api_key=dev-admin-key 启动
npm run dev
# 打开 http://localhost:8788/panel/
```

本地 D1 / KV / DO 由 Miniflare 自动提供（无需手动建）。如需本地 D1 数据：

```bash
wrangler d1 execute WB2A_DB --local --file=./migrations/0001_init.sql
```

---

## 4. 部署到 Cloudflare Pages

### 4.1 创建绑定资源

```bash
# KV（配置 + 缓存）
wrangler kv namespace create WB2A_CONFIG
wrangler kv namespace create WB2A_CACHE

# D1
wrangler d1 create workbuddy2api

# R2
wrangler r2 bucket create workbuddy2api-logs
```

把上面返回的 **id** 填进 `wrangler.toml` 对应位置（`REPLACE_WITH_*_ID`）。

### 4.2 配置 Secrets（敏感，不进仓库/代码）

```bash
# Pages 项目要用 pages 子命令（--project-name 必填，见 wrangler pages secret put --help）
wrangler pages secret put WB2A_API_KEY --project-name workbuddy2api-pages   # 管理面板 / API 的 Bearer key（**必设**）
wrangler pages secret put WB2A_DEVICE_TOKEN --project-name workbuddy2api-pages  # 可选：设备 token
# WB2A_UPTASH_TOKEN 可选（本项目已用纯 DO 替代 Upstash）
```

> `WB2A_API_KEY` 不设的话部署照样成功，但面板与所有 API 恒 401 —— 表现为
> "部署完成但什么都打不开"。`/healthz` 会报 `ready:false` 并给出这条修复命令。

### 4.3 初始化 D1 + 构建部署

```bash
# 建表（Pages 不自动跑迁移，必须显式执行；幂等，可重复跑）
npm run db:init:remote       # 等价 node scripts/db-init.mjs --remote

npm run build                # esbuild 生成 dist/_worker.js + 拷贝前端
wrangler pages deploy dist
```

> 也可在 Cloudflare Pages 控制台连接 Git 仓库：构建命令 `npm run build`，输出目录 `dist`。

### 4.4 部署前后验证（别跳过）

这三类故障的共同点是**`wrangler pages deploy` 照样返回成功**，问题几小时后才暴露：

| 故障 | 症状 | 何时才发现 |
|---|---|---|
| `wrangler.toml` 占位符没换 | 绑到错误/不存在的资源 | 部署时或首次请求 |
| D1 没建表 | 部署成功 | 首个写请求 500，错误点在深处 |
| `WB2A_API_KEY` Secret 没设 | 部署成功 | **面板全锁**（所有接口 401），日志无线索 |

所以配套两个脚本：

```bash
# 部署前：查配置 + 产物 + （--remote  additionally 查远端表与线上健康）
npm run preflight
node scripts/preflight.mjs --remote --url=https://xxx.pages.dev

# 部署后：打真实端点（鉴权 / 核心读 / D1 写）
WB2A_URL=https://xxx.pages.dev WB2A_API_KEY=xxx npm run smoke
```

`/healthz` 现在会做**启动自检**并区分两层语义：

- `ready: false` + HTTP 503 → 配置坏了（D1 缺表/ 密钥为空 / 绑定不可用），响应体 `checks` 里逐项给出原因与修复命令；
- `ready: true` + `healthy: false` → 配置没问题，只是池里还没可服务账号（新部署的正常中间态，不该报警）。

### 4.5 导入原有配置与账号

```bash
# 导入 config.json（非敏感项；敏感 api_key 走 Secret）
WB2A_API_KEY=xxx node scripts/import-config.mjs ./config.json

# 导入 auths/*.json（账号凭证写入 PoolDO，敏感 token 不再落盘）
WB2A_API_KEY=xxx node scripts/import-auths.mjs ./auths

# 或在面板 UI：设置 → 导入
```

---

## 5. 定时任务（Pages 无 Cron Triggers）

两种驱动方式**复用同一套调度逻辑**，互为兜底：

**方式 A（推荐，最稳）：外部 cron → 调面板接口**
任意外部定时器（cron-job.org / GitHub Action / 最小辅助 Worker）每整点调用：

```bash
curl -X POST https://<your-pages.dev>/panel/api/checkin_all  -H "Authorization: Bearer $KEY"
curl -X POST https://<your-pages.dev>/panel/api/travel_all   -H "Authorization: Bearer $KEY"
curl -X POST https://<your-pages.dev>/panel/api/activity_all -H "Authorization: Bearer $KEY"
curl -X POST https://<your-pages.dev>/panel/api/keepalive_all -H "Authorization: Bearer $KEY"
# 成长任务：curl -X POST .../panel/api/tasks/run_queue
# 余额刷新：curl -X POST .../panel/api/balance_all
```

**方式 B（纯 Pages 内闭环）：DO alarm 自调度**
部署后调用一次启动：

```bash
curl -X POST https://<your-pages.dev>/panel/api/scheduler/arm -H "Authorization: Bearer $KEY"
```

`PoolDO` 会在每个整点执行对应任务并 `setAlarm(nextHour)` 自调度。

---

## 6. API 契约（与原 Go 保持一致）

| 路径 | 说明 |
|---|---|
| `POST /v1/chat/completions` | 多账号轮转 + SSE 流式（model 支持 `cn:`/`global:` 前缀）|
| `POST /v1/responses` | OpenAI Responses API → chat 兼容 |
| `POST /v1/messages` | Anthropic Messages API → chat 兼容 |
| `GET /v1/models` | 模型目录（子密钥按白名单过滤）|
| `GET /status` / `GET /healthz` | 池状态 / 健康检查 |
| `POST /panel/api/login/start` `GET /panel/api/login/poll` `GET /panel/api/login/regions` | OAuth 设备流 |
| `GET /panel/api/overview` `/logs` `/models` `/request_logs` `/usage` `/packages` | 面板数据 |
| `POST /panel/api/accounts/{uid}/{revive,disable,checkin,balance,remove}` | 账号运维 |
| `POST /panel/api/accounts/{uid}/tasks/{accept,accept_all,claim,auto}` | 任务中心 |
| `POST /panel/api/{checkin_all,travel_all,activity_all,keepalive_all,balance_all}` | 全量定时任务 |
| `GET/POST /panel/api/config` `GET/POST /panel/api/keys` | 配置 / 子密钥 |

错误信封统一为 `{ error: { message, type: "api_error", code, gateway_hint? } }`，错误 `code` 名（如 `content_blocked`、`prompt_too_long`、`upstream_credits_exhausted`）逐字保留。

---

## 7. 测试

```bash
npm test
```

覆盖：错误分类（十二类保序）、SSE 聚合/透传、账号池 DO（Miniflare 集成：add/pick/acquire/note/disable/remove）、代理（流式成功 + 429 信封）、OAuth 设备流、DO alarm 调度。

---

## 8. 风险与替代方案

| 限制 | 方案 |
|---|---|
| Pages 无 Cron Triggers | 外部 cron → 面板接口（推荐）；或 DO `alarm()` 自调度 |
| Pages 无 Queue 消费者 | 任务中心用 PoolDO 同步/半异步（`ctx.waitUntil`），无需 Queue |
| 无文件系统 | 全部外移到 KV/D1/R2/DO Storage |
| 无全局可变内存 | 单实例 DO 顺序单线程替代锁 |
| 长任务 CPU 时间 | 全量任务 `waitUntil` 异步执行，立即返回 `{ok,started}` |
| Upstash/Redis | 移除；纯 DO Storage 已天然共享状态 |

> **关于任务中心上游 payload**：旅行/夜猫子/成长/校园券等端点已在 `src/services/tasks.ts` 按审计端点还原，若上游字段有变动，集中在该文件调整即可。
