import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 前端刷新时机的静态守卫。
//
// 为什么单独成测：这一整块是**调度**逻辑，跑起来"看起来总在刷新"，坏掉的形态却很
// 安静——比如把 loadOverview 从 go() 里漏掉，界面只是偶尔慢一拍；把 enterView 里的
// 去重写错，就变成每进一次视图打两个请求，白烧 Durable Object 额度（免费套餐
// 10 万次/天）。这类退化在浏览器里要盯很久才看得出，用静态断言钉住成本最低。
//
// 只断言"接线是否接上"，不复制实现——实现细节改动不该弄红这里。

const root = resolve(__dirname, "..");
const appJs = () => readFileSync(resolve(root, "vendor/frontend/app.js"), "utf8");

describe("账号池刷新时机", () => {
  it("go() 进入视图时会同步账号池数据", () => {
    const js = appJs();
    // enterView 是进入视图的唯一收口（切视图与切回标签页共用）
    expect(js, "go() 未调用 enterView，进入视图不会同步数据").toContain("enterView(v)");
    expect(js, "enterView 未声明").toContain("function enterView(");
    // 账号池分支必须真的去拉数据
    const body = js.slice(js.indexOf("function enterView("), js.indexOf("function go("));
    expect(body, "enterView 未刷新账号池").toContain("loadOverview(true)");
  });

  it("切回标签页会同步当前视图", () => {
    const js = appJs();
    expect(js, "缺少 visibilitychange 监听").toContain("addEventListener('visibilitychange'");
    expect(js, "缺少 pageshow 监听（切到别的应用再回来时只派发它）").toContain("addEventListener('pageshow'");
    expect(js, "syncVisibleView 未声明").toContain("function syncVisibleView(");
  });

  it("轮询与进入视图共用去重闸门（并发合并 + 时间闸门）", () => {
    const js = appJs();
    expect(js, "缺少在途请求合并").toContain("if (ovFlight) return ovFlight");
    expect(js, "缺少时间闸门").toContain("OVERVIEW_GATE_MS");
    // 轮询必须 force：否则轮询会被自己"刚刷过"的闸门吞掉，刷新反而变少
    expect(js, "定时轮询未跳过闸门，会被去重逻辑吞掉").toContain("refreshOverview(true, true)");
    // 进入视图走非 force 分支（需去重）
    expect(js, "进入视图未走去重路径").toContain("refreshOverview(true)");
  });

  it("enterView 只安排一次同步，且改道回调不再补刷", () => {
    const js = appJs();
    const body = js.slice(js.indexOf("function enterView("), js.indexOf("function go("));
    // 曾经踩过：轮询改道的回调里又补了一次 sync()，进视图固定发两次请求
    // （0ms 一次、60s 一次），白烧 Durable Object 额度。改道回调现在只重排计时器。
    const rearm = body.slice(body.indexOf("viewPollTimer = setTimeout("));
    expect(rearm, "改道回调里又出现了同步调用").not.toMatch(/loadOverview\(|loadLogs\(/);
    // 两次 setTimeout 里只有第一个负责同步
    expect(body.match(/setTimeout\(/g) || []).toHaveLength(2);
  });

  it("viewPollTimer 与 viewSyncTimer 一并初始化（避免 TDZ）", () => {
    const js = appJs();
    // 模块顶部的 let 声明必须早于任何 enterView 调用（首屏 go 在文件后半段才触发，
    // 但顶部声明缺失会让深链打开时直接 ReferenceError）
    expect(js).toMatch(/let\s+viewSyncTimer\s*=\s*null,\s*viewPollTimer\s*=\s*null/);
  });
});
