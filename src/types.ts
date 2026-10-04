// 全局共享类型（跨层契约：账号凭证 / 池内状态 / D1 行 / 上游错误分类）。

/** Realm 上游域：cn = 国内版（copilot.tencent.com），global = 国际版（workbuddy.ai）。 */
export type Realm = "cn" | "global";

/** Auth 账号凭证（落盘形态由 storage/auth.ts 负责转换）。 */
export interface Auth {
  accessToken: string;
  refreshToken: string;
  /** access token 过期墙钟（epoch ms）。 */
  expiresAt: number;
  /** 账号所属域名，v3/config 的 X-Domain 头取它。 */
  domain: string;
  realm: Realm;
  uid: string;
  enterpriseId: string;
  nickname: string;
  /** 设备 token（可选，参与出站鉴权头）。 */
  device_token?: string;
}

/** 账号在池内的状态机取值：healthy（可用）/ cooling（冷却中）/ disabled（硬禁用）。 */
export type AcctStatus = "healthy" | "cooling" | "disabled";

/** ModelCostEntry (账号,模型) 的实测成本台账（积分保底 tier 0 的判据）。 */
export interface ModelCostEntry {
  /** 每 1k token 的实测消耗（credit）。 */
  costPer1k: number;
  /** 台账写入时刻（epoch ms）；超 MODEL_COST_TTL 视为无观测。 */
  lastSeen: number;
  /** 累计观测次数（样本数，面板展示置信度）。 */
  samples: number;
}

/** ModelCooldown (账号,模型) 级独立冷却（6004 模型限额 / 11102 负缓存共用）。
 *  两种成因的字段不同：6004 带 resetAt（上游墙钟）、11102 带 hits（退避档号）。 */
export interface ModelCooldown {
  /** 冷却截止墙钟（epoch ms，0 = 不在冷却）。 */
  until: number;
  /** 冷却来源（"6004 model rate limit" / "11102 …"），面板排查用。 */
  reason: string;
  /** 仅台账不参与避让（模型级限流但重置时间未知时只记录）。 */
  auditOnly?: boolean;
  /** 上游明示的重置墙钟（6004 形态；0 = 未知，走有界退避）。 */
  resetAt?: number;
  /** 11102 连撞次数（决定退避档号：6h × 2^min(hits-1,4)，封顶 24h）。 */
  hits?: number;
  /** 记录时刻（epoch ms）。 */
  lastSeen?: number;
}

/**
 * AccountState 单账号在池内的完整状态（落 DO storage，序列化为 JSON）。
 * 冷却语义分四层，互不覆盖：disabled（硬禁用）/ cooldownUntil+cooldownKind
 * （账号级冷却）/ degradeUntil（连败降权）/ modelCooldowns（模型级独立冷却）。
 */
export interface AccountState {
  uid: string;
  auth: Auth;
  nickname: string;
  realm: Realm;
  status: AcctStatus;
  /** 硬禁用原因（面板展示，如 "12153 session dead"）。 */
  disabledReason: string;
  /** 在途请求数（max_in_flight 上限判定）。 */
  inFlight: number;
  /** 最近一次 acquire 的墙钟时间戳；用于超时自动回收在途占用（避免泄漏占满账号池）。 */
  acquiredAt?: number;
  /** 最近一次选中使用（idleWeight 计算）。 */
  lastUsed: number;
  /** 最近一次成功时刻。 */
  lastSuccess: number;
  lastError: string;
  lastErrorAt: number;
  /** 连续失败计数（issue #114 连败降权判据）。 */
  consecutiveFails: number;
  /** 兼容字段：另一路径写入的连败计数（读时取二者较大值）。 */
  consecutiveFailures: number;
  /** 连败降权截止（达阈后临时出池，不延长不翻倍）。 */
  degradeUntil: number;
  /** 熔断计数（5xx 达阈后进冷却，指数退避封顶 breaker_cooldown_max）。 */
  errTotal: number;
  retryCount: number;
  /** 今日签到已完成标记（定时任务幂等判据）。 */
  checkinDone: boolean;
  /** 软限流退避档位（指数级联的档号，非时长）。 */
  softStreak: number;
  /** session 失效累计（达阈禁用）。 */
  sessionDeadFails: number;
  /** 账号级冷却截止墙钟。 */
  cooldownUntil: number;
  /** 冷却类别："hard_credit" | "soft_rate" | "waf_block" | "not_found" | "hard"。 */
  cooldownKind: string;
  /** 熔断截止墙钟。 */
  breakerUntil: number;
  successCount: number;
  /** 余额快照（由 /internal/credits 回写；成本分层的选号权重来源）。 */
  credits: number;
  creditsTotal: number;
  /** 即将到期积分数（expiring_soon 窗口内）。 */
  creditsExpiring: number;
  /** 最早到期批次的墙钟（0 = 无有效批次）。 */
  creditsEarliestExpiry: number;
  /** 同一到期时刻所有正余额包的剩余量之和。 */
  creditsEarliestRemaining: number;
  /** 余额低于 credit_floor（积分保底判据的快照，免去重复比较）。 */
  creditsBelowFloor: boolean;
  /** 余额刷新时刻（epoch ms）。 */
  refreshedAt: number;
  /** LRU 选号兜底序号（usedSeq）。 */
  usedSeq: number;
  /** (模型 → 成本台账)。 */
  modelCost: Record<string, ModelCostEntry>;
  /** (模型 → 冷却)。 */
  modelCooldowns: Record<string, ModelCooldown>;
}

/** PoolStatus /internal/status 的返回结构。 */
export interface PoolStatus {
  accounts: number;
  total: number;
  healthy: number;
  cooling: number;
  disabled: number;
  degraded: number;
  in_flight_full: number;
  realm_totals: Record<Realm, { total: number; healthy: number }>;
  sticky_sessions: number;
  redis_mode: boolean;
  credit_floor: number;
  cost_explore: boolean;
  cost_explore_interval: number;
  cost_explore_events: number;
  cost_explore_last: Record<string, number>;
  model_cost_entries: number;
  model_cooldowns: number;
}

/** 上游错误分类结果（services/classify.ts 的返回）。 */
export interface Classified {
  kind: string;
  kindName: string;
  status: number;
  code: string;
  message: string;
  hint?: string;
  note: string;
  passthrough: boolean;
  rotate: boolean;
}

/** 子密钥（wbk_ 前缀）。零值 = 不受限（对齐 Go apikeys.Key 的字段默认值）。 */
export interface ApiKeyRow {
  id: string;
  key_hash: string;
  name: string;
  /**
   * 展示掩码：明文的**前 12 字符**（对齐 Go apikeys.Key.Prefix 的 `plain[:12]`）。
   * 目的是让列表页能显示 `wbk_1a2b3c…` —— 既不落明文，管理员又能认出是哪一把。
   * 该字段在密钥轮换时必须同步更新：留在旧掩码上会指向一把已失效的钥匙。
   */
  prefix: string;
  models: string[];
  created_at: number;
  last_used: number;
  /** 0 = 停用（403 key_disabled）。 */
  enabled: number;
  /** 到期墙钟（epoch ms）；0/未设 = 不过期。 */
  expires_at: number;
  /** '' = 不限；cn / global。 */
  realm: string;
  /** IP 白名单（精确 IP 与 CIDR 混写）；空 = 不限制。 */
  ip_allowlist: string[];
  /** 0 = 不限 IP 数。 */
  max_ips: number;
  /** 历史使用过的 IP（MaxIPs 判定用）。 */
  ips: string[];
  last_ip: string;
  req_count: number;
  /** token 额度；0 = 不限。 */
  quota: number;
  used_tokens: number;
  /** 积分额度；0 = 不限。 */
  quota_credit: number;
  used_credit: number;
  /** 创建序号（created_at 只到毫秒仍可能同刻，靠它分先后）。 */
  seq: number;
}

/** 请求日志条目（落 D1 request_logs，可归档到 R2）。 */
export interface RequestLogEntry {
  /** D1 自增主键。写入侧不填；查询（SELECT *）会带出，归档后按 id 精确删除已归档行。 */
  id?: number;
  ts: number;
  channel: "chat" | "task" | "sys";
  client_ip?: string;
  user_agent?: string;
  uid?: string;
  model?: string;
  realm?: Realm;
  outcome: "ok" | "error" | "blocked";
  status: number;
  ms: number;
  msg?: string;
  // ---- 用量指标（0003_usage_metrics.sql；单次请求一级，非预聚合）----
  /** prompt_tokens 输入 Token；不确定留 0（不能留 null，聚合时会被当成样本缺失）。 */
  prompt_tokens?: number;
  completion_tokens?: number;
  /** credits 上游 usage.credit，REAL 小数——成本与积分扣费的唯一真实来源。 */
  credits?: number;
  /** cache_read_tokens 前缀缓存读命中 Token，用于算缓存命中率。 */
  cache_read_tokens?: number;
}

/** CtxVars Hono context 变量（鉴权中间件 → 路由 handler 的共享载荷）。
 *
 *   role     "admin"（管理员总钥匙）| "key"（wbk_ 子密钥）
 *   models   子密钥的模型白名单；null = 不限（管理员恒为 null）
 *   keyRow   子密钥整行（配额累加与请求级校验用）；管理员为 null */
export interface CtxVars {
  role: "admin" | "key";
  models: string[] | null;
  keyRow: ApiKeyRow | null;
}
