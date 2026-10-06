// isolate 级冷启动观测。
//
// 为什么单独一个文件：冷启动是 **isolate 的属性**，不是请求的属性，而 Hono 的
// Context 是每请求一份、且只能在 app.fetch 内部拿到——index.ts 在 fetch 之前做的
// 那些事（自动迁移）没法往里塞变量。所以这类「本 isolate 只记一次」的状态必须
// 放在模块作用域，由需要它的地方各自来读。
//
// 有什么用：线上报「首 token 慢」时，第一个问题永远是「这是冷启动还是热启动」。
// 没有这个标记就只能靠猜——而冷启动和热启动的优化方向完全不同（前者要砍启动期
// I/O，后者要砍请求路径 I/O）。X-Cold-Start 让 curl 一次就能分辨。

import { now } from "./timing";

/**
 * cold 本 isolate 是否已经处理过请求。
 *
 * 注意「首个请求」在这里的语义：Workers 会并发处理请求，严格意义上只有最早那个
 * 才是冷启动。但并发首发的几个请求**同样**要付 isolate 启动成本（脚本解析、
 * 迁移、连接池建立），把它们标成 warm 反而是丢信息。所以这里取「尚未有任何请求
 * 完成」——即冷启动窗口内的请求都标记为真，直到第一个请求走完才翻假。
 */
let cold = true;

/** isolate 启动时刻。uptime 用它算，给排查「是不是刚起来」提供直接证据。 */
const bootAt = now();

/** isColdStart 是否在冷启动窗口内（读取不改变状态）。 */
export function isColdStart(): boolean {
  return cold;
}

/**
 * markServed 标记「已有请求被服务过」，之后 isColdStart() 恒为 false。
 *
 * 由最外层中间件在 await next() **之前**调用：并发的首批请求会一起看到 true
 * （这正是想要的），而它们之后的请求一律是 false。
 */
export function markServed(): void {
  cold = false;
}

/** uptimeMs 本 isolate 已存活毫秒数。 */
export function uptimeMs(): number {
  return now() - bootAt;
}
