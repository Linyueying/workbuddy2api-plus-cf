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
});
