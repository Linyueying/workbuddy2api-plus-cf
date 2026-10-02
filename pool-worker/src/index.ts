// 独立 Worker：只负责承载账号池 Durable Object（PoolDO）。
//
// 为什么必须独立部署：Pages 项目的 wrangler.toml **不支持 [[migrations]]**
// （云端构建直接报 "does not support migrations"），而 Durable Object 类
// 没有 migrations 声明就不会被注册——实测删掉该字段后本地 DO 调用即挂起。
// 同时 Pages 云端又强制要求 DO binding 带 `script_name`，指向"定义该 DO 的
// Worker"。两条约束合起来，结论是 Pages 项目无法自带 DO。
//
// 所以 PoolDO 放在这里单独部署，Pages 侧通过
//   [[durable_objects.bindings]] name=POOL, script_name="workbuddy2api-pool"
// 远程引用。Pages 代码不用改：env.POOL 照旧可用（poolRPC / poolStub 不变）。
//
// PoolDO 的依赖很轻：只用 WB2A_CONFIG（KV 读配置）与 WB2A_API_KEY /
// WB2A_DEVICE_TOKEN 两个 Secret，不碰 D1 / R2，所以这个 Worker 的配置很薄。

import { PoolDO } from "../../src/durable/account-pool";

export { PoolDO };

// Workers 要求有 default export。这个 Worker 不直接对外提供 HTTP 服务，
// 所有访问都经 DO 的 RPC（env.POOL.get(id).fetch(...)），所以只回一个说明。
export default {
  async fetch(): Promise<Response> {
    return new Response(
      "workbuddy2api-pool: Durable Object host. No HTTP API here; " +
        "reach the pool via the POOL binding from the Pages project.",
      { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  },
};
