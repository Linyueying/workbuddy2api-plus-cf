/// <reference types="@cloudflare/workers-types" />

// Cloudflare Pages + Durable Objects 绑定声明（单行来源）。
// Secrets（WB2A_API_KEY / WB2A_DEVICE_TOKEN / WB2A_UPTASH_TOKEN）通过
// `wrangler secret put` 注入，不会出现在仓库或本文件里。

interface Env {
  // ---- KV ----
  /** 非敏感配置（config.json 导入后整体）。 */
  WB2A_CONFIG: KVNamespace;
  /** 模型目录缓存 / model.json / output_probes（带 TTL）。 */
  WB2A_CACHE: KVNamespace;

  // ---- D1 ----
  /** 用量、请求日志、子密钥、任务中心队列。 */
  WB2A_DB: D1Database;

  // ---- R2 ----
  /** 请求 JSONL 归档导出。 */
  WB2A_LOGS: R2Bucket;

  // ---- Durable Object ----
  /** 账号池 + 调度 + 会话粘性 + token 状态。 */
  POOL: DurableObjectNamespace;

  /** Pages 静态资源（dist/ 构建输出）。 */
  ASSETS: Fetcher;

  // ---- Secrets（敏感，仅运行时可用）----
  /** 管理面板 / API 的 Bearer api_key。 */
  WB2A_API_KEY: string;
  /** 设备 token（可选，原 device_token_file / WB2A_DEVICE_TOKEN）。 */
  WB2A_DEVICE_TOKEN?: string;
  /** 原 Upstash token（可选；本项目已用纯 DO 替代，保留以备横向扩展）。 */
  WB2A_UPTASH_TOKEN?: string;
}

export {};
export type { Env };
