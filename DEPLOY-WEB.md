# 纯网页部署手册（无需本地电脑）

本手册全程只用浏览器：**Cloudflare Dashboard + GitHub 网页版**，手机或平板也能完成。
不需要安装 Node / wrangler，不需要敲任何命令。

---

## 0. 先选方案

| 方案 | 要不要改文件 | 要不要装软件 | 部署触发方式 | 适合谁 |
|---|---|---|---|---|
| **A. GitHub Actions**（推荐） | **完全不用** | 不用 | push 到 `main` 自动部署 | 没有电脑 / 不想碰命令行 |
| B. Cloudflare 原生 Git 集成 | 要改 3 个 ID | 不用 | push 到 `main` 自动部署 | 想直接用 Cloudflare Builds |

> 为什么 A 不用改文件？
> 三个 `wrangler.toml` 里的资源 ID 目前是 `REPLACE_WITH_*` 占位符。
> Actions 会在 CI 里用你填的 **GitHub Secrets** 自动替换掉它们再部署，
> 仓库里的文件保持原样，ID 也不会泄露进仓库。
>
> 反过来，方案 B 必须真实修改 `wrangler.toml`——因为 **Pages 项目的 wrangler.toml 是配置的唯一真源**，
> 只要它在，Dashboard 里的绑定就是只读、不可编辑的，网页点击填不进去。

两种方案**只能选一个**，同时开着会部署两遍。

---

# 方案 A：GitHub Actions（推荐）

## 第 1 步：在 Cloudflare 创建 4 个资源

打开 <https://dash.cloudflare.com> → 左侧 **Workers & Pages**（中文界面：Workers 和 Pages）。

### 1.1 D1 数据库（存用量、请求日志、子密钥）

**Workers & Pages → D1 → Create database**
- Database name：`workbuddy2api`
- 创建后点进数据库，**复制 Database ID**（一长串 UUID）

> 表不用你建。Worker 第一次收到请求会**自动建表**（4 张表 + 5 个索引），
> 幂等，重复执行不会出错。想确认就访问 `/status` 看 `d1_schema` 字段。

### 1.2 KV 命名空间 ×2

**Workers & Pages → KV → Create a namespace**，创建两个：

| 用途 | 建议命名 | 存什么 |
|---|---|---|
| 配置 | `wb2api-config` | 面板配置、模型白名单、调度开关 |
| 缓存 | `wb2api-cache` | 模型目录缓存、探测结果 |

两个都创建完，**分别复制各自的 Namespace ID**。

### 1.3 R2 桶（日志归档）

**Workers & Pages → R2 → Create bucket**
- Bucket name：`workbuddy2api-logs`（**必须叫这个名字**，代码里是写死的）

> 如果你想起别的名字，就多填一个 GitHub Secret `CF_R2_BUCKET`，CI 会自动替换。

---

## 第 2 步：创建 Cloudflare API Token

打开 <https://dash.cloudflare.com/profile/api-tokens> → **Create Token**

- 最简单：用模板 **Edit Cloudflare Workers**（编辑 Cloudflare Workers），下一步直接创建
- 想自定义就按下面勾：

| 范围 | 权限 |
|---|---|
| Account → Workers Scripts | Edit |
| Account → Workers KV Storage | Edit |
| Account → Workers R2 Storage | Edit |
| Account → D1 | Edit |
| Account → Cloudflare Pages | Edit |
| Account → Account Settings | Read |
| User → User Details | Read |

创建后**立刻复制 Token**（只显示这一次，关掉就找不回来了）。

## 第 3 步：拿 Account ID

**Workers & Pages** 页面右侧栏就有 **Account ID**，点一下复制。
（也可以在任意站点的「概述」页右下角找到。）

---

## 第 4 步：在 GitHub 网页版填 5 个 Secret

打开 <https://github.com/Linyueying/workbuddy2api-plus-cf>
→ **Settings → Secrets and variables → Actions → New repository secret**

一个一个加，加完是这 5 个：

| Secret 名 | 值（从哪来） |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 第 2 步的 Token |
| `CLOUDFLARE_ACCOUNT_ID` | 第 3 步的 Account ID |
| `CF_KV_CONFIG_ID` | 第 1.2 步 `wb2api-config` 的 ID |
| `CF_KV_CACHE_ID` | 第 1.2 步 `wb2api-cache` 的 ID |
| `CF_D1_ID` | 第 1.1 步 D1 的 Database ID |

可选项（一般不填）：

| Secret 名 | 说明 |
|---|---|
| `CF_R2_BUCKET` | 换 R2 桶名时才填 |
| `CF_PAGES_PROJECT` | 换 Pages 项目名时才填，默认 `workbuddy2api-pages` |

> Secret 保存后**只能覆盖、不能查看**，填错了重新填一次即可。

---

## 第 5 步：触发第一次部署

**Actions** 标签页 → 左侧选 **Deploy to Cloudflare** → 右上角 **Run workflow** → 选 `main` → **Run workflow**。

（之后每次 push 到 `main` 会自动跑，不用再手动点。）

等 2–4 分钟，三个作业依次跑完：

```
1/3 部署账号池 Worker（PoolDO 宿主）
2/3 部署定时作业 Worker（Cron Triggers）
3/3 部署 Pages（前端 + API）
```

**顺序不能乱**：Pages 和定时 Worker 都要引用账号池 Worker 里的 `PoolDO`，它必须先存在。
CI 里已经固定了顺序，你不用管。

任何一步红了，点开看日志。最常见的两类错误：

| 报错 | 原因 | 处理 |
|---|---|---|
| `缺少 Secret: XXX` | 第 4 步漏填 | 补齐后重新 Run workflow |
| `Couldn't find a D1 database / KV namespace` | ID 复制错了 | 回 Cloudflare 重新复制，覆盖 Secret |

---

## 第 6 步：设置面板登录密钥（WB2A_API_KEY）

这是唯一还需要你手动做的一步，因为密钥不能进仓库。

### 6.1 Pages 项目

**Workers & Pages → 点你的 Pages 项目 `workbuddy2api-pages` → Settings → Variables and Secrets → Add**

- Type：**Secret**
- Variable name：`WB2A_API_KEY`
- Value：你自己想一个强密码（面板登录 + `/v1/*` 接口鉴权都用它）
- 记得 **Save**，然后在 Deployments 里 **Retry deployment** 让它生效

### 6.2 账号池 Worker（同样要设一遍）

**Workers & Pages → `workbuddy2api-pool` → Settings → Variables and Secrets → Add**
同样的变量名和值。

> ⚠️ **Secret 是按 Worker 独立存的**，Pages 设了不会自动同步到 Worker，必须两边各设一次。
> `workbuddy2api-scheduler` 不需要，它走内部调用、不鉴权。

---

## 第 7 步：验证

打开这几个地址（把 `<项目>` 换成你的 Pages 域名，形如 `workbuddy2api-pages.pages.dev`）：

| 地址 | 期望结果 |
|---|---|
| `https://<项目>.pages.dev/panel` | 面板登录页能打开 |
| `https://<项目>.pages.dev/status` | JSON，看下面几个字段 |
| `https://<项目>.pages.dev/healthz` | `{"ok":true}` |

`/status` 里重点看：

```jsonc
{
  "checks": {
    "d1_schema": { "status": "ok" },        // ok / created = 建表成功
    "pool":     { "status": "ok" },          // ok = 连上 PoolDO 了
    "kv_config":{ "status": "ok" },
    "api_key":  { "status": "ok" }           // 第 6 步设了才是 ok
  }
}
```

任何一项不是 `ok`，`/status` 里会带 `hint` 字段写明怎么修。

**第一次访问时 `d1_schema` 可能还是 `skipped`** —— 自动建表是异步触发的，刷新一次即可。

---

# 方案 B：Cloudflare 原生 Git 集成

如果你更想用 Cloudflare 自己的 Builds（不想用 GitHub Actions），走这里。
**前提：先把 `.github/workflows/deploy.yml` 删掉**，否则会部署两遍。

## B1. 在网页上改 3 个 ID（用 github.dev，在线 VS Code）

1. 打开仓库首页 <https://github.com/Linyueying/workbuddy2api-plus-cf>
2. 按键盘上的 **`.`（句号）** → 打开网页版 VS Code（github.dev）
3. 左侧搜索框搜 `REPLACE_WITH`，会命中 7 处、分布在 3 个文件
4. 用**全局替换**（Ctrl/Cmd + Shift + H）改 3 次：

| 搜索 | 替换为 |
|---|---|
| `REPLACE_WITH_CONFIG_KV_ID` | `wb2api-config` 的 Namespace ID |
| `REPLACE_WITH_CACHE_KV_ID` | `wb2api-cache` 的 Namespace ID |
| `REPLACE_WITH_D1_ID` | D1 的 Database ID |

5. 左侧源代码管理图标 → 填 commit 信息 → **Commit & Push**（直接推到 `main`）

> 手机上 github.dev 体验一般，但能用；也可以在文件页面点铅笔图标逐个改。

## B2. 建 Pages 项目并连仓库

**Workers & Pages → Create → Pages → Connect to Git**
- 仓库：`Linyueying/workbuddy2api-plus-cf`
- Production branch：`main`
- Build command：`npm run build`
- Build output directory：`dist`
- Root directory：留空

> ⚠️ 不要动 "Deploy command"，Pages 没有这个字段。

## B3. 建两个 Worker 并连**同一个**仓库

**Workers & Pages → Create → Worker → Connect to Git**（ Workers Builds）

两个 Worker 项目都连同一个仓库，靠 Deploy command 区分：

**① 账号池 Worker**（先建这个）

| 字段 | 值 |
|---|---|
| Worker name | `workbuddy2api-pool` |
| Repository | 同一个仓库 |
| Branch | `main` |
| Root directory | 留空 |
| Build command | `npm install && npm run build:pool` |
| **Deploy command** | `npx wrangler deploy --config pool-worker/wrangler.toml` |

**② 定时作业 Worker**

| 字段 | 值 |
|---|---|
| Worker name | `workbuddy2api-scheduler` |
| Repository | 同一个仓库 |
| Branch | `main` |
| Root directory | 留空 |
| Build command | `npm install && npm run build:scheduler` |
| **Deploy command** | `npx wrangler deploy --config scheduler-worker/wrangler.toml` |

> ⚠️ **Deploy command 必须改**。默认值 `npx wrangler deploy` 会去读仓库根目录的
> `wrangler.toml`——那是 Pages 的配置，带 `pages_build_output_dir`，Worker 部署会直接失败。
>
> ⚠️ Workers Builds **不会读** wrangler.toml 里的 Custom Builds 配置，
> 构建命令只能在这个 Settings > Build 页面里手工填。

## B4. 设置密钥

同方案 A 的第 6 步，一个字不差。

---

# 三个部署单元都是干什么的

| 部署单元 | 类型 | 为什么独立 |
|---|---|---|
| `workbuddy2api-pages` | Pages | 前端静态资源 + 全部 API。**Pages 项目不能自带 Durable Object**（官方限制：不支持 `[[migrations]]`，而 DO 类必须靠它注册） |
| `workbuddy2api-pool` | Worker | 承载 `PoolDO`（账号池单实例顺序锁），专门拆出来给 Pages 引用 |
| `workbuddy2api-scheduler` | Worker | 定时任务。**Pages 没有 Cron Triggers**，只有 Workers 有 |

---

# 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| 面板能开，但一切操作都报「未授权」 | `WB2A_API_KEY` 没设或设完没重新部署 | 按第 6 步设，然后 Retry deployment |
| `/status` 里 `pool` 失败 | 账号池 Worker 没部署，或名字不是 `workbuddy2api-pool` | 检查 Worker 是否存在、名字是否完全一致 |
| `d1_schema` 报 error | D1 ID 填错，或数据库被删了 | 重新复制 Database ID |
| 部署日志出现 `does not support "migrations"` | 有人往 Pages 的 `wrangler.toml` 里加了 `[[migrations]]` | 加回去会炸，Pages 那份绝不能写这个字段 |
| 部署日志出现 `should specify a "script_name"` | Pages 的 DO 绑定缺 `script_name` | 该文件里已写死为 `workbuddy2api-pool`，别删 |
| 定时任务不跑 | scheduler Worker 没部署成功，或 crons 被覆盖 | 到该 Worker 的 **Triggers** 标签确认有两条：`0 * * * *`、`30 17 * * *` |

---

# 部署后的初始化

1. 打开 `https://<项目>.pages.dev/panel`，用第 6 步设的 `WB2A_API_KEY` 登录
2. 导入账号凭证（面板内的导入入口，或稍后配好 CLI 再用 `scripts/import-auths.mjs`）
3. 配置上游地址、模型白名单、各定时任务开关
4. 全部配置都存在 KV（`wb2api-config`）里，**重新部署不会丢**
