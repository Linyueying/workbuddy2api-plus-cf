import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

// 顶层求值守卫——**这是全项目最重要的一条前端测试**。
//
// 背景：vendor/frontend/app.js 是一份「按顺序求值的经典脚本」，不是模块。它里面
// 大量用 const/let 声明，而这些声明散布在整份文件里；一旦某条**顶层同步语句**
// （缩进 0、不在任何函数体内）读到了一个**声明在后面**的 const/let，脚本会在那一行
// 抛 TDZ：
//
//     ReferenceError: Cannot access 'X' before initialization
//
// 这跟「某个函数报错」完全不是一个量级的问题：抛错位置之后的**所有顶层语句都不再执行**，
// 包括导航点击绑定、各按钮的 onclick、以及最后的 start()。用户看到的现象是
// 「好多功能都不能用了」——而且报错信息里冒出来的符号名往往是**别处的**残留引用
// （比如 CFG_MAP / PK_DEFAULT_DETAIL_LIMIT / usageRateWarmAt），跟肇事的那一行
// 毫无关系，极难从报错反推。
//
// 真实事故：给 refreshOverview 加时间闸门时顺手写了
//     const POLL_FORCE_MS = REFRESH_IDLE_MS;
// 而这行在 L463，REFRESH_IDLE_MS 却声明在 L1325（轮询一节）。整份脚本从 L463 中断。
// 当时原有的静态字符串断言测试全绿——因为它们只检查"某个片段存在"，不执行代码。
//
// 所以这里不玩字符串匹配，直接把整份 app.js 丢进 vm 里跑一遍：只要顶层求值不抛错，
// 就证明了不存在任何顶层 TDZ。这是唯一能在 CI 里复现该事故的形态。

function makeDomStub() {
  const elCache = new Map();
  const mkEl = (tag = "div") => {
    const el: any = {
      tagName: tag, className: "", textContent: "", innerHTML: "", value: "",
      style: {}, dataset: {}, children: [] as any[], hidden: false, disabled: false,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      appendChild(c: any) { this.children.push(c); return c; },
      removeChild() {}, remove() {}, setAttribute() {}, getAttribute() { return null; },
      addEventListener() {}, removeEventListener() {},
      querySelector() { return null; }, querySelectorAll() { return []; },
      closest() { return null; }, focus() {}, blur() {}, insertAdjacentHTML() {},
      getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
    };
    return el;
  };
  const doc = {
    documentElement: mkEl("html"),
    body: mkEl("body"),
    getElementById(id: string) {
      if (!elCache.has(id)) elCache.set(id, mkEl());
      return elCache.get(id);
    },
    createElement: (t: string) => mkEl(t),
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
  return doc;
}

/**
 * 在 vm 中执行整份 app.js。
 * - 定时器打成 no-op：避免 start() 注册的 60s 轮询把测试挂住；
 *   enterView 里的 setTimeout 同样不会真跑，但这不影响 TDZ 检测——
 *   TDZ 发生在**同步求值阶段**，与回调是否执行无关。
 * - 追加一段自检代码：把几个关键模块级 const/let 的 typeof 回传出来。
 *   （const/let 不会挂到 vm context 上，必须从脚本内部导出。）
 */
function evalAppJs() {
  const src = readFileSync(resolve(__dirname, "../vendor/frontend/app.js"), "utf8");
  const reports: Record<string, string> = {};
  const code =
    src +
    `\n;__wbReport({CFG_MAP:typeof CFG_MAP,PK:typeof PK_DEFAULT_DETAIL_LIMIT,` +
    `warm:typeof usageRateWarmAt,REFRESH:typeof REFRESH_IDLE_MS,` +
    `POLL_FORCE:typeof POLL_FORCE_MS,OVERVIEW_GATE:typeof OVERVIEW_GATE_MS});`;

  const win: any = {
    document: makeDomStub(),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {}, removeEventListener() {},
    location: { hash: "#accounts", href: "http://localhost/panel/", replaceState() {} },
    history: { replaceState() {}, pushState() {} },
    navigator: { userAgent: "node" },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0,
    fetch: async () => { throw new Error("offline"); },
    console, Promise, JSON, Date, Math, Object, Array, String, Number, Boolean,
    Error, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    URLSearchParams, TextDecoder, TextEncoder,
    Blob: class {}, FormData: class {}, FileReader: class {},
    confirm: () => true, alert() {},
    __wbReport: (d: Record<string, string>) => Object.assign(reports, d),
  };
  win.window = win; win.self = win; win.globalThis = win;

  const ctx = vm.createContext(win);
  let err: Error | null = null;
  try {
    vm.runInContext(code, ctx, { filename: "app.js" });
  } catch (e) {
    err = e as Error;
  }
  return { err, reports, ctx };
}

describe("app.js 顶层求值", () => {
  it("整份脚本能被完整求值（任何顶层 TDZ 都会在这里失败）", () => {
    const { err } = evalAppJs();
    // 把真实的 ReferenceError 带出来，报错直接指出肇事行
    expect(
      err,
      err
        ? `脚本顶层求值中断：${err.name}: ${err.message}\n` +
          `（顶层 TDZ 会让此行之后的所有绑定/start() 都不执行，表现为"好多功能不能用"）`
        : "",
    ).toBeNull();
  });

  it("顶层 const/let 全部完成初始化（非 TDZ 残留）", () => {
    const { reports } = evalAppJs();
    // 这几个是历史事故里被反复点名的符号，以及撑起调度逻辑的关键常量。
    // 注意排除 POLL_FORCE：它已被删除，undefined 才是正确状态（见下一条用例）。
    const mustInit = Object.entries(reports).filter(([k]) => k !== "POLL_FORCE");
    expect(mustInit.length).toBeGreaterThan(0);
    for (const [k, v] of mustInit) {
      expect(v, `${k} 未完成初始化（typeof=${v}）`).not.toBe("undefined");
    }
  });

  it("POLL_FORCE_MS 这类读后置常量的死变量不得复活", () => {
    const { reports } = evalAppJs();
    // 事故变量已删除。若有人重新引入，这里会立刻变红。
    expect(
      reports.POLL_FORCE,
      "POLL_FORCE_MS 又被引入了；它引用后置的 REFRESH_IDLE_MS 会导致整份脚本 TDZ",
    ).toBe("undefined");
  });

  it("顶层同步路径不得直接引用声明在后面的调度常量", () => {
    // 静态兜底：REFRESH_IDLE_MS / REFRESH_QUEUE_MS 声明在轮询一节（文件后半段），
    // 任何缩进为 0 的顶层语句都不该读它们（函数体内引用是安全的，只在调用时求值）。
    const src = readFileSync(resolve(__dirname, "../vendor/frontend/app.js"), "utf8");
    const lines = src.split("\n");
    const offenders: string[] = [];
    lines.forEach((L, i) => {
      if (/^\s/.test(L)) return;                                   // 有缩进，不是顶层
      if (/^\s*(\/\/|\*|\/\*)/.test(L)) return;                    // 注释
      if (!/\bREFRESH_(IDLE|QUEUE)_MS\b/.test(L)) return;
      if (/^(const|let|var)\s+REFRESH_(IDLE|QUEUE)_MS\b/.test(L)) return; // 声明本身
      offenders.push(`L${i + 1}: ${L.trim()}`);
    });
    expect(offenders, "顶层语句引用了后置的轮询常量").toEqual([]);
  });
});
