import { describe, it, expect, vi, afterEach } from "vitest";
import { withStreamTimeouts } from "../src/services/upstream";

// 流式出站的三段超时守卫。
//
// 为什么必须测：`fetch()` 在**响应头到达时**就 resolve，原实现 `withTimeout` 的
// `finally { clearTimeout }` 紧跟其后把总超时一起清掉——于是配置的 120s 实际只覆盖
// 到首字节，流阶段完全裸奔。上游半途卡住（不发也不关）时请求会永久挂着：用户侧
// "转圈不结束"，Worker 侧一直占着在途名额与出站连接，还持续吃 CPU 额度。
// 这个缺陷在本地跑不出来（只有真机长连才遇得到），只能靠这组用例钉住。

const req = () => new Request("https://x/v2/chat/completions", { method: "POST" });

afterEach(() => vi.unstubAllGlobals());

describe("流式出站超时", () => {
  it("首字节超时：头迟迟不来 → 请求被 abort（而不是无限等）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_r: Request, init: any) =>
        // 永不 resolve，除非 signal 被 abort。
        new Promise((_res, rej) => {
          init.signal.addEventListener("abort", () => rej(new Error("aborted: header timeout")));
        }),
      ),
    );
    await expect(withStreamTimeouts(req(), { totalMs: 10_000, headerMs: 60, idleMs: 0 })).rejects.toThrow(/abort/);
  });

  it("流间空闲超时：已出流后又静默 → 流被 abort", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_r: Request, init: any) => {
        // 头立刻返回，但 body 永不出帧 —— 模拟上游半途挂起。
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            init.signal.addEventListener("abort", () => c.error(new Error("aborted: idle timeout")));
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }),
    );
    const res = await withStreamTimeouts(req(), { totalMs: 10_000, headerMs: 10_000, idleMs: 60 });
    // 头能拿到（首字节守卫不该误杀），但读流最终会失败。
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow(/abort/);
  });

  it("空闲守卫不误杀正常长流：每来一帧就重置计时", async () => {
    const enc = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_r: Request, init: any) => {
        const body = new ReadableStream<Uint8Array>({
          async start(c) {
            // 5 帧、每帧间隔 40ms，累计 200ms —— 远大于 100ms 的 idle 阈值，
            // 只要"逐帧重置"生效就不会被杀。
            for (let i = 0; i < 5; i++) {
              await new Promise((r) => setTimeout(r, 40));
              c.enqueue(enc.encode(`data: {"n":${i}}\n\n`));
            }
            c.close();
          },
        });
        void init;
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }),
    );
    const res = await withStreamTimeouts(req(), { totalMs: 10_000, headerMs: 10_000, idleMs: 100 });
    const text = await res.text();
    expect(text).toContain('"n":4');
  });

  it("总超时覆盖整个流：不只是首字节（原实现在这里被清掉了计时器）", async () => {
    const enc = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_r: Request, init: any) => {
        const body = new ReadableStream<Uint8Array>({
          async start(c) {
            init.signal.addEventListener("abort", () => c.error(new Error("aborted: total timeout")));
            // 每 20ms 出一帧、永不结束：idle 永远不触发（一直在出帧），
            // 只能靠总超时收场 —— 这正是原实现覆盖不到的情形。
            for (let i = 0; ; i++) {
              await new Promise((r) => setTimeout(r, 20));
              c.enqueue(enc.encode(`data: {"n":${i}}\n\n`));
            }
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }),
    );
    const res = await withStreamTimeouts(req(), { totalMs: 120, headerMs: 10_000, idleMs: 10_000 });
    await expect(res.text()).rejects.toThrow(/abort/);
  });

  it("配置为 0/负 → 该段不设限（不误伤显式关闭超时的部署）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })),
    );
    const res = await withStreamTimeouts(req(), { totalMs: 0, headerMs: 0, idleMs: 0 });
    expect(await res.text()).toContain("[DONE]");
  });
});
