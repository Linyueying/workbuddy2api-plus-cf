# 纯网页部署手册（无需本地电脑）

全程只用浏览器：**Cloudflare Dashboard + GitHub 网页版**。不用装 Node / wrangler，不用敲命令。

---

## 0. 为什么可以一个文件都不改

同类项目 [K-Vault-Next](https://github.com/Linyueying/K-Vault-Next) 能做到「CF 后台设几个变量就完事」，
它自己的 `wrangler.toml` 里把原因写得很直白：

> 本项目原本是「纯 Pages 项目，没有任何 wrangler 配置」——KV 和 R2 都是在
> Cloudflare 后台 Settings → Functions 里绑定的。
> KV：变量名 img_url → Pages 后台绑定（**本文件写不了 Pages 的 binding**）

背后的 Cloudflare 规则是：

> **Pages 项目一旦有 wrangler.toml 且被识别为生产配置，Dashboard 里对应的字段就变成只读、点不动。**

而「被识别为生产配置」的触发条件就是文件里那行 **`pages_build_output_dir`**。
K-Vault-Next 没有这行，所以它的绑定全归 Dashboard 管；我之前的版本有，所以只能改文件。

**本项目的改动**：把 Pages 的 `wrangler.toml` 里那行去掉，绑定段也全部移除。
现在 Pages 侧**零配置**，5 个绑定全在 Dashboard 点。

> 两个 Worker（`pool` / `scheduler`）不是 Pages，不受这条规则约束，
> 它们仍走「配置文件 + 构建环境变量注入 ID」的路子——见第 2、3 步。

---

## 部署顺序

```
① workbuddy2api-pool       ← 必须先有它，Pages 的 DO 下拉才选得到 PoolDO
② workbuddy2api-scheduler
③ workbuddy2api-pages      ← 最后，因为它要引用 ①
```

---

## 第 1 步：创建 4 个 Cloudflare 资源

登录 <https://dash.cloudflare.com> → **Workers & Pages**。

| 类型 | 路径 | 名称 | 记下什么 |
|---|---|---|---|
| D1 | Workers & Pages → D1 → Create | `workbuddy2api` | Database ID |
| KV | Workers & Pages → KV → Create | `wb2api-config` | Namespace ID |
| KV | Workers & Pages → KV → Create | `wb2api-cache` | Namespace ID |
| R2 | Workers & Pages → R2 → Create bucket | `workbuddy2api-logs` | ——（名字固定） |

> 表不用你建。Worker 第一次收到请求会**自动建表**（4 表 + 5 索引），幂等。

---

## 第 2 步：部署账号池 Worker（①）

**Workers & Pages → Create → Worker → Connect to Git**

| 字段 | 值 |
|---|---|
| Worker name | `workbuddy2api-pool` |
| Repository | `Linyueying/workbuddy2api-plus-cf` |
| Branch | `main` |
| Root directory | 留空 |
| **Build command** | `npm install && npm run build:pool && node scripts/fill-ids.mjs` |
| **Deploy command** | `npx wrangler deploy --config pool-worker/wrangler.toml` |

然后 **Settings → Build → Build variables and secrets** 加 3 个：

| 变量名 | 值 |
|---|---|
| `CF_KV_CONFIG_ID` | `wb2api-config` 的 ID |
| `CF_KV_CACHE_ID` | `wb2api-cache` 的 ID |
| `CF_D1_ID` | D1 的 Database ID |

> ⚠️ 是 **Settings → Build** 里的构建变量，**不是** Settings → Variables and Secrets
> （那是运行时）。`fill-ids.mjs` 在构建阶段跑，只认构建变量。

构建日志里应看到 `[fill-ids] pool-worker/wrangler.toml: 已写入`。

---

## 第 3 步：部署定时作业 Worker（②）

同样 **Create → Worker → Connect to Git**，连**同一个**仓库：

| 字段 | 值 |
|---|---|
| Worker name | `workbuddy2api-scheduler` |
| Repository | 同一个仓库 |
| Branch | `main` |
| Root directory | 留空 |
| **Build command** | `npm install && npm run build:scheduler && node scripts/fill-ids.mjs` |
| **Deploy command** | `npx wrangler deploy --config scheduler-worker/wrangler.toml` |

同样加那 3 个构建变量。

> ⚠️ **Deploy command 必须改**。默认 `npx wrangler deploy` 会读仓库根目录的
> `wrangler.toml`——那是 Pages 的配置，Worker 部署会失败。

部署后到 **Triggers** 标签确认两条 cron：`0 * * * *`、`30 17 * * *`。

---

## 第 4 步：建 Pages 项目（③）

**Workers & Pages → Create → Pages → Connect to Git**

| 字段 | 值 |
|---|---|
| Repository | `Linyueying/workbuddy2api-plus-cf` |
| Production branch | `main` |
| Framework preset | `None` |
| Root directory | 留空 |
| **Build command** | `npm run build` |
| **Build output directory** | `dist` |

> 注意：这里**不要**加 `node scripts/fill-ids.mjs`——Pages 的绑定不在文件里，不需要它。
> 加也无害（脚本幂等），但没必要。

---

## 第 5 步：Pages 配 5 个绑定（原来的「改文件」变成「点 5 下」）

**Pages 项目 → Settings → Functions**，逐个 Add binding：

| 类别 | Variable name | 选什么 |
|---|---|---|
| KV namespace bindings | `WB2A_CONFIG` | `wb2api-config` |
| KV namespace bindings | `WB2A_CACHE` | `wb2api-cache` |
| D1 database bindings | `WB2A_DB` | `workbuddy2api` |
| R2 bucket bindings | `WB2A_LOGS` | `workbuddy2api-logs` |
| **Durable Object bindings** | `POOL` | 下拉里选 `PoolDO`（由第 2 步的 pool worker 注册） |

**变量名必须一字不差**，代码里就是按这些名字读的。

⚠️ 三个坑：

1. **DO 绑定依赖第 2 步**。pool worker 没部署成功，下拉里就没有 `PoolDO`。
2. **Production 与 Preview 两套环境各配一遍**（页面上有切换），只配一套的话预览分支会缺绑定。
3. **改完必须重新部署**：Deployments → 最新部署 → **Retry deployment**。

---

## 第 6 步：兼容标志（一行）

**Pages 项目 → Settings → Functions → Compatibility flags**

- Compatibility date：`2024-11-01` 或更新
- Compatibility flags：填 `nodejs_compat`

> 代码用 `process.env` 读运行时覆盖变量，需要这个标志。
> 没填的话 `/panel/api/*` 可能在读取配置时报错。

---

## 第 7 步：设置面板密钥 WB2A_API_KEY

密钥不能进仓库，这步必须手动。

**Pages 项目 → Settings → Variables and Secrets → Add**
- Type：**Secret**
- Variable name：`WB2A_API_KEY`
- Value：你自己想一个强密码（面板登录 + `/v1/*` 接口鉴权都用它）

**`workbuddy2api-pool` → Settings → Variables and Secrets → Add**，同名同值再设一遍。

> ⚠️ **Secret 按 Worker 独立存储**，Pages 设了不会同步过来，两边都要设。
> `workbuddy2api-scheduler` 不用设，它走内部调用、不鉴权。

设完两边都要 **Retry deployment**。

---

## 第 8 步：验证

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
    "pool":      { "status": "ok" },   // ok = DO 绑定生效
    "kv_config": { "status": "ok" },
    "api_key":   { "status": "ok" }    // 第 7 步设了才是 ok
  }
}
```

不是 `ok` 的项会带 `hint` 字段写明怎么修。**第一次访问 `d1_schema` 可能是 `skipped`**——
自动建表异步触发，刷新一次即可。

---

## 三个部署单元都是干什么的

| 单元 | 类型 | 为什么独立 |
|---|---|---|
| `workbuddy2api-pages` | Pages | 前端 + 全部 API。Pages **不能自带 Durable Object**（不支持 `[[migrations]]`，而 DO 类必须靠它注册） |
| `workbuddy2api-pool` | Worker | 承载 `PoolDO`（账号池单实例顺序锁） |
| `workbuddy2api-scheduler` | Worker | 定时任务。**Pages 没有 Cron Triggers**，只有 Workers 有 |

---

## 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| DO 下拉里没有 `PoolDO` | pool worker 没部署成功 | 先修好第 2 步，再回来配绑定 |
| 面板能开但操作都「未授权」 | `WB2A_API_KEY` 没设 / 设完没重新部署 | 第 7 步 + Retry deployment |
| `/status` 里 `pool` 失败 | DO 绑定名不是 `POOL`，或选错了 namespace | 检查绑定变量名 |
| `d1_schema` 报 error | D1 绑定没配或选错库 | Settings → Functions → D1 database bindings |
| Worker 构建报 `缺少 3 个资源 ID` | 构建变量配错页面 | Settings → **Build** → Build variables，不是 Variables and Secrets |
| Worker 部署报 Pages 相关错误 | Deploy command 用了默认值 | 改成带 `--config` 的那条 |
| 定时任务不跑 | scheduler 没起来或 cron 被覆盖 | 检查 Triggers 标签有两条 cron |

---

## 回退方案：如果 Dashboard 的绑定仍是只读

第 5 步依赖 Cloudflare「文件里没声明的字段可以在 Dashboard 编辑」这条行为。
万一你看到的是禁用状态，说明它把整个文件都当真源了——那就把绑定写回文件：

1. GitHub 仓库页面按 **`.`** 键 → 打开网页版 VS Code（github.dev）
2. 把 `wrangler.toml` 里注释掉的绑定段取消注释
3. 全局替换 3 个 ID：`REPLACE_WITH_CONFIG_KV_ID` / `REPLACE_WITH_CACHE_KV_ID` / `REPLACE_WITH_D1_ID`
4. Commit & Push

或者更省事——把 `pages_build_output_dir = "dist"` 加回 `wrangler.toml` 顶部的同时，
在 Worker 的 Build command 里保留 `node scripts/fill-ids.mjs`（它会自动填好那 3 个 ID）。

---

## 部署后初始化

1. 打开 `https://<项目>.pages.dev/panel`，用 `WB2A_API_KEY` 登录
2. 导入账号凭证（面板内导入入口）
3. 配上游地址、模型白名单、各定时任务开关
4. 配置存在 KV（`wb2api-config`）里，**重新部署不会丢**
