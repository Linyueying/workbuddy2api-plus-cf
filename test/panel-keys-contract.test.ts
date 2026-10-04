import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 密钥明文契约的静态守卫（写在测试里而不是注释里）。
//
// 跨文件的字段契约是最容易腐烂的东西：后端 ren 一个字段、前端还在读旧名字，
// 两边都编译得过、各自的单测也都通过，只有用户打开面板那一刻才发现是空的。
// 上次就是这么丢的——后端返回 key、前端读 r.plain，创建完弹出一个空框，
// 而密钥已经没法再投一次（库里只剩 sha256）。
//
// 运行时测试能覆盖「这次对不对」，这里覆盖的是「契约有没有被人改坏」——
// 后者靠跑接口是测不出来的，因为改错的那一刻两边仍然自洽。

const root = resolve(__dirname, "..");
const panelSrc = readFileSync(resolve(root, "src/routes/panel.ts"), "utf8");
const appJs = readFileSync(resolve(root, "vendor/frontend/app.js"), "utf8");

/** 抽出某个 handler 的源码片段（从路由声明到下一个路由声明为止）。 */
function handlerOf(src: string, route: string): string {
  const i = src.indexOf(route);
  expect(i, `找不到路由 ${route}（路由被改名了？请同步更新本守卫）`).toBeGreaterThan(-1);
  const rest = src.slice(i);
  const next = rest.search(/\n\s*app\.(get|post|patch|delete)\("/);
  return next > 0 ? rest.slice(0, next) : rest;
}

describe("密钥明文契约（静态守卫）", () => {
  it("创建与轮换都必须同时返回 key 和 plain（对齐 Go 的 {key, plain}）", () => {
    for (const route of ['app.post("/panel/api/keys"', 'app.post("/panel/api/keys/:id/rotate"']) {
      const body = handlerOf(panelSrc, route);
      // Go: writeKeysJSON(map[string]any{"key": k, "plain": plain})
      expect(body, `${route} 漏了 plain`).toMatch(/\bplain\b/);
      expect(body, `${route} 漏了 key`).toMatch(/\bkey\b/);
    }
  });

  it("前端一次性明文框读的就是后端给的 plain 字段", () => {
    // 移植自 Go 的前端读 r.plain。若哪天后改字段，

    // 剔除 `function showIssued(plain) {` 这个定义本身，只留下调用点。
    const calls = appJs.replace(/function\s+showIssued\s*\([^)]*\)/, "").match(/\bshowIssued\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    // 不能有第二套读法在悄悄兜底（`r.key || ''` 之类）——字段一旦写错也不报错，
    // 只是静默显示空串，正是上次那个事故的表现。
    expect(calls.every((c) => /showIssued\(r\.plain/.test(c)), String(calls)).toBe(true);
  });

  it("genKey 产出格式必须 anchored 在 wbk_ + hex（与 Go 的 Prefix + hex(24B) 同形）", () => {
    const g = panelSrc.slice(panelSrc.indexOf("function genKey"), panelSrc.indexOf("function keyPrefix"));
    expect(g).toContain('"wbk_"');
    expect(g).toMatch(/new Uint8Array\(24\)/); // Go: var buf [24]byte
  });

  it("轮换不得挂在 /reset 上——那是「清用量」的端点，语义与 Go 一致", () => {
    const resetBody = handlerOf(panelSrc, 'app.post("/panel/api/keys/:id/reset"');
    // 出现 genKey 说明有人把它改回了「换密钥」，而按钮文案仍写着重置用量。
    expect(resetBody, "/reset 不得调用 genKey（轮换请走 /rotate）").not.toMatch(/genKey\s*\(/);
    expect(resetBody, "/reset 必须是清零已用额度").toMatch(/used_tokens\s*=\s*0/);
  });

  it("前端对单个密钥的改动只能走 PATCH（后端没注册 POST /keys/:id，发 POST 就是 404）", () => {
    // 2026-10 事故：编辑弹窗保存发的是 POST keys/<id>，面板报「保存失败: 404」，
    // 但创建（POST /keys）、reset、rotate 三个 POST 是真实存在的端点，不能误伤。
    const posts = appJs.match(/keysApi\(\s*'keys\/[^)]*'POST'/g) ?? [];
    const allowed = posts.filter((s) => /\/(reset|rotate|check-models)'/.test(s));
    expect(allowed.length, "keys/:id 上的 POST 只允许 reset / rotate 这两个既有子端点").toBe(posts.length);
    // 编辑保存与停用/启用开关都必须是 PATCH
    expect(appJs).toMatch(/keysApi\('keys\/' \+ k\.id, 'PATCH'/);
    expect(appJs).toMatch(/keysApi\('keys\/' \+ id, 'PATCH', \{ enabled/);
    // 后端守卫：PATCH 路由必须继续存在
    expect(panelSrc).toContain('app.patch("/panel/api/keys/:id"');
  });

  it("expires_at 必须传毫秒时间戳——后端 Number() 直收，传 ISO 字符串会静默归零成永久有效", () => {
    expect(appJs).not.toMatch(/expires_at\s*=[^;]*toISOString/);
    expect(appJs).toMatch(/body\.expires_at = Date\.now\(\) \+ days \* 86400000/);
  });

  it("overview 的账号序列化必须对齐前端（Go 版）snake_case 契约——否则账号池整列空白", () => {
    // 2026-10 事故：后端 overview 只映射了 7 个基础字段，前端 renderAccounts
    // 读的 success_count/err_total/last_success/breaker_until/degrade_until/
    // cool_remaining_sec/cool_kind/disabled/reason/checkin_done/model_costs 全空，
    // 账号池行能画出来但运营数据列全空，看起来像「不显示任何数据」。
    const overview = handlerOf(panelSrc, 'app.get("/panel/api/overview"');
    for (const f of [
      "success_count",
      "err_total",
      "last_success",
      "breaker_until",
      "degrade_until",
      "cool_remaining_sec",
      "cool_kind",
      "disabled",
      "reason",
      "checkin_done",
      "model_costs",
    ]) {
      expect(overview, `overview 漏了账号字段 ${f}（前端 renderAccounts 在读它）`).toContain(f);
    }
    // 禁用账号必须靠 disabled 布尔暴露，不能只回 status（前端用 s.disabled 判定标签）。
    expect(overview).toMatch(/disabled:\s*a\.status\s*===\s*"disabled"/);
    // 时间字段必须是 ISO 字符串（Go 契约）：前端 ago() 对参数调 .startsWith()，
    // 传数字时间戳会在账号首次成功后抛 TypeError，整个账号池 tbody 渲染崩溃
    // （异常被 loadOverview 的 catch 吞掉，表现为「连行都没有」）。
    for (const f of ["last_success", "breaker_until", "degrade_until"]) {
      const line = overview.split("\n").find((l) => l.includes(f + ":"));
      expect(line, `overview 缺时间字段 ${f}`).toBeTruthy();
      expect(line, `${f} 必须序列化为 ISO 字符串（?: new Date(...).toISOString() : ""），不得直接回数字`).toMatch(/new Date\([^)]*\)\.toISOString\(\)/);
    }
    // 成功/失败与 token_usage 必须来自 D1 聚合（usageByAccountWindow，与用量页同口径），
    // 不得回退到 DO 运行时计数（successCount/errTotal，与用量页对不上号）
    // 或空对象（AccountState 里根本没有 token 统计的数据源）。
    expect(overview, "overview 必须调用 accountUsageByUid（D1 窗口聚合）").toMatch(/accountUsageByUid\(c\.env\)/);
    expect(overview, "token_usage 不得回空对象——账号池用量列会全空").not.toMatch(/token_usage:\s*\{\}/);
    expect(overview, "success_count 不得回 DO 运行时计数").not.toMatch(/success_count:\s*a\.successCount/);
    expect(panelSrc).toContain("usageByAccountWindow");
    // 不能用「只回 7 字段」的旧形态蒙混——基础字段仍在，但必须扩出上面的运行时字段。
    expect(overview).not.toMatch(/uid:\s*a\.uid,\s*\n\s*nickname:\s*a\.nickname,\s*\n\s*realm:\s*a\.realm,\s*\n\s*status:\s*a\.status,\s*\n\s*credits:\s*a\.credits,\s*\n\s*credits_total:\s*a\.creditsTotal,\s*\n\s*in_flight:\s*a\.inFlight,\s*\n\s*\}\)/);
  });
});
