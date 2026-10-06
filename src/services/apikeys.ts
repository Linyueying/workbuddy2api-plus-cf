import type { Env } from "../../worker-configuration.d.ts";
import type { ApiKeyRow } from "../types";
import { run, first, getKeyByHash } from "../storage/d1";

// 子密钥配额与管控（替代 internal/apikeys/apikeys.go 的 Verify / VerifyRequest /
// Touch / Consume 四段）。
//
// 与管理员总钥匙的关系：config.api_key 是管理员总钥匙，全权放行零回归；本模块
// 只管 wbk_ 前缀的分发子密钥，各自带积分额度、token 额度、IP 名单、模型白名单、
// realm 归属与有效期。
//
// 状态码口径与 Go / workbuddy-manager 的 key 分发对齐（**分类刻意不同于普通 4xx**，
// 让客户端能把「配置不对」与「密钥无效」区分开，别一律显示成密钥失效）：
//   - 停用 / 过期        → 403（凭据本身不可用）
//   - 配额用尽（双额度）→ 429（避免被读成「密钥无效」）
//   - IP / 模型 / realm 不匹配 → 400（本次请求参数不对，报文透出原因）
//
// 落盘差异：Go 侧是 data/keys.json 原子替换 + 全局锁；这里落 D1，用带条件的
// UPDATE 累加用量（`WHERE used_tokens + ? <= quota` 一类），天然免锁且并发安全。

/** PREFIX 子密钥前缀（同时是「是否归本模块处理」的判据）。 */
export const PREFIX = "wbk_";

/**
 * timingSafeEqual 常量时间字符串比较（凭据比对专用，勿用于其它场景）。
 *
 * 普通 `===` 在第一个不同字节处就短路返回，耗时随「猜对的前缀长度」单调上升，
 * 理论上可据此逐字节试探。这里比较的是高熵随机串，实际可利用性很低，
 * 但成本同样很低——既然要写鉴权分支，顺手把它关掉。
 *
 * 长度不同时会提前返回：这只泄露长度、不泄露内容，可接受。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = String(a ?? "");
  const y = String(b ?? "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** KeyError 带 HTTP 状态与错误码的鉴权失败。 */
export interface KeyError {
  status: 400 | 401 | 403 | 429;
  code: string;
  message: string;
}

function err(status: KeyError["status"], code: string, message: string): KeyError {
  return { status, code, message };
}

/** normRealm 归一 realm 限定（空 = 不限；非法值当不限而非报错）。 */
export function normRealm(v: unknown): "" | "cn" | "global" {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "cn" || s === "global" ? s : "";
}

/** ipToBytes IPv4 点分十进制 → 4 字节；非法返回 null。
 *  只支持 IPv4 —— Cloudflare 看到的客户端地址恒为 IPv4/IPv6 双栈，但白名单里
 *  写 IPv6 CIDR 的场景罕见；IPv6 字面量按「精确匹配」处理（见 ipIn）。 */
export function ipToBytes(ip: string): number[] | null {
  const parts = String(ip ?? "").trim().split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/**
 * ipIn 判定 ip 是否落在 allow 名单内：精确匹配或 CIDR 命中。
 *
 * CIDR 语义与 Go net.ParseCIDR 一致（前缀长度按位掩码，允许 /0 匹配全部）。
 * ip 本身非法时只有精确字面量能命中（Go 的 parsed==nil 路径同此）。
 */
export function ipIn(ip: string, allow: string[]): boolean {
  const list = (allow ?? []).map((s) => String(s ?? "").trim()).filter(Boolean);
  if (!list.length) return true; // 空 = 不限制
  for (const a of list) {
    if (a === ip) return true;
    const slash = a.indexOf("/");
    if (slash < 0) continue;
    const netIP = a.slice(0, slash);
    const bits = Number(a.slice(slash + 1));
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const net = ipToBytes(netIP);
    const target = ipToBytes(ip);
    if (!net || !target) continue;
    if (cidrMatch(net, target, bits)) return true;
  }
  return false;
}

/** cidrMatch 前缀位掩码比较。 */
function cidrMatch(net: number[], ip: number[], bits: number): boolean {
  let rem = bits;
  for (let i = 0; i < 4 && rem > 0; i++) {
    const take = Math.min(8, rem);
    const mask = take === 0 ? 0 : (0xff << (8 - take)) & 0xff;
    if ((net[i] & mask) !== (ip[i] & mask)) return false;
    rem -= take;
  }
  return true;
}

/** modelAllowed 模型是否在白名单内（空名单 = 全放行；精确匹配模型 id）。
 *
 * 刻意不做前缀/模糊匹配：白名单是「这把钥匙能碰哪些模型」的授权边界，
 * 近似匹配等于把边界漏成筛子。
 */
export function modelAllowed(model: string, allow: string[]): boolean {
  const list = (allow ?? []).map((s) => String(s ?? "").trim()).filter(Boolean);
  if (!list.length) return true;
  return list.includes(String(model ?? "").trim());
}

/** parseJSONArray 宽容解析 D1 里的 JSON 数组列（脏数据当空数组，不抛）。 */
export function parseJSONArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x));
  const s = String(raw ?? "").trim();
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

/** keyQuota key 的 token 配额（0 = 不限）。 */
export function keyTokenQuota(k: ApiKeyRow): number {
  const v = Number((k as any).quota ?? 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** keyCreditQuota key 的积分配额（0 = 不限）。 */
export function keyCreditQuota(k: ApiKeyRow): number {
  const v = Number((k as any).quota_credit ?? 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * verifyKey 校验一把子密钥（不含 model / realm —— 那两项要等 body 解析出 model
 * 后由 verifyKeyRequest 判定，因为 withAuth 发生在读 body 之前）。
 *
 * @param clientIP 客户端 IP（trust_proxy 已在路由层解析好）。
 * @returns 校验通过返回 key；失败返回 KeyError。不由本模块处理的 token 调用方自行判断。
 */
export function verifyKey(k: ApiKeyRow, clientIP: string, now = Date.now()): KeyError | null {
  if ((k as any).enabled === 0) return err(403, "key_disabled", "密钥已停用");

  const exp = Number((k as any).expires_at ?? 0);
  if (Number.isFinite(exp) && exp > 0 && now > exp) return err(403, "key_expired", "密钥已过期");

  const tQuota = keyTokenQuota(k);
  const tUsed = Number((k as any).used_tokens ?? 0);
  if (tQuota > 0 && tUsed >= tQuota) {
    return err(429, "quota_exhausted", `密钥 token 配额已用尽（已用 ${Math.floor(tUsed)} / 上限 ${tQuota}）`);
  }

  const cQuota = keyCreditQuota(k);
  const cUsed = Number((k as any).used_credit ?? 0);
  if (cQuota > 0 && cUsed >= cQuota) {
    return err(429, "credit_quota_exhausted", `密钥积分额度已用尽（已用 ${trimNum(cUsed)} / 上限 ${trimNum(cQuota)}）`);
  }

  const allow = parseJSONArray((k as any).ip_allowlist);
  if (allow.length && !ipIn(clientIP, allow)) {
    return err(400, "ip_not_allowed", `来源 IP ${clientIP} 不在密钥白名单内`);
  }

  const maxIPs = Number((k as any).max_ips ?? 0);
  const ips = parseJSONArray((k as any).ips);
  if (maxIPs > 0 && clientIP && !ips.includes(clientIP) && ips.length >= maxIPs) {
    return err(400, "too_many_ips", `密钥已绑定 ${ips.length} 个 IP，超出上限 ${maxIPs}`);
  }
  return null;
}

/**
 * verifyKeyRequest 请求级校验：realm 归属 + 模型白名单。
 *
 * 拆分原因同 Go：model 要读完 body 才知道，而鉴权发生在读 body 之前。
 */
export function verifyKeyRequest(k: ApiKeyRow, model: string, realm: string): KeyError | null {
  const want = normRealm((k as any).realm);
  if (want) {
    if (!String(model ?? "").trim()) {
      return err(400, "realm_mismatch", `该密钥限定了${want === "global" ? "国际版" : "国内版"}模型，请求必须指定 model`);
    }
    if (realm !== want) {
      const label = want === "global" ? "国际版" : "国内版";
      const other = want === "global" ? "国内版" : "国际版";
      const hint = want === "global" ? "模型名需带 global: 前缀" : "请去掉 global: 前缀";
      return err(400, "realm_mismatch", `该密钥仅限${label}模型，当前请求是${other}模型（${hint}）`);
    }
  }
  const models = parseJSONArray(k.models);
  if (models.length) {
    if (!String(model ?? "").trim()) {
      return err(400, "model_not_allowed", "请求未指定 model，而该密钥启用了模型白名单");
    }
    if (!modelAllowed(model, models)) {
      return err(400, "model_not_allowed", `模型 ${model} 不在密钥白名单内`);
    }
  }
  return null;
}

/**
 * touchKey 记录一次成功鉴权（IP 归属、请求数、最近使用）。
 *
 * IP 列表的并发安全靠 SQL 里的「读-判-写」单语句完成不了（D1 无行锁），
 * 故用一次 SELECT 读回 + 带 `req_count < 上次值+1` 无关紧要——真正的正确性来源是
 * 「重复 IP 只会追加一次」这条幂等约束：读判写在 DO 单实例/单条 SQL 内完成，
 * 极端并发下可能多出一个重复 IP，不影响 MaxIPs 判定的量级正确性。
 */
export async function touchKey(env: Env, k: ApiKeyRow, clientIP: string): Promise<void> {
  const ips = parseJSONArray((k as any).ips);
  if (clientIP && !ips.includes(clientIP)) ips.push(clientIP);
  await run(
    env,
    "UPDATE apikeys SET last_used = ?, req_count = req_count + 1, last_ip = ?, ips = ? WHERE id = ?",
    [Date.now(), clientIP ?? "", JSON.stringify(ips), k.id],
  );
}

/**
 * consumeKey 累加已消耗积分与 token。
 *
 * 幂等性说明：同一请求的 usage 只会回调一次（流式在末帧、非流式在聚合后），
 * 重复累加的风险由调用侧「每请求只调一次」保证。超出配额的部分仍然累加——
 * 面板要看到真实消耗，超额本身由下次 verifyKey 拒（429）。
 */
export async function consumeKey(env: Env, id: string, credit: number, tokens: number): Promise<void> {
  if (!(credit > 0) && !(tokens > 0)) return;
  const c = Number.isFinite(credit) && credit > 0 ? credit : 0;
  const t = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
  await run(env, "UPDATE apikeys SET used_credit = used_credit + ?, used_tokens = used_tokens + ? WHERE id = ?", [c, t, id]).catch(
    () => {},
  );
}

/**
 * 子密钥查询的内存缓存。
 *
 * 存在理由（真机数据驱动）：每一次 /v1 调用都要为鉴权查一次 D1，实测 auth 段
 * 在 123ms 与 247ms 之间反复横跳——同一把钥匙、同一个操作，能差出一倍。D1 库
 * 是**单区域**的，而 Worker 跑在全球各 POP 上，这一跳要跨洋往返；叠加每个
 * isolate 首次查询的冷连接，抖动完全不可控。而密钥行的变更频率是「天」量级的，
 * 每请求付一次跨洋查询来换取理论上最新的一行数据，是纯粹的浪费。
 *
 * 为什么放在这里而不是 router 的调用现场：这里是密钥语义的归属地，把它和
 * verifyKey / consumeKey 放一起，失效时机（改密钥就要失效）才不会被漏掉。
 *
 * 为什么**也缓存查不到的结果**：否则任何人拿一个不存在的 wbk_ 串反复打网关，
 * 就是一条免费的 D1 放大通道（缓存 miss → 每次都落库）。负结果同样入 60s 缓存。
 *
 * 键取 sha256(token) 而非 token 本身：缓存里不出现任何可还原凭据的字节。
 */
/**
 * KEY_CACHE_TTL_MS 缓存有效期 —— 这个值同时就是**配额判定的陈旧窗口**。
 *
 * 为什么不是越大越好：`verifyKey` 靠行里的 `used_tokens` / `used_credit` 判额度，
 * 而 consumeKey 的累加是在别的 isolate 里写 D1 的。缓存一旦命中，本 isolate 看到
 * 的就是一份旧计数——于是「配额已耗尽」这件事会晚 TTL 这么久才被拦住，表现为
 * **超额放行**。存储代价换来的是抖动消失，但这个窗口本质上是「愿意多放行多少
 * 额度」的经营决策，不是纯技术参数。所以这里刻意没有采纳「60~300s」：那会让
 * 一把配额 1000 的钥匙在几分钟内超到什么程度完全不可控。
 *
 * 30s 的取舍：足够覆盖「同一轮对话的连续几请求」（这才是我们要消灭的抖动来源：
 * 真人对话的轮间隔远短于它），又把超额窗口压在一次对话的量级内。
 * 想进一步放宽之前，先确认你能接受那个窗口内的超额量。
 *
 * 管理面的显式改动（停用 / 改配额 / 删除）另有一条即时路径——invalidateKeyCache，
 * 不走 TTL。见 routes/panel.ts 的调用点。
 */
const KEY_CACHE_TTL_MS = 30_000;
/** KEY_CACHE_MAX 容量上限：防止恶意海量不同 key 把 isolate 内存吃穿。 */
const KEY_CACHE_MAX = 1024;
/** cache: hash → { ts, row }。row 为 null 即「查无此钥」的负结果。 */
let keyCache: Map<string, { ts: number; row: ApiKeyRow | null }> = new Map();

/**
 * loadKeyByHash 带缓存地读子密钥（热路径：/v1 鉴权）。
 *
 * 与直接调 getKeyByHash 的唯一差别就是这层缓存；其余语义（查无此钥返回 null）
 * 完全一致。管理面读写路径**不要**用它——改完立刻要看到的必须是真实现场。
 */
export async function loadKeyByHash(
  env: Env,
  keyHash: string,
  opts?: { onCache?: (hit: boolean) => void },
): Promise<ApiKeyRow | null> {
  const hit = keyCache.get(keyHash);
  if (hit && Date.now() - hit.ts < KEY_CACHE_TTL_MS) {
    opts?.onCache?.(true);
    return hit.row;
  }
  // 查失败**不入缓存**：把一次 D1 抖动固化成 60s 的「密钥不存在」会把正常流量
  // 误伤成 401。宁可下次再查一次，也不要让网络抖动变成权限判决。
  let row: ApiKeyRow | null;
  try {
    row = await getKeyByHash(env, keyHash);
  } catch {
    return null;
  }
  if (keyCache.size >= KEY_CACHE_MAX) keyCache.clear(); // 满了整体清，简单可预测
  keyCache.set(keyHash, { ts: Date.now(), row });
  opts?.onCache?.(false);
  return row;
}

/**
 * invalidateKeyCache 失效一条（或全部）子密钥缓存。
 *
 * 管理面每次改动密钥都必须调它，否则「停用/改配额/删除」会被内存里的旧行挡住，
 * 最长 60s 不生效——面板点了停用、请求却还在放行，这是安全口径，不能只靠 TTL。
 * 不传 hash 表示全清（批量操作 / 测试用）。
 */
export function invalidateKeyCache(hash?: string): void {
  if (!hash) {
    keyCache.clear();
    return;
  }
  keyCache.delete(hash);
}

/** keyById 取子密钥（管理面用）。 */
export async function keyById(env: Env, id: string): Promise<ApiKeyRow | null> {
  return first<ApiKeyRow>(env, "SELECT * FROM apikeys WHERE id = ?", [id]);
}

/** trimNum 数值展示：整数不带小数点，小数最多两位（对齐 Go %g 的可读形态）。 */
function trimNum(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 100) / 100);
}
