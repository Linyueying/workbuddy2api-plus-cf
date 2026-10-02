# workbuddy2api-panel-plus · Cloudflare Pages 云原生重构

把原 Go 后端（多账号 OpenAI 兼容网关 + 管理面板）**完整重写为 JavaScript/TypeScript**，前端静态资源与后端 API **全部由 Cloudflare Pages 托管**。后端使用 Pages Functions 高级模式 `_worker.js` + Hono + Durable Objects。

> 本重构是**云原生重写**而非逐行翻译：原 Go 的「进程内存状态 + 本地文件 + 常驻 goroutine 调度器」整体外移到 **Durable Objects / D1 / KV / R2**。前端（相对路径 + Bearer 鉴权）**零改动**部署。

> **没有本地电脑 / 第一次用 Cloudflare？** 看 👉 [DEPLOY-NOVICE.md](./DEPLOY-NOVICE.md)：
> 手把手网页版教学，从注册到面板能用，30–40 分钟照着点完。
>
> 有经验只要参数 → [DEPLOY-WEB.md](./DEPLOY-WEB.md)。
>
> **完全没有命令行**也能部署：Pages 侧 5 个绑定全在 Dashboard 点，
> 两个 Worker 的资源 ID 由构建机从环境变量注入（`node scripts/fill-ids.mjs`，见 4.5 节）。
> 本文第 4 节是命令行版步骤，两者**选一种即可**。

---

## 1. 架构总览

三个部署单元（均为 Cloudflare 托管，同一仓库）：

```
① Pages  workbuddy2api-pages       —— API + 面板静态资源
   请求 → _worker.js(Hono)
          ├─ /v1/*、/status、/panel/api/* ──→ Hono 路由
          │      └─ 账号池 RPC ──→ ② 的 PoolDO
          │      └─ 上行 SSE/代理/OAuth ──→ fetch（上游 copilot.tencent.com / workbuddy.ai）
          │      └─ 用量/日志/子密钥 ──→ D1（首个请求自动建表）
          │      └─ 模型缓存/登录态 ──→ KV
          └─ /panel/*（静态） ──→ env.ASSETS.fetch

② Worker workbuddy2api-pool        —— 账号池 Durable Object
   PoolDO（单实例，顺序单线程 = 天然锁）+ alarm 自调度（兜底）

③ Worker workbuddy2api-scheduler   —— 定时作业（Pages 无 Cron Triggers）
   cron 整点 → runScheduledJobs（签到/旅行/活跃/保活/夜猫子/成长）
   cron 每日 → D1 请求日志 → R2 归档
```

| 原 Go 形态 | 落点 |
|---|---|
| 全局 `map[uid]*Auth` + 锁 | 单实例 Durable Object `PoolDO`（②）|
| `auths/*.json` / `state.json` | PoolDO Storage |
| `usage.json` / `request-logs/*.jsonl` | D1（查询）+ R2（③ 归档）|
| `keys.json` | D1 |
| `model.json` / `output_probes.json` | KV（TTL 缓存）|
| `scheduler.Run` 常驻 goroutine | ③ 的 Cron Triggers（DO alarm / 外部 POST 退为兜底）|
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
├── pool-worker/               # ② 独立 Worker：承载 PoolDO（Pages 不能自带 DO）
│   ├── wrangler.toml          #   含 [[migrations]] —— Pages 里禁止，这里必需
│   └── src/index.ts           #   export { PoolDO }（复用主项目 src/durable/）
├── scheduler-worker/          # ③ 独立 Worker：Cron Triggers（Pages 没有 cron）
│   ├── wrangler.toml          #   [triggers] crons = 整点作业 + 每日日志归档
│   └── src/index.ts           #   scheduled() → runScheduledJobs / 日志归档
└── test/                      # Miniflare + Vitest
```

> 为什么拆出 ②③：**Pages 项目无法承载 Durable Object**（禁止 `migrations`
> 但 DO 又必须靠它注册），也**没有 Cron Triggers**。二者都是平台硬约束，
> 不是设计选择。详见 4.1a / 4.1b。

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

**Pages 侧不用填任何文件**：根目录 `wrangler.toml` 刻意不声明绑定、也不写
`pages_build_output_dir`——一旦写了，Cloudflare 就会把它当生产配置真源，
Dashboard 里的绑定变成只读、只能靠改文件填 ID。留空之后 5 个绑定全在
Dashboard 的 Settings → Functions 里点（详见 [DEPLOY-WEB.md](./DEPLOY-WEB.md)）。

**两个 Worker 需要填**：`pool-worker/wrangler.toml` 与 `scheduler-worker/wrangler.toml`
里的占位符用 `npm run fill:ids` 注入，它从环境变量读 ID 替换，幂等，适合接进 CI：

```bash
CF_KV_CONFIG_ID=xxx CF_KV_CACHE_ID=yyy CF_D1_ID=zzz npm run fill:ids
# --lenient 缺哪个跳过哪个；--dry-run 只打印不落盘
```

### 4.1a 部署定时作业 Worker（**必须，否则没有定时任务**）

Pages 项目**没有 Cron Triggers**，所以 6 个定时作业（签到/旅行/活跃/保活/
夜猫子/成长）与日志归档必须由独立 Worker 的 cron 触发。Workers 原生支持
`[triggers] crons`，由平台保证触发，不再依赖外部 cron 服务，也不必手动 arm
DO alarm（那两条退为兜底）。

```bash
npm run deploy:scheduler
```

两条 cron（见 `scheduler-worker/wrangler.toml`）：

| cron (UTC) | 作用 |
|---|---|
| `0 * * * *` | 每整点：按北京时间判断该跑哪些作业（`runScheduledJobs`） |
| `30 17 * * *` | 每日 UTC 17:30（北京时间 01:30 低峰）：把 7 天前的请求日志从 D1 归档到 R2 |

> 本 Worker **不需要任何 Secret**（直接调内部函数，不走 HTTP 鉴权）。
> 但要绑 `WB2A_CONFIG`（读作业开关 + 存归档水位）、`WB2A_DB`、`WB2A_LOGS`。

### 4.1b 部署账号池 Worker（**必须，且要先于 Pages**）

账号池 `PoolDO` 必须独立部署。**Pages 项目无法承载 Durable Object**，这是
Cloudflare 的硬约束，两条规则互相锁死：

| 规则 | 来源 |
|---|---|
| DO 类必须靠 `[[migrations]]` 才能注册 | Workers 运行时（删掉则 DO 调用挂起） |
| Pages 的 wrangler.toml **不支持** `migrations` | 云端构建直接报 `does not support "migrations"` |
| Pages 的 DO binding **强制**要求 `script_name` | 云端构建直接报 `should specify a "script_name"` |
| 官方：*"You cannot create and deploy a Durable Object within a Pages project"* | Pages 文档 |

所以 PoolDO 拆到 `pool-worker/`，Pages 侧用 `script_name = "workbuddy2api-pool"`
远程引用。Pages 代码不用改，`env.POOL` 照旧可用。

```bash
npm run deploy:pool     # 构建 + wrangler deploy（独立 Worker）
```

> ⚠️ Secret 是按 Worker 独立存储的，Pages 项目设的不会带过来。
> 这个 Worker 要单独设一遍（至少 `WB2A_API_KEY`）：
> ```bash
> npx wrangler secret put WB2A_API_KEY --config pool-worker/wrangler.toml
> ```

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

**建表已自动化**：Worker 在首个请求时自检并建表（见 `src/storage/migrate.ts`），
部署后无需任何手工步骤。空库 → 首次访问 `/healthz` 即完成 4 表 5 索引 19 列的搭建。

```bash
npm run build                # esbuild 生成 dist/_worker.js + 拷贝前端
wrangler pages deploy dist
```

> 也可在 Cloudflare Pages 控制台连接 Git 仓库：构建命令 `npm run build`，输出目录 `dist`。
> Git 集成同样会自动建表——迁移跑在 Worker 进程内，与谁触发部署无关。

自动迁移的三条设计约束（改动 `migrations/*.sql` 时必须同步 `src/storage/migrate.ts`）：

| 约束 | 原因 |
|---|---|
| 一条语句一次 `prepare()` | D1 不支持多语句批处理 |
| 加列前先 `PRAGMA table_info` 探测 | SQLite 的 `ADD COLUMN` **没有** `IF NOT EXISTS` |
| 吞掉 `duplicate column name` | 多个 isolate 并发首触发时的正常竞态 |

`scripts/db-init.mjs` 仍保留，用作手工兜底（例如想先看 DDL 再执行）：

```bash
npm run db:init:remote       # 等价 node scripts/db-init.mjs --remote，幂等
```

### 4.4 部署前后验证（别跳过）

这三类故障的共同点是**`wrangler pages deploy` 照样返回成功**，问题几小时后才暴露：

| 故障 | 症状 | 何时才发现 |
|---|---|---|
| `wrangler.toml` 占位符没换 | 绑到错误/不存在的资源 | 部署时或首次请求 |
| ~~D1 没建表~~ | —— | **已由自动迁移消除**（4.3） |
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

### 4.5 纯网页部署（没有本地电脑时）

不想/不能敲命令，走 👉 [DEPLOY-WEB.md](./DEPLOY-WEB.md)。核心思路是把 4.1 的「填 ID」
从「改仓库文件」变成「配 Cloudflare 环境变量」：

| 部署单元 | Build command | Deploy command | 绑定怎么配 |
|---|---|---|---|
| `workbuddy2api-pool` | `npm install && npm run build:pool && node scripts/fill-ids.mjs` | `npx wrangler deploy --config pool-worker/wrangler.toml` | 构建环境变量注入 |
| `workbuddy2api-scheduler` | `npm install && npm run build:scheduler && node scripts/fill-ids.mjs` | `npx wrangler deploy --config scheduler-worker/wrangler.toml` | 构建环境变量注入 |
| `workbuddy2api-pages` | `npm run build` | ——（Pages 无此字段，产物目录 `dist`） | **Dashboard 点 5 个绑定** |

两个 Worker 各配 `CF_KV_CONFIG_ID` / `CF_KV_CACHE_ID` / `CF_D1_ID` 三个构建变量
（**Settings → Build → Build variables and secrets**，不是运行时那栏）。

Pages 侧一个变量都不用配，只在 **Settings → Functions** 里加 5 个绑定：
`WB2A_CONFIG`、`WB2A_CACHE`（KV）、`WB2A_DB`（D1）、`WB2A_LOGS`（R2）、`POOL`（DO）。
变量名必须一字不差；Production 与 Preview 两套环境各配一遍；改完要 Retry deployment。

> 这套做法参照了同类项目 [K-Vault-Next](https://github.com/Linyueying/K-Vault-Next)：
> 它同样是 Pages 项目，KV/R2 全在 Dashboard 绑，仓库里的 `wrangler.toml` 只作 CLI 参考。
> 关键就是**不写 `pages_build_output_dir`**——写了这一行，Cloudflare 就把该文件当
> 生产配置真源，Dashboard 里的字段随之变成只读。

### 4.6 导入原有配置与账号

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
