# 纯网页部署手册（无需本地电脑）

全程只用浏览器：**Cloudflare Dashboard + GitHub 网页版**。不用装 Node / wrangler，不用敲命令。

---

## 0. 为什么有这份手册

三个 `wrangler.toml` 里现在写着 `REPLACE_WITH_*` 占位符。麻烦在于：

> **Pages 项目的 wrangler.toml 是配置的唯一真源**——只要它在，Cloudflare Dashboard 里的
> 绑定就变成只读、点不动的。所以资源 ID **没法靠网页点击填进去**，只能写进文件。

而写文件需要电脑。解决办法是让**构建机**去写：

```
构建流程：clone 仓库 → 跑 Build command（脚本把环境变量里的真 ID 写进 toml）→ 部署
```

ID 只存在于 Cloudflare 的环境变量里，**永远不进 GitHub 仓库**。你要做的只是网页上填几个变量。

---

## 方案选型

| 方案 | 要不要改文件 | 依赖 | 推荐度 |
|---|---|---|---|
| **A. Cloudflare Git 集成 + 构建环境变量** | 不用 | Cloudflare 原生 Builds | ⭐ 推荐 |
| B. GitHub Actions | 不用 | 需要带 `workflow` scope 的 token | 备选 |
| C. github.dev 手工改文件 | 要改 3 处 | 在线 VS Code | 兜底 |

三种**只能选一种**。

---

# 方案 A：Cloudflare Git 集成 + 构建环境变量（推荐）

## 第 1 步：创建 4 个 Cloudflare 资源

登录 <https://dash.cloudflare.com> → **Workers & Pages**。

### 1.1 D1 数据库

**Workers & Pages → D1 → Create database**
- 名称：`workbuddy2api`
- 建好点进去，**复制 Database ID**

> 表不用你建。Worker 第一次收到请求会**自动建表**（4 表 + 5 索引），幂等。
> 去 `/status` 看 `d1_schema` 字段确认。

### 1.2 KV 命名空间 ×2

**Workers & Pages → KV → Create a namespace**，建两个并**各复制 Namespace ID**：

| 命名空间名 | 存什么 |
|---|---|
| `wb2api-config` | 面板配置、模型白名单、调度开关 |
| `wb2api-cache` | 模型目录缓存、探测结果 |

### 1.3 R2 桶

**Workers & Pages → R2 → Create bucket**
- 名称：`workbuddy2api-logs`（代码里写死这个名字，别改）
- 想起别的名字就多配一个环境变量 `CF_R2_BUCKET`

---

## 第 2 步：先建账号池 Worker（必须第一个）

Pages 和定时 Worker 都要引用它的 `PoolDO`，它得先存在。

**Workers & Pages → Create → Worker → 选 "Connect to Git"（Workers Builds）**

| 字段 | 值 |
|---|---|
| Worker name | `workbuddy2api-pool` |
| Repository | `Linyueying/workbuddy2api-plus-cf` |
| Branch | `main` |
| Root directory | 留空 |
| **Build command** | `npm install && npm run build:pool && node scripts/fill-ids.mjs` |
| **Deploy command** | `npx wrangler deploy --config pool-worker/wrangler.toml` |

保存后去 **Settings → Build → Build variables and secrets**，加 3 个变量：

| 变量名 | 值 |
|---|---|
| `CF_KV_CONFIG_ID` | `wb2api-config` 的 ID |
| `CF_KV_CACHE_ID` | `wb2api-cache` 的 ID |
| `CF_D1_ID` | D1 的 Database ID |

> ⚠️ 是 **Settings → Build** 里的构建变量，**不是** Settings → Variables and Secrets（那是运行时）。
> `fill-ids.mjs` 在构建阶段跑，只认构建变量。

然后 **Retry deployment** 触发一次构建。看日志应有：

```
[fill-ids] pool-worker/wrangler.toml: 已写入
```

---

## 第 3 步：建定时作业 Worker

同样 **Create → Worker → Connect to Git**，连**同一个**仓库：

| 字段 | 值 |
|---|---|
| Worker name | `workbuddy2api-scheduler` |
| Repository | 同一个仓库 |
| Branch | `main` |
| Root directory | 留空 |
| **Build command** | `npm install && npm run build:scheduler && node scripts/fill-ids.mjs` |
| **Deploy command** | `npx wrangler deploy --config scheduler-worker/wrangler.toml` |

**Settings → Build → Build variables and secrets** 加同样的 3 个变量。

> ⚠️ **Deploy command 必须改**。默认 `npx wrangler deploy` 会读仓库根目录的 `wrangler.toml`
> ——那是 Pages 的配置，带 `pages_build_output_dir`，Worker 部署会直接失败。
>
> ⚠️ Workers Builds **不读** wrangler.toml 里的 Custom Builds 配置，
> 构建命令只能在这个页面手工填。

部署后到 **Triggers** 标签确认有两条 cron：
`0 * * * *`（整点作业）和 `30 17 * * *`（UTC，= 北京时间 01:30 归档日志）。

---

## 第 4 步：建 Pages 项目

**Workers & Pages → Create → Pages → Connect to Git**

| 字段 | 值 |
|---|---|
| Repository | `Linyueying/workbuddy2api-plus-cf` |
| Production branch | `main` |
| **Build command** | `npm install && npm run build && node scripts/fill-ids.mjs` |
| Build output directory | `dist` |
| Root directory | 留空 |

**Settings → Environment variables** 加同样 3 个变量（`CF_KV_CONFIG_ID` / `CF_KV_CACHE_ID` / `CF_D1_ID`）。

> 注意：Production 和 Preview 两套环境**要各加一遍**。

---

## 第 5 步：设置面板密钥 WB2A_API_KEY

密钥不能进仓库，这步必须手动。

### 5.1 Pages 项目

**Pages 项目 → Settings → Variables and Secrets → Add**
- Type：**Secret**
- Variable name：`WB2A_API_KEY`
- Value：你自己想一个强密码（面板登录 + `/v1/*` 接口鉴权都用它）
- 保存后去 **Deployments → Retry deployment**

### 5.2 账号池 Worker（同样要设一遍）

**`workbuddy2api-pool` → Settings → Variables and Secrets → Add**，同名同值。

> ⚠️ **Secret 按 Worker 独立存储**，Pages 设了不会同步过来，两边都要设。
> `workbuddy2api-scheduler` 不用设，它走内部调用、不鉴权。

---

## 第 6 步：验证

| 地址 | 期望 |
|---|---|
| `https://<项目>.pages.dev/panel` | 面板登录页能打开 |
| `https://<项目>.pages.dev/status` | JSON，看下面字段 |
| `https://<项目>.pages.dev/healthz` | `{"ok":true}` |

`/status` 重点看：

```jsonc
{
  "checks": {
    "d1_schema": { "status": "ok" },   // ok / created = 自动建表成功
    "pool":      { "status": "ok" },   // ok = 连上 PoolDO
    "kv_config": { "status": "ok" },
    "api_key":   { "status": "ok" }    // 第 5 步设了才是 ok
  }
}
```

不是 `ok` 的项会带 `hint` 字段写明怎么修。**第一次访问 `d1_schema` 可能是 `skipped`**——
自动建表异步触发，刷新一次即可。

---

# 方案 B：GitHub Actions

需要 **GitHub 网页版手动建** `.github/workflows/deploy.yml`（因为带 `workflow` scope 的
token 通常没有，git push 会拒绝）。

1. 仓库 → **Add file → Create new file**
2. 路径填 `.github/workflows/deploy.yml`
3. 内容复制 [`docs/deploy-workflow.yml.example`](./docs/deploy-workflow.yml.example)
4. Commit 到 `main`
5. **Settings → Secrets and variables → Actions** 加 5 个 Secret：
   `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`CF_KV_CONFIG_ID`、`CF_KV_CACHE_ID`、`CF_D1_ID`
6. **Actions → Deploy to Cloudflare → Run workflow**

`CLOUDFLARE_API_TOKEN` 在 <https://dash.cloudflare.com/profile/api-tokens> 创建
（用 **Edit Cloudflare Workers** 模板即可），Account ID 在 Workers & Pages 页面右侧栏复制。

⚠️ 用方案 B 就**不要**再开方案 A 的 Git 集成，否则一次 push 部署两遍。

---

# 方案 C：直接改文件（兜底）

如果方案 A 的构建日志显示 `[fill-ids] ... 已写入` 但部署仍报
`Couldn't find a D1 database / KV namespace`——说明 Cloudflare 在 build command
**之前**就解析了 wrangler.toml，那就只能把 ID 直接写进仓库。

1. 打开 <https://github.com/Linyueying/workbuddy2api-plus-cf>
2. 按键盘 **`.`（句号）** → 打开网页版 VS Code
3. 全局替换（Ctrl/Cmd + Shift + H），改 3 次：

| 搜索 | 替换为 |
|---|---|
| `REPLACE_WITH_CONFIG_KV_ID` | `wb2api-config` 的 ID |
| `REPLACE_WITH_CACHE_KV_ID` | `wb2api-cache` 的 ID |
| `REPLACE_WITH_D1_ID` | D1 的 Database ID |

4. 源代码管理图标 → 填 commit → **Commit & Push**

改完之后 Build command 里的 `node scripts/fill-ids.mjs` 可以去掉（留着也无害，脚本幂等）。

---

# 三个部署单元

| 单元 | 类型 | 为什么独立 |
|---|---|---|
| `workbuddy2api-pages` | Pages | 前端 + 全部 API。Pages 项目**不能自带 Durable Object**（不支持 `[[migrations]]`，而 DO 类必须靠它注册） |
| `workbuddy2api-pool` | Worker | 承载 `PoolDO`（账号池单实例顺序锁），拆出来给 Pages 引用 |
| `workbuddy2api-scheduler` | Worker | 定时任务。**Pages 没有 Cron Triggers**，只有 Workers 有 |

部署顺序：**pool → scheduler → pages**。

---

# 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| 构建日志 `缺少 3 个资源 ID` | 环境变量没配或配错页面 | 回 Settings → Build → Build variables 检查（不是 Variables and Secrets） |
| 面板能开但操作都「未授权」 | `WB2A_API_KEY` 没设 / 设完没重新部署 | 第 5 步，然后 Retry deployment |
| `/status` 里 `pool` 失败 | pool Worker 没部署成功，或名字不是 `workbuddy2api-pool` | 名字必须完全一致 |
| `d1_schema` 报 error | D1 ID 填错 | 重新复制 Database ID |
| `does not support "migrations"` | 有人往 Pages 的 `wrangler.toml` 加了 `[[migrations]]` | Pages 那份绝不能有这个字段 |
| `should specify a "script_name"` | Pages 的 DO 绑定缺 `script_name` | 文件里已写死 `workbuddy2api-pool`，别删 |
| 定时任务不跑 | scheduler Worker 没起来或 cron 被覆盖 | 检查 Triggers 标签有两条 cron |
| 三个环境都报找不到 namespace | Cloudflare 先解析配置再跑 build | 改用方案 C |

---

# 部署后初始化

1. 打开 `https://<项目>.pages.dev/panel`，用 `WB2A_API_KEY` 登录
2. 导入账号凭证（面板内导入入口）
3. 配上游地址、模型白名单、各定时任务开关
4. 配置存在 KV（`wb2api-config`）里，**重新部署不会丢**
