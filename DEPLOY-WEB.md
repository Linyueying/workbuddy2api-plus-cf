# 纯网页部署手册（无需本地电脑）

全程只用浏览器：**Cloudflare Dashboard + GitHub 网页版**。不用装 Node / wrangler，不用敲命令。

> 第一次用 Cloudflare、想要手把手版本 → [DEPLOY-NOVICE.md](./DEPLOY-NOVICE.md)

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
K-Vault-Next 没有这行，所以它的绑定全归 Dashboard 管；本项目也已经把这一行去掉了。

**所以现在**：Pages 侧 5 个绑定全在 Dashboard 点；Worker 侧的 ID 由构建机注入。

---

## 部署顺序

```
① workbuddy2api-pool    ← 必须先有它，Pages 的 DO 下拉才选得到 PoolDO
② workbuddy2api-pages   ← 引用 ①
```

只有两个部署单元。定时作业（cron）已合并进 ①，不需要单独部署。

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
> R2 通常要求账号绑支付方式；不想绑就跳过，只影响日志归档。

---

## 第 2 步：部署 Worker ①（账号池 + 定时作业）

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

### 确认定时生效

部署成功后 → **Triggers** 标签，应该看到两条 cron：

```
0 * * * *        ← 每小时整点跑作业
30 17 * * *      ← UTC 17:30（= 北京 01:30）归档日志
```

> ⚠️ **Deploy command 必须改**。默认 `npx wrangler deploy` 会读仓库根目录的
> `wrangler.toml`——那是 Pages 的配置，Worker 部署会失败。

---

## 第 3 步：建 Pages 项目 ②

**Workers & Pages → Create → Pages → Connect to Git**

| 字段 | 值 |
|---|---|
| Repository | `Linyueying/workbuddy2api-plus-cf` |
| Production branch | `main` |
| Framework preset | `None` |
| Root directory | 留空 |
| **Build command** | `npm run build` |
| **Build output directory** | `dist` |

> 不要加 `node scripts/fill-ids.mjs`——Pages 的绑定不在文件里，用不上。

---

## 第 4 步：Pages 配 5 个绑定

**Pages 项目 → Settings → Functions**，逐个 Add binding：

| # | 类别 | Variable name | 选什么 |
|---|---|---|---|
| 1 | KV namespace bindings | `WB2A_CONFIG` | `wb2api-config` |
| 2 | KV namespace bindings | `WB2A_CACHE` | `wb2api-cache` |
| 3 | D1 database bindings | `WB2A_DB` | `workbuddy2api` |
| 4 | R2 bucket bindings | `WB2A_LOGS` | `workbuddy2api-logs` |
| 5 | **Durable Object bindings** | `POOL` | 下拉选 `PoolDO` |

⚠️ 四个坑：

1. **变量名一字不差**，写错不报错、只是功能静默失效
2. **第 5 项依赖第 2 步**——pool worker 没部署成功，下拉里就没有 `PoolDO`
3. **Production 与 Preview 两套环境各配一遍**
4. **改完必须 Retry deployment**

---

## 第 5 步：兼容标志

**Pages 项目 → Settings → Functions → Compatibility flags**

- Compatibility date：`2024-11-01` 或更新
- Compatibility flags：`nodejs_compat`

改完 Retry deployment。

---

## 第 6 步：设置密钥 WB2A_API_KEY

**Pages 项目 → Settings → Variables and Secrets → Add**：Type 选 **Secret**，
变量名 `WB2A_API_KEY`，值自己想一个强密码。

**`workbuddy2api-pool` → Settings → Variables and Secrets → Add**，同名同值**再设一遍**。

> ⚠️ Secret 按 Worker 独立存储，Pages 设了不会同步过来，两边都要设。
> 设完两边都要 Retry deployment。

---

## 第 7 步：验证

| 地址 | 期望 |
|---|---|
| `https://<项目>.pages.dev/panel` | 面板登录页能打开 |
| `https://<项目>.pages.dev/status` | JSON，看下面字段 |
| `https://<项目>.pages.dev/healthz` | `{"ok":true}` |

`/status` 的 `checks` 里：`d1_schema`、`pool`、`kv_config`、`api_key` 都应 `ok`。
失败项会带 `hint` 字段写明怎么修。第一次访问 `d1_schema` 可能是 `skipped`——
自动建表异步触发，刷新一次即可。

---

## 两个部署单元

| 单元 | 类型 | 职责 |
|---|---|---|
| `workbuddy2api-pool` | Worker | ① 承载 `PoolDO`（Pages 不能自带 DO）② 跑定时作业（Pages 没有 Cron） |
| `workbuddy2api-pages` | Pages | 前端 + 全部 API |

两者合在一个 Worker 里是合法的：一个 Worker 可以同时导出 DO 类与 `scheduled()`，
也可以同时声明 `[[migrations]]` 与 `[triggers] crons`。合并后少一个部署单元，
定时作业访问 PoolDO 也从跨 Worker 远程调用变成本地绑定。

---

## 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| DO 下拉里没有 `PoolDO` | pool worker 没部署成功 | 先修好第 2 步 |
| 面板能开但操作「未授权」 | `WB2A_API_KEY` 没设 / 设完没重新部署 | 第 6 步 + Retry |
| `/status` 里 `pool` 失败 | DO 绑定名不是 `POOL` 或选错 namespace | 第 4 步第 5 项 |
| `d1_schema` 报 error | D1 绑定没配或选错库 | 第 4 步第 3 项 |
| 构建报「缺少 3 个资源 ID」 | 变量填到了 Variables and Secrets 而不是 Build | 第 2 步 |
| Worker 部署报 Pages 相关错误 | Deploy command 用了默认值 | 第 2 步 |
| 定时任务从不执行 | Triggers 里没有那两条 cron | 第 2 步 |
| 页面 404 | Build output directory 不是 `dist` | 第 3 步 |
| 页面一直转圈 | 缺 `nodejs_compat` | 第 5 步 |

---

## 回退方案

如果 Dashboard 的绑定仍是只读（说明 Cloudflare 把整个文件都当真源了），
就把绑定写回文件：GitHub 仓库页面按 **`.`** 打开网页版 VS Code，把
`wrangler.toml` 里注释掉的绑定段取消注释，全局替换 3 个 ID，Commit & Push。
或者用 `npm run fill:ids` 从环境变量注入（幂等）。
