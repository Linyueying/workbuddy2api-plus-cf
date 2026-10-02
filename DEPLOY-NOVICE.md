# 新手部署教学 · 从零到能用

这份文档假设你：**没装过任何开发工具、手上只有手机或平板、Cloudflare 也是第一次用**。
全程浏览器操作，照着点就行。预计 **25–30 分钟**。

> 想看精简版（有经验、只要命令和参数）→ [DEPLOY-WEB.md](./DEPLOY-WEB.md)

---

## 第 0 章 · 先搞懂要部署几个东西

这个项目不是一个，是**两个**：

```
   ┌──────────────────────────┐
   │ ① workbuddy2api-engine      │  ← 后台支撑，你不直接访问它
   │   （Worker）              │
   │   · 管账号（内部锁，防抢号）│
   │   · 定时干活（签到、保活…） │
   └──────────┬───────────────┘
              │ 被 ② 引用
              ▼
   ┌──────────────────────────┐
   │ ② workbuddy2api-pages     │  ← 你每天打开的那个网页 + 所有接口
   │   （Pages）               │
   └──────────────────────────┘
```

**为什么要两个？** 因为 Cloudflare 的 Pages 有两个硬限制：

1. Pages **不能自带** Durable Object（就是那个防止并发抢号的锁）→ 只能单独放一个 Worker
2. Pages **没有** Cron Triggers（定时触发）→ 定时作业也只能放 Worker

**这两件事合在同一个 Worker 里**（就是 ①），因为一个 Worker 完全可以同时干这两件事，
没必要拆成两个让你多部署一次。

**部署顺序必须是 ① → ②**，因为 ② 要引用 ①。顺序错了会配不上，得回头重来。

---

## 第 1 章 · 准备（5 分钟）

### 1.1 需要的账号

| 账号 | 用途 | 要不要钱 |
|---|---|---|
| Cloudflare | 托管全部服务 | 免费额度够用 |
| GitHub | 代码仓库（已经有了） | 免费 |

### 1.2 ⚠️ 一个可能卡住你的点：R2 要绑支付方式

Cloudflare 的 R2 存储（用来归档请求日志）**通常要求账号绑定信用卡或 PayPal** 才能创建桶。
免费额度内不扣钱，但验证身份这一步跳不过。

- **愿意绑** → 正常走第 2.3 节
- **不想绑** → 跳过 R2。后果只是「请求日志归档」用不了，**其他功能全部正常**。
  后面第 5 章的 `WB2A_LOGS` 绑定也一并跳过即可。

### 1.3 先建一张抄写表

后面会产生一长串 ID，手机上反复切换页面复制很痛苦。**先在备忘录里建一张表**，
拿到一个就填一个：

```
D1 数据库 ID        ：_________________________________
KV wb2api-config ID ：_________________________________
KV wb2api-cache ID  ：_________________________________
面板密钥（自己想）  ：_________________________________
Pages 网址          ：_________________________________
```

后面凡是需要填这些的地方，直接从这张表复制。

---

## 第 2 章 · 创建 4 个资源（8 分钟）

打开 <https://dash.cloudflare.com> 登录，点左侧 **Workers & Pages**。

### 2.1 D1 数据库（存用量、日志、子密钥）

1. 左侧菜单 **Workers & Pages → D1**
2. 右上角 **Create database**（创建数据库）
3. Database name 填：`workbuddy2api`
4. 点 **Create**
5. 点进刚建的数据库，**复制 Database ID** → 填进抄写表

> ✅ 检查点：抄写表里「D1 数据库 ID」有值了。
>
> ❌ 找不到 Database ID？它在数据库详情页的概览区，一串 32 位字母数字，右边有复制图标。

### 2.2 KV 命名空间 ×2（存配置和缓存）

1. **Workers & Pages → KV**
2. **Create a namespace**（创建命名空间）
3. 名称填 `wb2api-config` → Create → **复制它的 ID** 到抄写表
4. 再点 **Create a namespace**，名称填 `wb2api-cache` → Create → **复制 ID**

> 这两个不能合并，config 存配置、cache 存模型缓存，代码里各读各的。

### 2.3 R2 桶（日志归档，可选）

1. **Workers & Pages → R2**
2. **Create bucket**（创建存储桶）
3. 名称填 `workbuddy2api-logs` —— **必须一字不差**，代码里写死了
4. Create

> 名字写错了怎么办？删掉重建一个对的。这桶是空的，删了没损失。

### 2.4 完成检查

```
✅ D1 数据库 ID 已抄
✅ wb2api-config 的 ID 已抄
✅ wb2api-cache 的 ID 已抄
⬜ R2 桶（可选，跳过也行）
```

---

## 第 3 章 · 部署 Worker ①（10 分钟）

这一个 Worker 干两件事：**管账号** + **跑定时任务**。

### 3.1 创建并连仓库

1. **Workers & Pages** → 右上角 **Create**（创建）
2. 找到带 Git 图标的入口，名叫 **Connect to Git** 或 **Import from Git repository**
   （如果只看到「Create a Worker」空白模板，先进去创建，然后到 **Settings → Build** 里连仓库）
3. 授权 GitHub，选中仓库 `Linyueying/workbuddy2api-plus-cf`
4. 按下面填，**一个字都别错**：

| 字段 | 填什么 |
|---|---|
| Worker name | `workbuddy2api-engine` |
| Branch（分支） | `main` |
| Root directory | 留空 |
| **Build command** | `npm install && npm run build:engine && node scripts/fill-ids.mjs` |
| **Deploy command** | `npx wrangler deploy --config engine-worker/wrangler.toml` |

5. 保存

> ⚠️ **Deploy command 一定不能留默认**。默认的 `npx wrangler deploy` 会去读仓库根目录
> 的配置文件，而那是 Pages 用的，Worker 部署会直接失败。

### 3.2 填 3 个构建变量

1. 进这个 Worker → **Settings（设置） → Build**
2. 找到 **Build variables and secrets** → 加 3 个：

| 变量名 | 值 |
|---|---|
| `CF_KV_CONFIG_ID` | 抄写表里的 wb2api-config ID |
| `CF_KV_CACHE_ID` | 抄写表里的 wb2api-cache ID |
| `CF_D1_ID` | 抄写表里的 D1 ID |

> ⚠️ 是 **Settings → Build** 这一页，不是 **Settings → Variables and Secrets**。
> 填错页面构建脚本读不到，会报「缺少 3 个资源 ID」。

### 3.3 触发部署并确认

- 到 **Deployments**（部署）标签，点 **Retry deployment**（重试部署）或 **Create deployment**
- 等 2–4 分钟，状态变绿 ✅
- 点开日志，往下翻应该能看到一行：

```
[fill-ids] engine-worker/wrangler.toml: 已写入
```

### 3.4 确认定时任务挂上了

进这个 Worker → **Triggers**（触发器）标签，应该看到两条：

```
0 * * * *        ← 每小时整点跑一次作业
30 17 * * *      ← UTC 17:30（= 北京时间凌晨 1:30）归档日志
```

> ✅ 检查点：状态绿色 + 日志有 `已写入` + Triggers 里有两条 cron。**三个都要有**。
>
> ❌ 报 `缺少 Secret: CF_XXX` → 变量没保存成功，回 3.2 重填后重试部署。
> ❌ 报 `Couldn't find a D1 database` → ID 复制错了，回 2.1 重新复制。
> ❌ Triggers 是空的 → Deploy command 没带 `--config`，回 3.1 检查。

---

## 第 4 章 · 部署 Pages ②（5 分钟）

### 4.1 创建 Pages 项目

1. **Workers & Pages** → **Create**（创建）→ **Pages** 标签 → **Connect to Git**
2. 选中同一个仓库 `Linyueying/workbuddy2api-plus-cf`
3. 按下面填：

| 字段 | 填什么 |
|---|---|
| Project name | `workbuddy2api-pages` |
| Production branch | `main` |
| Framework preset | `None` |
| Root directory | 留空 |
| **Build command** | `npm run build` |
| **Build output directory** | `dist` |

4. 点 **Save and Deploy**（保存并部署）

第一次构建会花 3–5 分钟。之后每次推送代码都会自动重新部署。

> 成功后你会拿到一个网址：`https://workbuddy2api-pages.pages.dev`
> **把它记到抄写表里**，后面一直要用。

---

## 第 5 章 · 给 Pages 配 5 个绑定（8 分钟）

这一步是「把第 2 章创建的资源接到网页上」。

**Pages 项目 → Settings（设置） → Functions**，找到绑定区，逐个 Add：

| # | 类别 | Variable name | 选什么 |
|---|---|---|---|
| 1 | KV namespace bindings | `WB2A_CONFIG` | `wb2api-config` |
| 2 | KV namespace bindings | `WB2A_CACHE` | `wb2api-cache` |
| 3 | D1 database bindings | `WB2A_DB` | `workbuddy2api` |
| 4 | R2 bucket bindings | `WB2A_LOGS` | `workbuddy2api-logs`（跳过 R2 的话这行也跳过） |
| 5 | **Durable Object bindings** | `POOL` | 下拉选 `PoolDO` |

⚠️ **四个容易翻车的点**：

1. **变量名必须一字不差**。代码里就是按 `WB2A_CONFIG`、`WB2A_DB`、`POOL` 这些名字读的，
   写成 `wb2a_config` 或 `DB` 都会读不到，而且**不报错，只是功能静默失效**。
2. **第 5 项依赖第 3 章**。Worker ① 没部署成功，下拉里就没有 `PoolDO`。
3. **Production 和 Preview 两套环境各配一遍**。页面上有切换按钮，只配一套的话
   预览分支会缺绑定。
4. **改完必须重新部署**，运行中的部署读不到新绑定。

### 重新部署

**Deployments** → 最新那条 → 右上角 **…** → **Retry deployment**

---

## 第 6 章 · 兼容标志（1 分钟）

**Pages 项目 → Settings → Functions**，往下找到 Compatibility 区：

- **Compatibility date**：填 `2024-11-01`（或更新）
- **Compatibility flags**：填 `nodejs_compat`

> 代码要用 `process.env` 读运行时变量，缺这个标志会在读配置时报错。

改完同样 **Retry deployment**。

---

## 第 7 章 · 设置面板密钥（3 分钟）

密钥不能写进代码仓库，这步必须手动。

### 7.1 Pages 项目

**Pages 项目 → Settings → Variables and Secrets → Add**

- Type（类型）选 **Secret**（密钥，不是明文变量）
- Variable name：`WB2A_API_KEY`
- Value：**你自己想一个强密码**（这是面板登录密码，也是 `/v1/*` 接口的鉴权密钥）
- 保存 → **Retry deployment**

### 7.2 Worker ①（再来一遍）

**`workbuddy2api-engine` → Settings → Variables and Secrets → Add**
同样的 `WB2A_API_KEY` 和同样的值。

> ⚠️ **Secret 是每个 Worker 独立存的**，Pages 设了不会同步过来，两边都要设。
>
> 设完把密码填进抄写表——后面登录面板要用。

---

## 第 8 章 · 验收（3 分钟）

打开三个地址看看（把 `<你的域名>` 换成第 4 章拿到的网址）：

### 8.1 健康检查

浏览器打开：`https://<你的域名>/healthz`

应该看到：
```json
{"ok":true}
```

### 8.2 详细状态

打开：`https://<你的域名>/status`

重点看 `checks` 里这几项：

| 字段 | 期望 | 不对的话 |
|---|---|---|
| `d1_schema` | `ok` 或 `created` | D1 绑定没配对（第 5 章第 3 项） |
| `pool` | `ok` | DO 绑定没配对（第 5 章第 5 项） |
| `kv_config` | `ok` | KV 绑定没配对（第 5 章第 1 项） |
| `api_key` | `ok` | 第 7 章没设，或设完没重新部署 |

> 第一次打开时 `d1_schema` 可能是 `skipped` —— 自动建表是异步的，**刷新一次就好**。
> 表不用你手动建，Worker 收到第一个请求就会自己建好 4 张表和 5 个索引。

### 8.3 面板

打开：`https://<你的域名>/panel`

能看到登录页就成功了一大半。用第 7 章设的密钥登录。

> ❌ 打不开 / 404 → 检查第 4 章的 Build output directory 是不是 `dist`
> ❌ 一直转圈 → 检查第 6 章的 `nodejs_compat` 有没有填

---

## 第 9 章 · 初始化面板（5 分钟）

登录进去后有 7 个标签页：**账号、配置、密钥、日志、用量、模型、任务**。

按顺序做：

### 9.1 添加账号

**账号** 标签 → 右上角 **添加账号** → 按页面提示完成授权登录。

加完可以点 **全部签到**、**全部保活** 试试能不能跑通。
报错误就去看 **日志** 标签。

### 9.2 配置

**配置** 标签 → 改你要改的项 → 右下角 **保存配置**。

关键几项：

| 配置项 | 说明 |
|---|---|
| 上游地址 | 转发请求到哪 |
| 模型白名单 | 允许哪些模型通过 |
| 各定时任务开关 | 签到/旅行/活跃/保活/夜猫子/成长 各自独立开关 + 执行小时 |

改错了想还原，点 **放弃修改** 会丢弃未保存的改动。

### 9.3 拉取模型列表

**模型** 标签 → **重新获取**。拉不到就检查上游地址对不对。

### 9.4 定时任务

两条路（都行，可以都开）：

- **自动**：Worker ① 每小时整点自动跑一次（第 3.4 节那两条 cron）
- **手动**：面板上点 **全部签到** / **活跃上报** / **扫描待办** / **执行全部待办**

> 所有配置都存在 KV（`wb2api-config`）里，**重新部署不会丢**。

---

## 第 10 章 · 出问题怎么办

### 先看这里

`/status` 页面里每个失败项都带 `hint` 字段，会直接告诉你怎么修。先看它。

### 常见故障速查

| 现象 | 最可能的原因 | 去哪章 |
|---|---|---|
| 面板能开，但一点操作就「未授权」 | `WB2A_API_KEY` 没设或设完没重新部署 | 第 7 章 |
| `/status` 里 `pool` 失败 | DO 绑定名不是 `POOL`，或没选 `PoolDO` | 第 5 章第 5 项 |
| `/status` 里 `d1_schema` 报 error | D1 绑定选错库 | 第 5 章第 3 项 |
| DO 下拉里没有 `PoolDO` | Worker ① 没部署成功 | 第 3 章 |
| 构建报「缺少 3 个资源 ID」 | 变量填到了 Variables and Secrets 而不是 Build | 第 3.2 节 |
| 部署报 Pages 相关错误 | Deploy command 用了默认值 | 第 3.1 节 |
| Triggers 里没有 cron | 同上，Deploy command 没带 `--config` | 第 3.1 节 |
| 定时任务从不执行 | Triggers 里没有那两条 cron | 第 3.4 节 |
| 页面 404 | Build output directory 不是 `dist` | 第 4 章 |
| 页面一直转圈 | 缺 `nodejs_compat` | 第 6 章 |
| 日志归档不工作 | 跳过了 R2 | 第 2.3 节 |

### 终极排查手段

**Workers & Pages → 点你的项目 → Logs（日志）** → 打开实时日志，
然后去页面上点一下出问题的操作，看日志里报什么。

---

## 第 11 章 · 日常怎么用

### 改配置

面板 **配置** 标签改完保存即可，**不需要重新部署**。

### 更新代码

往 GitHub 仓库的 `main` 分支推代码，两个项目会自动各自重新构建部署。
绑定关系已经固定，不会因为顺序出错。

### 改密钥

Settings → Variables and Secrets 里删除重建，**然后一定要 Retry deployment**。

### 看用量

面板 **用量** 标签可以按账号 / 模型 / 域三个维度看，Cloudflare 后台的
Workers & Pages → 概览 能看到请求数和资源消耗。

---

## 附：全部要填的字符串清单

方便你在手机上长按复制：

```
# 仓库
Linyueying/workbuddy2api-plus-cf

# 两个项目名
workbuddy2api-engine
workbuddy2api-pages

# 资源名
workbuddy2api           (D1)
wb2api-config           (KV)
wb2api-cache            (KV)
workbuddy2api-logs      (R2)

# 构建变量（Worker ① 配一遍）
CF_KV_CONFIG_ID
CF_KV_CACHE_ID
CF_D1_ID

# Pages 绑定变量名（一字不差）
WB2A_CONFIG
WB2A_CACHE
WB2A_DB
WB2A_LOGS
POOL

# 密钥（Pages 和 pool 各设一遍）
WB2A_API_KEY

# 兼容标志
nodejs_compat

# Build command
npm run build                                                 (Pages)
npm install && npm run build:engine && node scripts/fill-ids.mjs (Worker ①)

# Deploy command（Pages 没有这个字段）
npx wrangler deploy --config engine-worker/wrangler.toml

# cron（Worker ① 自带，不用你配，只用来核对）
0 * * * *
30 17 * * *
```
