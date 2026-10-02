# workbuddy2api-panel — Go→Cloudflare Pages 云原生重构：审计与架构设计

> 阶段一交付物：**后端审计 + 目标架构设计**。确认后我才会分批输出可运行代码。
> 仓库已成功克隆（ghfast 代理），审计基于真实源码，无凭空编造。

---

## 0. 一句话定性

这是一个**有状态**的多账号 OpenAI 兼容网关：账号池调度、token 刷新、会话粘性、按小时的签到/旅行/活跃/保活/夜猫子/成长**后台定时任务**、流式 SSE 转发、管理面板。Cloudflare Pages Functions 是**每请求无状态**的，因此原 Go 里的「进程内存状态 + 本地文件 + 常驻 goroutine 调度器」必须整体外移到 **Durable Objects / D1 / KV / R2**。前端（相对路径 + Bearer）可零改动部署。

最大冲突点汇总：

| 原 Go 形态 | Pages 限制 | 重构落点 |
|---|---|---|
| 全局 `map[uid]*Auth` 账号池 + 锁 | 无全局可变内存 | 单个 Durable Object（顺序单线程=天然锁）+ DO Storage |
| `state.json` / `usage.json` / `keys.json` / `auths/*.json` / `request-logs/` / `model.json` / `output_probes.json` 文件读写 | 无文件系统 | KV（配置/非敏感态）、D1（日志/用量/账号元数据）、DO Storage（账号池）、R2（日志归档导出） |
| `scheduler.Run` 常驻 goroutine 按整点触发 | 无长驻进程 / 无 Cron Triggers | DO `alarm()`（有踩坑，见 §五）+ 外部 cron 兜底 |
| 进程内模型目录缓存、`dynamicModelsCache`、`globalModels` 缓存 | 无全局可变内存 | KV（带 TTL）+ DO 内小缓存 |
| Upstash/Redis 镜像存储（可选） | 可保留但偏离原生 | 用 DO Storage 替代；或保留 Upstash（经 fetch，非必须） |
| `os.ReadFile/config.json` + `WB2A_*` env | Pages 无文件，env 走 Secrets | KV（config）+ Pages Secrets/变量（api_key 等敏感项） |

---

## 1. HTTP 路由审计（请求/响应/错误码）

### 1.1 网关对外 API（`internal/server/handler.go`，`server.NewHandler`）

| 方法 | 路径 | 请求 | 响应 | 错误 |
|---|---|---|---|---|
| POST | `/v1/chat/completions` | OpenAI chat 体（`model` 可带 `cn:`/`global:` 前缀；`stream` 字段） | 流式 `text/event-stream`（逐帧规范化透传）或非流式 `chat.completion` 聚合 JSON | 见 §1.4 错误信封 |
| POST | `/v1/responses` | Responses API 形态 → 翻译为 chat | 同 chat（兼容层 `compat_*.go`） | 同上 |
| POST | `/v1/messages` | Anthropic Messages API → 翻译为 chat | 同 chat（兼容层） | 同上 |
| GET | `/v1/models` | `Authorization: Bearer` | `{object:"list", data:[{id:"cn:hy3",...},...]}` | 无号/失败→空列表（无静态兜底） |
| GET | `/status` | Bearer | `{accounts, total, healthy, cooling, disabled, in_flight_full, realm_totals, sticky_sessions, redis_mode, credit_floor, cost_explore}` | 401 |
| GET | `/healthz` | 无鉴权 | `{healthy, total, service:"workbuddy2api", realm_servable:{cn,global}}` | 503（无可用账号） |
| GET | `/` | — | 302 → `/panel/` | — |
| — | `/panel/*` | — | 转发给面板 handler（见 1.2） | — |

> 子密钥 `wbk_` 前缀：在 `withAuth` 中优先判定（命中 `apikeys.Store` 则放行，不再比管理员 api_key）。`/v1/models` 仅下发该密钥白名单内的模型。

### 1.2 管理面板 API（`internal/panel/panel.go`，`routes()`）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/panel/` | — | 内嵌 `index.html` |
| GET | `/panel/app.js` | — | 内嵌 `app.js` |
| GET | `/panel/api/overview` | — | `{version, uptime_sec, auth_required, redis_mode, sticky_sessions, total, healthy, cooling, disabled, in_flight_full, accounts[]}` |
| GET | `/panel/api/logs` | — | `{entries:[{ts, channel:"chat/task/sys", msg}]}`（环形缓冲） |
| GET | `/panel/api/request_metrics` | — | 进程内请求指标快照 |
| GET | `/panel/api/request_logs` | `limit,outcome,account,model,client_ip,user_agent,from,to` | `{entries:[...], limit}`（读 JSONL 归档） |
| GET | `/panel/api/models` | — | `{ok, models:[{id:"cn:hy3", ...全字段}]}`（直连上游实时探测） |
| POST | `/panel/api/login/start` | `{realm?:"cn"\|"global"}` | `{ok, url, state, realm}` |
| GET | `/panel/api/login/poll` | `?state=` | `{done:false}` 或 `{done:true, uid, nickname, realm, credits, credits_total, checkin_message}` |
| GET | `/panel/api/login/regions` | — | `{ok, regions:[{code,name}]}` |
| POST | `/panel/api/import/cockpit` | `multipart: file` | `{ok, imported, errors}` |
| POST | `/panel/api/accounts/{uid}/revive` | — | `{ok}` |
| POST | `/panel/api/accounts/{uid}/disable` | — | `{ok, reason}` |
| POST | `/panel/api/accounts/{uid}/checkin` | — | `{ok, checkin_done, credits, credits_total, checkin_message?}` |
| POST | `/panel/api/accounts/{uid}/balance` | — | `{ok, credits, credits_total}` |
| POST | `/panel/api/accounts/{uid}/remove` | — | `{ok, file_error?}` |
| GET | `/panel/api/accounts/{uid}/tasks` | — | 任务中心任务列表 |
| POST | `/panel/api/accounts/{uid}/tasks/accept` | `{taskId}` | 接受单个任务 |
| POST | `/panel/api/accounts/{uid}/tasks/accept_all` | — | 接受全部任务 |
| POST | `/panel/api/accounts/{uid}/tasks/claim` | `{taskId}` | 领取任务奖励 |
| POST | `/panel/api/accounts/{uid}/tasks/auto` | — | 自动跑完当前账号所有任务 |
| POST | `/panel/api/accounts/{uid}/tasks/auto_all` | — | 自动跑完全部账号任务 |
| POST | `/panel/api/tasks/scan_all` | — | 扫描全部账号任务中心 |
| POST | `/panel/api/tasks/run_queue` | — | 执行任务中心队列 |
| GET | `/panel/api/tasks/queue` | — | 队列状态 |
| GET | `/panel/api/school/vouchers` | — | 校园代金券 |
| POST | `/panel/api/checkin_all` | — | `{ok, started}` |
| POST | `/panel/api/travel_all` | — | `{ok, started}` |
| POST | `/panel/api/activity_all` | — | `{ok, started}` |
| POST | `/panel/api/keepalive_all` | — | `{ok, started}` |
| POST | `/panel/api/balance_all` | — | `{ok, accounts}` |
| GET | `/panel/api/packages` | — | `{accounts:[{uid, nickname, realm, remain, size, packages[], error?}]}` |
| GET | `/panel/api/usage` | `from,to,hours` | 用量聚合窗口快照 |
| POST | `/panel/api/usage/save` | — | `{ok}` |
| GET | `/panel/api/model_probes` | — | `{probes, exists, updated_at?}` |
| GET/POST | `/panel/api/keys` (+`/{id}`, `/{id}/reset`, `/check-models`) | — | 子密钥增删改查/重置/型号校验 |
| GET/POST | `/panel/api/config` | POST 体=配置 JSON | GET 返回配置；POST 返回 `{ok, restart_required[]}` |

> 全部面板接口除 `GET /panel/`、`/panel/app.js`、`/healthz` 外均走 `withAuth`（Bearer api_key）。`config`/`keys`/`usage` 接口在对应子系统未启用时返回 `501 {ok:false,error}`。

### 1.3 错误信封（`writeOpenAIError` / `writeOpenAIErrorHint`）

统一形态：`{error:{message, type:"api_error", code, gateway_hint?}}`。

### 1.4 错误码 / 业务分类（`upstream.Classify` 十二类）

| Kind | HTTP 映射 | 账号池动作 |
|---|---|---|
| `ErrHardCredit` | 402 `upstream_credits_exhausted` | 硬冷却到次日 04:00 |
| `ErrSoftRate` | 429 `rate_limit_exceeded`（6004 模型级走模型豁免） | 软冷却（对齐上游重置墙钟/Retry-After/有界退避） |
| `ErrSessionDead`(12153) | 401/原样 | Disable |
| `ErrWafBlock`(403 无业务信封) | 403（IP 级 fail-fast 终止轮转） | 账号软冷却 + 抖动 |
| `ErrNotFound` | 404 | 短冷却 60s |
| `ErrServer`(5xx) | 503 | NoteError（熔断计数） |
| `ErrContentBlocked` | 400 `content_blocked` | 不罚号，降级重试 |
| `ErrBadParams`(11101) | 400 | 不罚号，仍轮转 |
| `ErrPromptTooLong`(11115) | 400 `prompt_too_long` | 不罚号，不轮转，透传原文 |
| `ErrImageInvalid`(11135) | 400 `image_invalid` | 不罚号，不轮转 |
| `ErrModelBlocked`(11102) | 400/404 | (账号,模型) 负缓存避让 |
| `ErrAccountFault`(11140/14017) | 403/原样 | 11140→Disable；14017→软冷却 |
| `ErrClient` | 503 | 只换号不罚 |
| 本地无号 | 503 `no_healthy_account` | — |

> 分类顺序严格（见 `Classify` 注释），重写时必须保持相同优先级，否则会误罚号。

---

## 2. 配置 / 环境变量 / auths / config.json 结构

### 2.1 `config.json`（顶层键，见 `config.example.json`）

`listen, api_key, auth_dir, state_file, trust_proxy, panel.package_detail_limit,
logging.{request_archive_enabled,request_retention_days,request_archive_max_mb,request_client_info},
cooldown.{soft_rate,soft_rate_max}, schedule.{checkin_hours,travel_hours,activity_hours,keepalive_hours,blackcat_hours,growth_hours,
*_enabled, balance_refresh_enabled, balance_refresh_minutes},
global.{enabled,chat_base,billing_base}, upstream.{timeout_seconds,header_timeout_seconds,idle_timeout_seconds,
user_agent,client_version,cli_version,client_name,device_token,device_token_file,passthrough_ip},
features.sanitize_blacklist_fingerprints, prompt.{mode,file}, upstash.{url,token},
pool.{max_in_flight,max_in_flight_global,breaker_threshold,breaker_cooldown,breaker_cooldown_max,
degrade_threshold,degrade_cooldown,degrade_cooldown_max,idle_weight_per_hour,idle_weight_max,
prefer_expiring,expiring_soon,cost_explore_interval,credit_floor},
session_sticky.{enabled,ttl,gc_interval}, auto_model.{enabled,day_primary,night_primary,day_start,day_end,
virtual_id,override,fallback[],on_empty,fallback_on[]}, model_fallback{}`

### 2.2 环境变量覆盖（`WB2A_*` 前缀，`applyEnv`）

`WB2A_LISTEN, WB2A_API_KEY, WB2A_AUTH_DIR, WB2A_STATE_FILE, WB2A_SOFT_RATE, WB2A_SOFT_RATE_MAX,
WB2A_TIMEOUT_SECONDS, WB2A_HEADER_TIMEOUT_SECONDS, WB2A_IDLE_TIMEOUT_SECONDS, WB2A_USER_AGENT,
WB2A_CLIENT_VERSION, WB2A_CLI_VERSION, WB2A_CLIENT_NAME, WB2A_DEVICE_TOKEN, WB2A_DEVICE_TOKEN_FILE,
WB2A_PASSTHROUGH_IP, WB2A_SANITIZE_FINGERPRINTS, WB2A_PROMPT_MODE, WB2A_PROMPT_FILE,
WB2A_EXPIRING_SOON, WB2A_PREFER_EXPIRING`

### 2.3 auths 目录结构（`internal/auth`）

扫描 `workbuddy*.json`，两种磁盘形态均兼容：

- **嵌套形**（插件 OAuth）：`{"auth":{accessToken,refreshToken,expiresAt,domain,realm},"account":{uid,enterpriseId,nickname},"device_token"?}`
- **扁平形**（手写）：`{accessToken,refreshToken,expiresAt,domain,realm,uid,enterpriseId,nickname,device_token?}`

落盘统一为嵌套形（`SaveAtomic`，`accessToken` 非空才写）。`realm` 空时按 `domain` 后缀（`.workbuddy.ai`→global）backfill。文件名 `workbuddy-<uid>.json`。

### 2.4 Pages 映射

- **敏感项**（api_key、device_token、upstash token）→ Pages Secrets / 环境变量（不进 KV、不进代码）。
- **非敏感配置** → KV 命名空间 `WB2A_CONFIG`（JSON 整体），或 D1 单行。
- **auths/*.json** → 写入 Durable Object `PoolDO` 的 Storage（key=uid），敏感 token 只存 DO Storage（等同原 auth 文件，但不再落盘）。
- `WB2A_*` env → Pages 项目变量 + Secrets。

---

## 3. 外部调用 / OAuth / SSE / 反向代理审计

### 3.1 上游端点（`internal/upstream/client.go`）

| 用途 | 方法 | 路径（realm 感知） |
|---|---|---|
| Chat SSE | POST | `chatBase/v2/chat/completions`（`global` 同 base） |
| Token 刷新 | POST | `chatBase/v2/plugin/auth/token/refresh` |
| 模型目录 | GET | `chatBase/console/enterprises/personal/models` + `chatBase/v3/config`（两路并发合并） |
| global 模型目录 | GET | `globalBase/v2/...`（探测缓存） |
| 余额/积分包 | POST | `billingBase/v2/billing/meter/get-user-resource`（global 先试无 /v2） |
| 签到 | POST | `billingBase/v2/billing/meter/daily-checkin` |
| 任务中心/成长/猫猫旅行/活跃/校园券 | 多端点 | `billingBase` / `webBase`（workbuddy.cn / workbuddy.ai） |

- `chatBaseCN=https://copilot.tencent.com`，`billingBaseCN=https://www.codebuddy.cn`，`webBaseCN=https://www.workbuddy.cn`
- `globalBase=https://www.workbuddy.ai`
- 出站头：`Authorization: Bearer <accessToken>`、`X-IDE-*` 归属头（client_name 非空时）、`X-Device-Token`、`User-Agent`（官方三段式）、`X-Conversation-Request-ID` 等（会话头族复用）。
- UA 默认 `WorkBuddy/<ver> CLI/<cliVer>`；`codeBuddyIDEUA`/`codeBuddyCLIUA` 用于模型目录探测（不同 UA 下发不同模型集）。

### 3.2 OAuth 设备授权（`internal/panel/login.go`）

1. `POST /panel/api/login/start` → `POST {base}/v2/plugin/auth/state?platform=CLI` 拿 `{state, authUrl}`，state 存内存（Pages 改为 DO Storage / D1）。
2. 前端每 3s `GET /panel/api/login/poll?state=` → `GET {base}/v2/plugin/auth/token?state=`：pending 回 `{done:false}`；完成取 token → `GET {base}/v2/plugin/login/account?state=` 取 uid/nickname → 校验 uid（防路径穿越）→ 落盘嵌套形 → `pool.Add`+`Revive` → 顺带签到/余额（global 走注册激活+ trial 领取）。
3. `GET /panel/api/login/regions` 返回静态地区白名单（HK/MO/SG/TH/PH/MY/ID）。

> 无 PKCE（服务端签发 state）。Pages 重写：state 会话存 DO/D1，TTL 15min 回收。

### 3.3 SSE 流式（`internal/upstream/sse.go`）

- `Aggregate(r)`：读完整流聚合为单个 `chat.completion`（合并 delta.content / reasoning_content / tool_calls，按 index；处理缺 index 的 tool_call；空流报 `errEmptyStream`→502；`[DONE]` 收尾）。
- `StreamHint(w, r, hintFn)`：逐帧规范化透传（`normalizeFrame` 白名单 + `stripToolCallNames`），保留 error 帧原文 + 附加 `gateway_hint`；保证恰好一个 `[DONE]`；空流补 error 帧。
- **Pages 重写**：用 `ReadableStream`/TransformStream 逐块转发，不缓冲，`request.signal` 断开即清理上游流（对齐原 `monitorBody` 的 cancel 语义）。

### 3.4 反向代理逻辑（`ChatStreamContext`）

逐模型候选链（`auto_model`/`model_fallback`）轮转 → 每候选 `PickExcludingForRealm(tried, model, realm)` 选号 → `Acquire(uid)` 占在途 → 临近过期 `RefreshToken` → `ChatStreamContext(ctx, acct, body, clientIP, meta)` 转发 → 分类错误 → 按 `applyErrorPolicy` 冷却/熔断/降级模型 → 轮转退避（`rotateBackoff` 指数+抖动）→ 客户端断开（`ctx` 取消）即终止。

---

## 4. 账号池 / 调度 / 限流 / 重试 / 健康检查 / token 刷新

### 4.1 账号池（`internal/pool/*`）

- 热点方法：`Pick/PickExcludingForRealm/PickByUIDForModel/Acquire/Release`、`NoteError/NoteSuccess/NoteFailures/NoteSessionDead`、`Cooldown/CooldownSoftRate/CooldownSoftForModel/CooldownUntilTomorrow4AM/BlockModelBackoff/BlockModelClear`、`SetCreditsDetailed/ReenableIfCredits/NoteCheckinDone/NoteModelCost/RecordTokenUsage`、`List/Status/CountsDetailed/AvailableUIDsForRealm/AuthByUID/ServableNow/ServableForRealm`。
- 状态机：健康 / 冷却（软/硬/模型级）/ 熔断（连续失败指数退避）/ 连败降权（issue #114）/ 禁用 / 在途满（`max_in_flight` per 账号，`max_in_flight_global` for global）。
- 选号权重：闲置补偿（`idle_weight_per_hour`，封顶 `idle_weight_max`）、最早到期优先（`prefer_expiring` + `expiring_soon` 窗口）、costTier 探索（`cost_explore_interval`）。
- 积分保底（`credit_floor`）：实测收费模型（tier 2）余额低于阈值不出票。

### 4.2 token 刷新

`RefreshToken` 两段式锁（锁内读快照/写回，网络 I/O 锁外 30s ctx）：刷新 `accessToken/refreshToken/expiresIn→ExpiresAt`。`NeedsRefresh(within=10m)` 触发。成功后 `SaveAtomic` 落盘。

### 4.3 健康检查 / 限流 / 重试

- 熔断：`breaker_threshold`（连续失败）/ `breaker_cooldown`（基础）/ `breaker_cooldown_max`（指数封顶）。
- 软限流：`soft_rate` 基数 + `soft_rate_max` 封顶（指数退避），优先对齐上游重置墙钟/Retry-After 头。
- 重试/轮转：`MaxRotate=3` 次/模型，单请求上限 32；`WAF IP fail-fast` 终止轮转。
- 健康检查：无主动探活，靠实时请求成败驱动 `NoteSuccess/NoteError`；`/healthz` 按 `ServableNow()` 判活。

### 4.4 会话粘性（`internal/session`）

`session_sticky.enabled`（默认 true）：`TurnKey`/`Session.RequestIDForKey` 聚合键 → `Bind/ResolveForModel/Unbind`，TTL 30m，GC 5m。Redis 模式可跨实例共享。Pages 重写：粘性状态存 DO Storage（或 D1）。

---

## 5. 定时任务 / 自动任务 / 后台轮询 / 文件读写点

### 5.1 后台任务（原 `scheduler.Run` + `StartBalanceRefresh`）

| 任务 | 默认整点 | 接口触发 |
|---|---|---|
| 签到 DailyCheckin + 余额解冻 | 9,21 | `/checkin_all` |
| 猫猫旅行（领养/派出/领奖） | 9,21 | `/travel_all` |
| 活跃上报（连登+解锁） | 10 | `/activity_all` |
| token 保活 | 22 | `/keepalive_all` |
| 夜猫子（glm-5.2 对话补足） | 23 | — |
| 成长任务队列（Sequential 族） | 1 | `/tasks/run_queue` |
| 余额后台刷新 | 每 5min | `/balance_all` |

### 5.2 自动任务（任务中心，`autotask.go` / `taskcenter.go`）

`/accounts/{uid}/tasks/{accept,accept_all,claim,auto}`、`/tasks/{scan_all,run_queue}`、`/tasks/queue`、`/school/vouchers`。`RunGrowthQueueOnce` 在零点解锁后由 scheduler hook 自动跑。

### 5.3 文件读写点（全部需外移）

| 文件 | 原用途 | Pages 落点 |
|---|---|---|
| `auths/workbuddy-*.json` | 账号凭证 | DO Storage（PoolDO） |
| `state.json` | 账号池状态快照 | DO Storage |
| `usage.json` | 逐请求用量 | D1 |
| `keys.json` | 子密钥库 | D1 / KV |
| `request-logs/*.jsonl` | 请求归档 | R2（或 D1） |
| `model.json` | 模型 context/max_output 缓存 | KV（TTL） |
| `output_probes.json` | 模型上限探测结果（只读展示） | R2 / KV |
| `data/state.json` sibling 推导路径 | 同上 | 同 |

> **Cloudflare Pages 关键约束**：无 `fs/path/child_process`，禁止全局可变内存，CPU 时间有限（长任务拆 DO alarm / Queue），敏感信息只放 Secrets。

---

## 6. 第三方 Go 依赖 → JS/TS 替代

| Go 依赖 | 用途 | TS 替代 |
|---|---|---|
| 标准库 `net/http`, `ServeMux` | 路由 | **Hono**（跑在 `_worker.js`）或 **itty-router** |
| 标准库 `encoding/json` | 序列化 | 原生 `JSON` + `zod`（校验） |
| 标准库 `regexp` | 错误分类正则 | 原生 `RegExp` |
| 标准库 `sync`, `atomic.Bool`, `sync.Map` | 并发/状态 | **Durable Object**（顺序单线程，天然替代锁） |
| 标准库 `time` + `FixedZone("UTC+8")` | 墙钟/时区 | 原生 `Date` + `TZ=Asia/Shanghai`（固定 UTC+8，勿依赖 tzdata） |
| `github.com/redis/go-redis/v9` | 可选 Upstash 镜像 | **替代为 DO Storage / D1**（或保留 Upstash 经 fetch） |
| `go.uber.org/atomic` | 原子布尔 | 不需要（DO 单线程） |
| `github.com/cespare/xxhash`, `dgryski/go-rendezvous` | redis 内部 | 不需要 |
| `golang.org/x/sys` | 系统调用 | 不需要 |
| `crypto/rand` | api_key 生成 | Web Crypto `crypto.getRandomValues` |
| Web Crypto | — | 原生 `crypto.subtle` |

---

## 7. 目标架构（全部在 Cloudflare Pages 内）

### 7.1 核心决策：账号池 = 一个 Durable Object

把整个 `Pool` + `Scheduler` + token 状态搬进 **单个 Durable Object `PoolDO`**（instance 名固定如 `main`）。理由：

- DO 实例**顺序处理请求** → 原 `sync.Mutex`/`atomic.Bool` 全部消失，选号/在途占用/冷却状态天然一致。
- DO **Storage（SQLite 后端）** 持久化账号凭证与池状态 → 替代 `state.json`/`auths/*.json`，进程重启不丢。
- DO **`alarm()`** → 替代常驻 `scheduler.Run` 整点任务（见 §7.4 风险）。
- chat SSE 在 DO 内代理上游并流式返回 → 客户端断开时 `request.signal` / `ctx.waitUntil` 清理上游。

> 流量路径：`请求 → _worker.js → (API 路径) → Hono → env.POOL.get(idFromName("main")).fetch(subrequest)` → PoolDO 内完成选号/刷新/代理`。静态资源 `env.ASSETS.fetch(request)`。

### 7.2 资源绑定（`wrangler.toml`）

| 资源 | 名称 | 用途 |
|---|---|---|
| KV | `WB2A_CONFIG` | 非敏感配置（config.json 导入后） |
| KV | `WB2A_CACHE` | 模型目录缓存（TTL 10min）、model.json、output_probes |
| D1 | `WB2A_DB` | 用量记录、请求日志、子密钥库、任务中心队列、日志环形缓冲快照 |
| Durable Object | `PoolDO` | 账号池 + 调度 + 会话粘性 + token 状态 |
| R2 | `WB2A_LOGS` | 请求 JSONL 归档导出 |
| Secrets | `WB2A_API_KEY`, `WB2A_DEVICE_TOKEN`, `WB2A_UPTASH_TOKEN` | 敏感项 |
| Pages Build | `pages_build_output_dir = "dist"` | 前端静态资源（含原 `index.html`/`app.js`） |

### 7.3 迁移映射表（Go → TS 模块 → Pages 资源）

| Go 文件 / 函数 | TS 模块 | Pages 资源 |
|---|---|---|
| `cmd/server/main.go`, `config.go` | `src/config.ts` | KV `WB2A_CONFIG` + Secrets |
| `cmd/server/wiring.go` | `src/wiring.ts`（装配） | `_worker.js` 启动 |
| `internal/server/handler.go` | `src/routes/api.ts`（chat/responses/messages/models/status/healthz） | Hono + PoolDO |
| `internal/server/compat_*.go` | `src/services/compat.ts` | — |
| `internal/server/resolve_model.go` | `src/services/resolveModel.ts` | — |
| `internal/panel/panel.go` | `src/routes/panel.ts` | Hono + D1 + PoolDO |
| `internal/panel/index.go`, `index.html`, `app.js` | `dist/panel/*`（原样拷贝） | Pages 静态 |
| `internal/panel/login.go` | `src/routes/login.ts` | PoolDO / D1（state 会话） |
| `internal/panel/config.go` | `src/routes/config.ts` | KV |
| `internal/panel/keys.go` | `src/routes/keys.ts` | D1 |
| `internal/panel/import.go` | `src/routes/import.ts` | PoolDO |
| `internal/panel/autotask.go`, `taskcenter.go` | `src/services/tasks.ts` | PoolDO + D1 |
| `internal/panel/usage.go` | `src/routes/usage.ts` | D1 |
| `internal/auth/auth.go` | `src/storage/auth.ts` | PoolDO Storage |
| `internal/upstream/client.go` | `src/services/upstream.ts` | fetch |
| `internal/upstream/sse.go` | `src/services/sse.ts` | ReadableStream/TransformStream |
| `internal/upstream/classify.go`（散在 client.go） | `src/services/classify.ts` | — |
| `internal/upstream/transport.go` | 无需（fetch 原生） | — |
| `internal/upstream/{models,global_models,tasks,travel,blackcat,streak,school,report,device_token,...}.go` | `src/services/upstream/*.ts` | fetch |
| `internal/pool/*` | `src/durable/account-pool.ts` | PoolDO Storage |
| `internal/pool/persist.go` | `src/durable/persist.ts` | PoolDO Storage |
| `internal/scheduler/*` | `src/alarms.ts` | PoolDO `alarm()` |
| `internal/session/*` | `src/durable/session.ts` | PoolDO Storage |
| `internal/redisstore/*` | 移除 / DO Storage | — |
| `internal/usage/*` | `src/storage/usage.ts` | D1 |
| `internal/reqlog/*` | `src/storage/reqlog.ts` | D1 + R2 |
| `internal/apikeys/*` | `src/storage/apikeys.ts` | D1 |
| `internal/livecfg/*` | `src/storage/livecfg.ts` | KV / DO 内存 |
| `internal/prompt/*` | `src/services/prompt.ts` | — |
| `internal/logfmt/*`, `internal/shortua` | `src/util/*` | — |
| `scripts/probe_*.py` | 保留为外部脚本（不变） | 写 R2/KV |
| `migrations/` | `migrations/*.sql` + `scripts/import-config.ts` | D1 / KV 导入 |

### 7.4 项目结构树（Pages 项目）

```
workbuddy2api-pages/
├── wrangler.toml                  # Pages 配置（构建输出 + KV/D1/R2/DO 绑定）
├── package.json
├── tsconfig.json
├── worker-configuration.d.ts      # 类型声明（env 绑定）
├── _worker.js                     # 入口（Hono + 静态资源 + 转发 PoolDO）
├── src/
│   ├── index.ts                   # 编译入口（导出 default { fetch }）
│   ├── config.ts                  # 配置加载/归一/校验（替代 config.go）
│   ├── router.ts                  # Hono 路由装配
│   ├── routes/
│   │   ├── api.ts                 # /v1/chat|responses|messages|models|status|healthz
│   │   ├── panel.ts               # /panel/api/*（overview/logs/models/config/keys/usage...）
│   │   ├── login.ts               # /panel/api/login/*（OAuth 设备流）
│   │   ├── accounts.ts            # /panel/api/accounts/{uid}/*（运维）
│   │   ├── tasks.ts               # /panel/api/tasks/*（任务中心）
│   │   └── admin.ts               # /panel/api/checkin_all|travel_all|...
│   ├── durable/
│   │   ├── account-pool.ts        # PoolDO：账号池/选号/冷却/熔断/在途/粘性/alarm
│   │   ├── session.ts             # 会话粘性（PoolDO Storage）
│   │   └── persist.ts             # state 快照读写（DO Storage）
│   ├── services/
│   │   ├── upstream.ts            # 上游 HTTP 封装（chat/refresh/models/billing/tasks）
│   │   ├── sse.ts                  # SSE 聚合/逐帧透传（ReadableStream）
│   │   ├── oauth.ts               # 设备授权 start/poll
│   │   ├── proxy.ts               # 反向代理转发（头/体/状态码/流式）
│   │   ├── classify.ts            # 错误分类（十二类，保序）
│   │   ├── prompt.ts              # system 提示词改写
│   │   ├── resolveModel.ts        # realm 前缀解析
│   │   └── compat.ts              # Responses/Anthropic 兼容层
│   ├── storage/
│   │   ├── kv.ts                  # WB2A_CONFIG / WB2A_CACHE 封装
│   │   ├── d1.ts                   # 用量/日志/密钥/任务队列
│   │   ├── r2.ts                  # 日志归档导出
│   │   └── auth.ts                # 凭证解析/原子写回（DO Storage）
│   ├── alarms.ts                  # PoolDO alarm 调度（签到/旅行/活跃/保活/夜猫子/成长/余额刷新）
│   └── types.ts
├── migrations/
│   └── 0001_init.sql              # D1 schema（usage/reqlog/keys/tasks/queue）
├── scripts/
│   ├── import-config.ts           # config.json → KV
│   └── import-auths.ts            # auths/*.json → PoolDO Storage
├── dist/                          # 前端构建输出（含原 panel/index.html, app.js, 静态资源）
│   ├── panel/
│   │   ├── index.html
│   │   └── app.js
│   └── ...
├── test/
│   ├── pool.test.ts               # Miniflare + Vitest
│   ├── oauth.test.ts
│   ├── sse.test.ts
│   ├── proxy.test.ts
│   └── alarms.test.ts
└── README.md                      # 部署说明
```

### 7.5 关键设计点（确保前端零改动）

- **路径完全一致**：`/v1/*`、`/panel/*` 原样保留；`_worker.js` 把 `/panel/` 静态资源走 `env.ASSETS.fetch`，`/panel/api/*` 与 `/v1/*` 走 Hono/PoolDO。
- **鉴权一致**：面板与 API 均 `Authorization: Bearer <api_key>`（或 `wbk_` 子密钥），与原 `withAuth` 同口径。
- **响应字段一致**：`/status`、`/panel/api/overview`、`/v1/models` 的字段名逐字保留（前端靠这些字段渲染）。
- **错误信封一致**：`{error:{message,type:"api_error",code,gateway_hint?}}`，错误 `code` 名（如 `content_blocked`、`prompt_too_long`、`upstream_credits_exhausted`）逐字保留。

### 7.6 SSE 流式（Pages 实现要点）

`/v1/chat/completions` 在 PoolDO 内：`Pick → Acquire → RefreshIfNeeded → fetch(upstream)` → 用 `response.body.pipeThrough(new TransformStream({transform}))` 逐块规范化 → 返回 `new Response(stream, {headers:{'content-type':'text/event-stream',...}})`。`request.signal` 触发即 `upstreamResp.body.cancel()` 清理。客户端断开不会因 DO 长驻而泄漏（DO 单实例，alarm 之外无后台线程）。

---

## 8. 风险与替代方案（无法在 Pages 直接实现的功能）

### 8.1 Cron Triggers ❌（Pages 不支持）

- **问题**：原 `scheduler.Run` 按整点（9/21/10/22/23/1）触发，Pages Functions 无 Cron Triggers。
- **替代 A（推荐）：DO `alarm()`**。`PoolDO` 在每次 alarm 触发后，重新 `setAlarm(nextHour)` 自调度到下一个整点。覆盖签到/旅行/活跃/保活/夜猫子/成长/余额刷新。**踩坑**：DO alarm 单次只排一个未来时刻；DO 实例被回收后再唤醒可能丢失 alarm（冷启动重新 `setAlarm` 即可）；alarm 处理函数内必须 `await` 所有上游调用，用 `ctx.waitUntil` 兜底。
- **替代 B（最小改动、最稳）：外部 cron → 调 Pages API**。保留一个最小辅助 Worker（或任意外部定时器 / GitHub Action / `cron-job.org`）每整点 `POST /panel/api/checkin_all` 等（带 api_key）。**改动最小**：完全复用现有面板接口，零 alarm 复杂度。

### 8.2 Queue 消费者 ❌（Pages 不直接支持）

- **问题**：原无 Queue 使用；若想用 Queue 做异步任务，Pages 无消费者。
- **替代**：任务中心全部用 **PoolDO 同步/半异步**（在 DO 内 `ctx.waitUntil` 跑完），无需 Queue。若坚持用 Queue：最小辅助 Worker 消费 + 写回 D1，但本项目不需要。

### 8.3 长任务 CPU 时间 ⚠️

- chat SSE 是 I/O 等待为主，无 CPU 瓶颈，可在 Functions/DO 内完成（DO HTTP 请求上限 30min 足够）。
- 「全量签到/余额刷新」若账号多、串行慢：迁入 DO 后分批 + `ctx.waitUntil`，避免阻塞响应（接口立即回 `{ok,started}`，结果看 `/status`/`/logs`）。

### 8.4 Upstash/Redis 镜像

- 原 `redisstore` 是可选的跨实例共享（粘性/快照）。**Pages 单 PoolDO 已天然共享状态**，可直接移除 Upstash 依赖；如仍需外部 Redis，可用 `fetch` 调 Upstash REST API（非必须）。

### 8.5 `device_token_file` 5 分钟缓存读取

- 原从宿主文件读设备 token。Pages 无文件 → 改为 Secrets/环境变量 `WB2A_DEVICE_TOKEN` 直配（或 KV 单行），去掉文件轮询。

---

## 9. 需你确认/补充的信息

1. **账号规模与并发**：单 PoolDO 实例能否覆盖你的账号数？（几十~几百个 OK；上千建议按 realm 拆两个 DO 实例 `cn`/`global`。）
2. **Upstash**：是否保留外部 Redis，还是纯原生 DO（推荐后者）？
3. **定时任务**：倾向 DO `alarm()` 自调度，还是外部 cron 调面板接口（最稳）？
4. **审计数据保留**：请求日志/用量落 D1 还是 R2？保留天数？
5. **是否已有 `auths/*.json` 与 `config.json` 实例**：提供后我可直接出导入脚本的字段校验；不提供也能按 `auth.Parse` 规范写通用导入器。

---

## 10. CLI 的云原生重构（P2 批次四）

Go 侧有 4 个独立二进制 + 3 个 shell 包装：`cmd/credit`、`cmd/login`、`cmd/signin`、`cmd/trial`，以及 `credit.sh` / `login.sh` / `signin.sh`。它们**不是 HTTP 路由**，是运维人员手动跑的一次性工具。

### 10.1 为什么不能逐字移植

原实现全部依赖同一个前提：**遍历本地 `auths/workbuddy-*.json` 目录**。

| Go 依赖 | Workers 下的现实 |
|---|---|
| `filepath.Glob("./auths/*.json")` | 账号池在 PoolDO 的存储里，没有目录 |
| `a.SaveAtomic()` 写回 token | 凭证在 D1 + Secrets，由 DO 持久化 |
| `os.Getenv("WB2A_AUTH_DIR")` | 无本地环境 |
| `time.Sleep(200ms)` 逐个串行 | 应走并发池 |
| `up.New()` 每进程独立客户端 | 全网关共享一个 PoolDO |

强行保留"遍历目录"只会得到一个永远空转的脚本。

### 10.2 重构方案：能力上移 + 瘦客户端

**能力上移为服务端批量操作**（账号池遍历在 Workers 内部完成），**CLI 退化为 HTTP 客户端**：

| Go CLI | 服务端能力 | HTTP 端点 |瘦客户端子命令 |
|---|---|---|---|
| `cmd/credit`（积分日报） | `services/credit.ts`<br>`fetchUserResourceSafe` / `aggregateCredits` | `GET /panel/api/credits`<br>`?pretty=1` 返回渲染行 | `wb2api credit` |
| `cmd/signin`（批量签到） | `services/checkin.ts`<br>`dailyCheckinRetry` / `signinOne` | `POST /panel/api/signin_report`<br>（**同步**返回逐账号表格） | `wb2api signin` |
| `cmd/trial`（领加油包） | `services/trial.ts`<br>`claimTrial` / `claimTrialFor` | `POST /panel/api/trial` | `wb2api trial` |
| `cmd/login`（OAuth） | 已有`routes/login.ts` | `POST /panel/api/login/start`<br>`GET /panel/api/login/poll` | `wb2api login` / `poll` |

客户端：`scripts/wb2api.mjs`（Node，无依赖），配`npm run cli`。认证走 `WB2A_URL` + `WB2A_API_KEY`。

### 10.3 三个刻意保留的行为差异

1. **`signin_report`是同步的，`checkin_all` 不是。**
   后者是定时任务入口（fire-and-forget，`waitUntil` 后台跑完看日志）；前者是 CLI 入口，**核心价值就是那张逐账号表格**（谁OK / 谁已签 / 谁 AUTH_INVALID），fire-and-forget 会把这个价值丢掉。并发压到 3（同 `/packages`），否则撞 Workers 请求时限。

2. **`TotalDosage` 下限只在日报口径生效。**
   Go `cmd/credit` 用上游 `TotalDosage` 作 `size` 下限、抬升后再用 `size-remain` 反推 `used` 下限；`UserResourceDetailedWithExpiry` 不做这步。`applyDosageFloor` 只在 `credit.ts` 里用，不动 `getCreditsDetailed` —— 后者是成本台账/选号权重的唯一数据源，随意改口径会让三者全部失真。

3. **`checkin.ts` 走瞬时重试，`upstream.dailyCheckin` 不走。**
   Go 侧 `DailyCheckin` 包在 `retryBillingTransient` 里（签到后偶发 500 会让账号整天漏签）。`upstream.dailyCheckin` 是裸调用，只被 OAuth 新号入池那条路径用（失败不影响任何既有状态，重试无意义）。故新模块单列，不去改既有函数。

### 10.4 过程中修掉的两个真bug

- **`src/services/ids.ts` 的模块顶层 `crypto.getRandomValues()`**：
  `const deriveSalt = newMessageID()` 在模块顶层执行，Workers 明令禁止全局作用域 I/O，导致 **Worker 启动即崩**（`Disallowed operation called within global scope`）。单元测试跑不出来（Node 无此限制），只有真机/本地 Pages 才暴露。已改惰性初始化。
- **`oauthState` 不检查 HTTP 状态与业务 code**：
  只解 `{code,msg,data}` 信封、不看 `res.ok`，上游 400 被吞成空 `state`，调用方只看到"没拿到 state"，与网络故障完全无法区分。同时缺 Go `commonHeaders` 的 `Origin`/`Referer`/`X-Requested-With` 与 CLI 专用 UA —— **缺 Origin 上游直接 400，登录功能 100% 失效**。两者都已修，补了 7 个回归测试。

---

> 确认上述架构与第 9 节决策后，我将按每批 ≤5 个文件输出完整可运行代码：`_worker.js`/`src/index.ts` → `config.ts`/`kv.ts`/`d1.ts` → `durable/account-pool.ts` → `services/{upstream,sse,oauth,proxy,classify}.ts` → `routes/*` → `alarms.ts` → `wrangler.toml`/`package.json` → `migrations/`+导入脚本 → `README.md` → 测试。
