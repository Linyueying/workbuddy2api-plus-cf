import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// 前端静态资源语法守卫。
//
// 为什么单独测这个：后端全量走 tsc，前端 vendor/frontend/*.js 此前完全裸奔。
// 一次 Edit 插函数时吞掉上一个函数的头（→ 顶层 return）就能让整个面板白屏，
// 而构建、类型检查、后端测试全部照过——因为没人 parse 过这个文件。
// 事故上线过一次（控制台什么都读不到），这里用 node --check 把它钉死在测试里。

const root = resolve(__dirname, "..");

function check(file: string): { ok: boolean; err: string } {
  const p = resolve(root, file);
  if (!existsSync(p)) return { ok: true, err: "" };
  try {
    execFileSync(process.execPath, ["--check", p], { stdio: "pipe" });
    return { ok: true, err: "" };
  } catch (e: any) {
    return { ok: false, err: String(e?.stderr ?? e?.stdout ?? e?.message ?? e) };
  }
}

describe("前端产物语法守卫", () => {
  it("vendor/frontend/app.js 语法正确（无顶层 return / 括号错位）", () => {
    const r = check("vendor/frontend/app.js");
    expect(r.err, r.err).toBe("");
    expect(r.ok).toBe(true);
  });

  it("dist/panel/app.js 语法正确（存在时；构建产物同样要过关）", () => {
    const r = check("dist/panel/app.js");
    expect(r.err, r.err).toBe("");
    expect(r.ok).toBe(true);
  });

  it("index.html 含用量诊断块容器（renderUsageDiag 依赖）", () => {
    const p = resolve(root, "vendor/frontend/index.html");
    if (!existsSync(p)) return;
    const html = readFileSync(p, "utf8");
    expect(html).toContain('id="usDiagBox"');
    expect(html).toContain('id="usDiagBody"');
  });
});
